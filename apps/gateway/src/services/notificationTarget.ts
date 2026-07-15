/**
 * Owner delivery-target resolution for proactive notifications
 * (docs/initiative-architecture.md §7; adversarial-review M4).
 *
 * A proactive (initiative) notification reaches the owner out-of-band, so it
 * must go to the OWNER — never to "whoever happens to be first in the telegram
 * allowlist". Silently falling back to `allowlist[0]` can misdeliver private
 * owner updates to an unrelated allowlisted user. This resolver therefore only
 * uses an allowlist entry when it can VERIFY it is the sole allowlisted user;
 * otherwise it returns no target (the caller suppresses with reason 'no-target'
 * and warns that an explicit owner target must be configured).
 */
export interface OwnerTargetInput {
  /** config.notifications.target — explicit override, highest precedence. */
  configuredTarget?: string;
  /** channels.telegram.ownerChatId — the designated owner chat. */
  ownerChatId?: string;
  /** senderIds of the telegram allowlist (DMs: senderId === chatId). */
  allowlistSenderIds: string[];
}

export interface OwnerTargetResult {
  /** The resolved owner target, or undefined when none can be trusted. */
  target?: string;
  /** Why no target was resolved — for a clear one-time operator warning. */
  reason?: 'ambiguous-allowlist' | 'no-allowlist';
}

export function resolveOwnerTarget(input: OwnerTargetInput): OwnerTargetResult {
  if (input.configuredTarget) return { target: input.configuredTarget };
  if (input.ownerChatId) return { target: input.ownerChatId };
  const ids = input.allowlistSenderIds ?? [];
  // ONLY trust the allowlist when there is exactly one entry (the sole
  // allowlisted user is unambiguously the owner). Never guess among several.
  if (ids.length === 1) return { target: ids[0] };
  if (ids.length === 0) return { reason: 'no-allowlist' };
  return { reason: 'ambiguous-allowlist' };
}
