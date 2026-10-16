import { ToolDefinition, ToolPermission, ToolContext, ToolResult } from '@ontofelia/core';

/** What the tool asks the runtime to arm (see agent-runtime `armGoal`). */
export interface ArmGoalPortRequest {
  agentId: string;
  sessionId: string;
  /** The `message-received` episode of the current inbound owner message. */
  mandateEpisodeUri: string;
  goal?: string;
  newGoal?: string;
  priority?: number;
  wakeAt?: string;
  wakeIn?: string;
  every?: string;
}

export type ArmGoalPortResult =
  | {
      ok: true;
      created: boolean;
      label: string;
      goalUri: string;
      wakeAt: string;
      every?: string;
      scheduled: boolean;
      scheduleError?: string;
      activated: boolean;
      initiativeEnabled: boolean;
    }
  | { ok: false; message: string };

/** Implemented by the gateway: runtime goal writes plus InitiativeService scheduling. */
export interface GoalArmer {
  arm(req: ArmGoalPortRequest): Promise<ArmGoalPortResult | undefined>;
}

interface ArmGoalInput {
  goal?: string;
  newGoal?: string;
  priority?: number;
  wakeAt?: string;
  wakeIn?: string;
  every?: string;
}

/**
 * arm_goal — give a goal the owner's mandate and a wake time so that the agent
 * can work on it later (docs/initiative-architecture.md §9). The mandate is the
 * recorded inbound message of the current turn, so it exists only when the owner
 * is talking to the agent right now: the tool refuses non-owners and unattended
 * initiative cycles, and it is not in the initiative allow-list.
 */
export class ArmGoalTool implements ToolDefinition {
  name = 'arm_goal';
  description =
    'Give a goal a wake time so that you work on it later, once or regularly. Use ONLY when ' +
    'the owner explicitly asks you to work on something later or regularly in this very message. ' +
    'Pass an existing open goal ("goal": label or IRI) or a new one ("newGoal": label, optional ' +
    '"priority" 0-1), and either "wakeAt" (ISO-8601 timestamp with time zone) or "wakeIn" ' +
    '(ISO-8601 duration, e.g. PT2H), optionally "every" (recurring ISO-8601 duration, at least ' +
    'PT30M). Owner only.';
  category = 'utility' as const;
  permissions: ToolPermission[] = ['memory:write'];

  inputSchema = {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'Label or IRI of an existing open goal (see list_goals).' },
      newGoal: { type: 'string', description: 'Label of a new goal to create (instead of "goal").' },
      priority: { type: 'number', description: 'Priority 0-1 for a new goal (default 0.6).' },
      wakeAt: { type: 'string', description: 'Absolute wake time, ISO-8601 with time zone.' },
      wakeIn: { type: 'string', description: 'Wake after this ISO-8601 duration, e.g. PT2H or P1D.' },
      every: { type: 'string', description: 'Recurring interval, ISO-8601 duration, minimum PT30M.' },
    },
  };

  constructor(private readonly armer: GoalArmer) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const data = (input ?? {}) as ArmGoalInput;
    const startTime = Date.now();
    const audit = (output: unknown, success: boolean, error?: string) => ({
      toolName: this.name,
      timestamp: new Date().toISOString(),
      duration: Date.now() - startTime,
      input,
      output,
      success,
      ...(error ? { error } : {}),
      permissions: this.permissions,
      agentId: context.agentId,
      sessionId: context.sessionId,
      channelType: context.channelType,
      senderId: context.senderId,
      isOwner: context.isOwner,
    });
    const refuse = (msg: string, error: string): ToolResult => ({
      success: false,
      output: msg,
      error,
      auditEntry: audit(null, false, msg),
    });

    if (!context.isOwner) {
      return refuse(
        'arm_goal is owner-only: only the owner can ask for work to be done later.',
        'arm_goal: caller is not the owner',
      );
    }
    if (context.unattended === true) {
      return refuse(
        'arm_goal cannot be used in an unattended initiative cycle: a goal needs a mandate from ' +
          'the owner in a live conversation.',
        'arm_goal: unattended context',
      );
    }
    if (context.ownerPresent !== true) {
      return refuse(
        'arm_goal needs the owner present in a live conversation; scheduled, webhook and ' +
          'system turns do not count as the owner asking.',
        'arm_goal: owner not present',
      );
    }
    if (!context.inboundEpisodeUri) {
      return refuse(
        'arm_goal needs the record of the owner\'s current message as its mandate, but this turn ' +
          'has none. That record is written only when the cognitive cycle manager is on ' +
          '(setup flag cog.flagCycleManager) and episodic memory is on (setup flag ' +
          'cog.flagEpisodicMemory). Nothing was changed; ' +
          'the flags are not switched on by this tool.',
        'arm_goal: no mandate episode for this turn',
      );
    }

    try {
      const res = await this.armer.arm({
        agentId: context.agentId,
        sessionId: context.sessionId,
        mandateEpisodeUri: context.inboundEpisodeUri,
        goal: str(data.goal),
        newGoal: str(data.newGoal),
        priority: typeof data.priority === 'number' ? data.priority : undefined,
        wakeAt: str(data.wakeAt),
        wakeIn: str(data.wakeIn),
        every: str(data.every),
      });
      if (res === undefined) {
        return refuse('Goals are unavailable (no knowledge engine configured).', 'arm_goal: goals unavailable');
      }
      if (!res.ok) return refuse(res.message, `arm_goal: ${res.message}`);

      const lines = [
        `${res.created ? 'Created and armed' : 'Armed'} goal "${res.label}" (${res.goalUri}).`,
        `Next wake: ${res.wakeAt}${res.every ? `, then every ${res.every}` : ' (once)'}.`,
      ];
      if (res.activated) lines.push('The goal was proposed; it is now active.');
      if (!res.scheduled) {
        lines.push(
          `The wake job could not be scheduled (${res.scheduleError ?? 'unknown error'}); the wake is ` +
            'stored and is picked up at the next gateway start.',
        );
      }
      if (!res.initiativeEnabled) {
        lines.push(
          'Initiative is switched off (flagInitiative): this wake will not fire until the owner runs ' +
            '/initiative on. A wake that comes due while it is off is skipped and is only picked up ' +
            'again at the next gateway start.',
        );
      }
      return {
        success: true,
        output: lines.join('\n'),
        auditEntry: audit({ goalUri: res.goalUri, wakeAt: res.wakeAt, every: res.every, created: res.created }, true),
      };
    } catch (e) {
      const msg = (e as Error).message;
      return { success: false, output: msg, error: msg, auditEntry: audit(null, false, msg) };
    }
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}
