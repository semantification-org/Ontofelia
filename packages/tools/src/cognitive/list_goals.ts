import { ToolDefinition, ToolPermission, ToolContext, ToolResult } from '@ontofelia/core';

/**
 * Compact, grounded summary of one open goal. Produced by the runtime's single
 * `summarizeGoal` function so the `/goals` command and the `list_goals` tool
 * render the same facts.
 */
export interface GoalSummary {
  label: string;
  status: 'proposed' | 'active' | 'blocked' | 'resolved' | 'abandoned';
  priority: number;
  /** First planned step not yet done; falls back to the current step. */
  nextAction: string | null;
  /** Absolute time of the next scheduled wake (ISO-8601), if any. */
  nextWake: string | null;
  /** Set only when the goal is active and `nextWake` lies in the future. */
  waitingUntil: string | null;
  blockedReason: string | null;
  deadline: string | null;
}

/** Where the tool reads goals from; implemented by the agent runtime. */
export interface GoalReportSource {
  /** Open goals (not resolved/abandoned) in display order, or undefined when goals are unavailable. */
  openGoals(context: { agentId: string; sessionId: string }): Promise<GoalSummary[] | undefined>;
}

/**
 * list_goals — read-only, grounded view of the agent's own open goals. Goal
 * state is internal, so the tool answers the owner only.
 */
export class ListGoalsTool implements ToolDefinition {
  name = 'list_goals';
  description =
    'List your own open goals (proposed, active, blocked) with status, next action, next wake ' +
    'and blocked reason. Use this ALWAYS when asked what you are planning or working on, and ' +
    'answer only from the result. Owner only; read-only.';
  category = 'utility' as const;
  permissions: ToolPermission[] = ['memory:read'];

  inputSchema = {
    type: 'object',
    properties: {},
  };

  constructor(private readonly source: GoalReportSource) {}

  async execute(_input: unknown, context: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const audit = (output: unknown, success: boolean, error?: string) => ({
      toolName: this.name,
      timestamp: new Date().toISOString(),
      duration: Date.now() - startTime,
      input: {},
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

    if (!context.isOwner) {
      const msg =
        'list_goals is owner-only: goal state is internal and is not shared with other users.';
      return { success: false, output: msg, error: 'list_goals: caller is not the owner', auditEntry: audit(null, false, msg) };
    }

    try {
      const goals = await this.source.openGoals({ agentId: context.agentId, sessionId: context.sessionId });
      if (goals === undefined) {
        const msg = 'Goals are unavailable (no knowledge engine configured).';
        return { success: false, output: msg, error: msg, auditEntry: audit(null, false, msg) };
      }
      const payload =
        goals.length === 0
          ? { count: 0, goals: [], note: 'No open goals.' }
          : { count: goals.length, goals };
      return { success: true, output: JSON.stringify(payload), auditEntry: audit({ count: goals.length }, true) };
    } catch (e) {
      const msg = (e as Error).message;
      return { success: false, output: null, error: msg, auditEntry: audit(null, false, msg) };
    }
  }
}
