import { ToolDefinition, ToolPermission, ToolContext, ToolResult } from '@ontofelia/core';

/** What the tool asks the runtime to update (see agent-runtime `updateGoalStep`). */
export interface UpdateGoalStepPortRequest {
  agentId: string;
  sessionId: string;
  goal: string;
  /** Set in an unattended initiative cycle: the only goal that may change. */
  onlyGoalUri?: string;
  currentStep?: string;
  stepProgress?: string;
  plannedSteps?: string;
  status?: string;
  blockedReason?: string;
}

export type UpdateGoalStepPortResult =
  | { ok: true; goalUri: string; label: string; changed: string[] }
  | { ok: false; message: string };

/** Implemented by the gateway: runtime goal writes. */
export interface GoalStepUpdater {
  update(req: UpdateGoalStepPortRequest): Promise<UpdateGoalStepPortResult | undefined>;
}

interface UpdateGoalStepInput {
  goal?: string;
  currentStep?: string;
  stepProgress?: string;
  plannedSteps?: string;
  status?: string;
  blockedReason?: string;
}

/**
 * update_goal_step — record progress on a goal (docs/initiative-architecture.md
 * §9). It changes the current step, progress marker, plan and status
 * (active, blocked with a reason, resolved) and nothing else: no mandate, wake or
 * priority, no abandoning, no reopening. In an unattended initiative cycle it is
 * confined to the goal that cycle was woken for; in an owner conversation any
 * open goal may be updated; non-owners are refused.
 */
export class UpdateGoalStepTool implements ToolDefinition {
  name = 'update_goal_step';
  description =
    'Record progress on one of your goals. Give "goal" (label or IRI) and any of: "currentStep" ' +
    '(what you do or did next), "stepProgress" (for example "3/8"), "plannedSteps" (your plan as ' +
    'text), "status" (active, blocked with "blockedReason", or resolved). It cannot change a ' +
    'goal\'s mandate, wake time or priority, and cannot reopen a closed goal. In an initiative ' +
    'cycle it only works on the goal you were woken for.';
  category = 'utility' as const;
  permissions: ToolPermission[] = ['memory:write'];

  inputSchema = {
    type: 'object',
    properties: {
      goal: { type: 'string', description: 'Label or IRI of an open goal (see list_goals). Optional in an initiative cycle.' },
      currentStep: { type: 'string', description: 'The current or next step.' },
      stepProgress: { type: 'string', description: 'Progress marker, for example "3/8".' },
      plannedSteps: { type: 'string', description: 'The plan as free text.' },
      status: { type: 'string', enum: ['active', 'blocked', 'resolved'], description: 'New status.' },
      blockedReason: { type: 'string', description: 'Required with status "blocked".' },
    },
  };

  constructor(private readonly updater: GoalStepUpdater) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const data = (input ?? {}) as UpdateGoalStepInput;
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

    let onlyGoalUri: string | undefined;
    if (context.unattended === true) {
      // An initiative cycle: confined to the goal it was woken for.
      if (!context.initiativeGoalUri) {
        return refuse(
          'update_goal_step in an unattended cycle needs the goal the cycle was woken for, but none is known.',
          'update_goal_step: no initiative goal',
        );
      }
      onlyGoalUri = context.initiativeGoalUri;
    } else if (!context.isOwner) {
      return refuse(
        'update_goal_step is owner-only: goal state is internal and is not shared with other users.',
        'update_goal_step: caller is not the owner',
      );
    } else if (context.ownerPresent !== true) {
      return refuse(
        'update_goal_step needs the owner present in a live conversation or an initiative cycle ' +
          'woken for the goal; scheduled, webhook and system turns have neither.',
        'update_goal_step: owner not present',
      );
    }

    const goal = str(data.goal) ?? onlyGoalUri;
    if (!goal) {
      return refuse('Give "goal" (label or IRI of an open goal; see list_goals).', 'update_goal_step: no goal');
    }

    try {
      const res = await this.updater.update({
        agentId: context.agentId,
        sessionId: context.sessionId,
        goal,
        onlyGoalUri,
        currentStep: opt(data.currentStep),
        stepProgress: opt(data.stepProgress),
        plannedSteps: opt(data.plannedSteps),
        status: opt(data.status),
        blockedReason: opt(data.blockedReason),
      });
      if (res === undefined) {
        return refuse('Goals are unavailable (no knowledge engine configured).', 'update_goal_step: goals unavailable');
      }
      if (!res.ok) return refuse(res.message, `update_goal_step: ${res.message}`);
      return {
        success: true,
        output: `Updated goal "${res.label}" (${res.goalUri}): ${res.changed.join(', ')}.`,
        auditEntry: audit({ goalUri: res.goalUri, changed: res.changed }, true),
      };
    } catch (e) {
      const msg = (e as Error).message;
      return { success: false, output: msg, error: msg, auditEntry: audit(null, false, msg) };
    }
  }
}

/** Keep a provided string as is (even blank, so the runtime can refuse it); drop non-strings. */
function opt(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}
