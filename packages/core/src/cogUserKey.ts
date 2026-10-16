/**
 * The user key of the cognitive layer: the value stored as `cogt:forUser` on
 * every episode, working-memory entry, cycle and session goal, and the value
 * a scoped read is checked against.
 *
 * It is the same id that keys the per-user graph `urn:<agent>:user:<id>`: the
 * verified owner is always {@link OWNER_USER_KEY} (the identity the channels
 * assign to the owner), every other sender is `sender.id`. Synthetic envelopes
 * (scheduler, cron trigger, initiative cycle) claim `isOwner`, so system work
 * is recorded under the owner's key.
 */

/** The owner's user key (the identity channels give the verified owner). */
export const OWNER_USER_KEY = 'owner';

/**
 * Explicit "every user" scope of a cognitive read. Only owner/operator code
 * paths may pass it; no user key can equal it (see {@link cogUserKey}).
 */
export const ALL_USERS_SCOPE = 'all';

/** Key of a non-owner sender that has no usable id. */
const ANONYMOUS_USER_KEY = 'anonymous';

/**
 * User key of a sender. A non-owner whose id collides with a reserved value
 * (`owner`, `all`) is prefixed `unverified:` so it can neither read as the
 * owner nor as the all-users scope.
 */
export function cogUserKey(sender: { id?: string; isOwner?: boolean } | undefined): string {
  if (sender?.isOwner === true) return OWNER_USER_KEY;
  const id = typeof sender?.id === 'string' ? sender.id : '';
  if (id === '') return ANONYMOUS_USER_KEY;
  if (id === OWNER_USER_KEY || id === ALL_USERS_SCOPE) return `unverified:${id}`;
  return id;
}
