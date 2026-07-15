import { ToolDefinition, ToolPermission, ToolContext, ToolResult } from '@ontofelia/core';

/**
 * Structural dependency on the gateway's NotificationService (agent-runtime)
 * without importing it — the tools package must not depend on agent-runtime.
 * The NotificationService's `deliver` satisfies this shape.
 */
export interface OwnerNotifier {
  deliver(n: {
    message: string;
    priority: 'low' | 'normal' | 'high';
    goalId?: string;
  }): Promise<{ sent: boolean; reason: string; target?: string }>;
}

interface NotifyOwnerInput {
  message: string;
  priority?: 'low' | 'normal' | 'high';
  goalId?: string;
}

/**
 * notify_owner — reach the owner out-of-band (docs/initiative-architecture.md §7).
 *
 * This is the ONE way an unattended initiative cycle can talk to its owner (its
 * cycle output is shown to no one). All delivery policy — daily cap, quiet
 * hours, digest queueing, audit episode — lives in the NotificationService, not
 * here and not in the LLM: this tool only forwards the intent and reports the
 * governed outcome (sent vs suppressed + reason).
 *
 * Conversational use (design §7): in a normal chat the owner is already reading
 * the reply channel, so notify_owner routes through the SAME service but avoids
 * double-sending — when the current sender IS the owner, it no-ops with a note
 * that the direct reply is the channel; otherwise (a non-owner is chatting) it
 * delivers to the owner out-of-band.
 */
export class NotifyOwnerTool implements ToolDefinition {
  name = 'notify_owner';
  description =
    'Send a short notification to your owner out-of-band (e.g. Telegram). Use this ' +
    'in unattended/initiative work to report progress or ask for attention. Delivery ' +
    'is policy-governed (rate limits, quiet hours): the message may be deferred and ' +
    'shown to the owner later. In a normal conversation just answer directly instead.';
  category = 'channel' as const;
  permissions: ToolPermission[] = ['channel:action'];

  inputSchema = {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The notification text for the owner.' },
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        description: 'Delivery priority. high can bypass quiet hours; default normal.',
      },
      goalId: { type: 'string', description: 'Optional IRI of the goal this notification is about.' },
    },
    required: ['message'],
  };

  constructor(private readonly notifier: OwnerNotifier) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const data = (input ?? {}) as NotifyOwnerInput;
    const startTime = Date.now();
    const priority = data.priority ?? 'normal';

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

    if (!data.message || typeof data.message !== 'string' || data.message.trim() === '') {
      const msg = 'notify_owner requires a non-empty "message".';
      return { success: false, output: msg, error: msg, auditEntry: audit(null, false, msg) };
    }

    // Initiative detection uses the authoritative threaded flag, NOT
    // channelType==='system' (the cron path is system/dm too and must NOT be
    // treated as initiative — L1). notify_owner may deliver to the owner ONLY
    // when the caller is (a) an unattended initiative cycle, OR (b) the owner
    // themselves (H2 — a non-owner allowlisted user must never relay text into
    // the owner's channel).
    const isInitiative = context.unattended === true;
    if (!isInitiative) {
      if (context.isOwner) {
        // Owner present in the chat: the reply channel already reaches them, so
        // do not double-send (design §7).
        const out =
          'You are already talking to the owner in this chat — no separate notification ' +
          'was sent. Just include this in your direct reply.';
        return { success: true, output: out, auditEntry: audit({ sent: false, reason: 'owner-in-chat' }, true) };
      }
      // Non-owner conversational caller: refuse. Do NOT deliver, do NOT touch
      // the digest or the daily cap (the service is never called). This closes
      // the owner-harassment / prompt-injection vector (H2).
      const out =
        'notify_owner is only available to the owner or to unattended initiative work; ' +
        'it cannot be used to send messages to the owner on behalf of another user.';
      return { success: false, output: out, error: 'notify_owner: caller is not the owner', auditEntry: audit({ sent: false, reason: 'not-owner' }, false) };
    }

    try {
      const result = await this.notifier.deliver({ message: data.message, priority, goalId: data.goalId });
      const out = result.sent
        ? `Notification sent to the owner (priority ${priority}).`
        : `Notification NOT sent (deferred by policy: ${result.reason}); the owner will see it as a digest on next contact.`;
      return { success: true, output: out, auditEntry: audit({ sent: result.sent, reason: result.reason }, true) };
    } catch (e) {
      const msg = (e as Error).message;
      return { success: false, output: null, error: msg, auditEntry: audit(null, false, msg) };
    }
  }
}
