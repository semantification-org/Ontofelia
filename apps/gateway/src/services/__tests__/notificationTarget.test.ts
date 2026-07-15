import { describe, it, expect } from 'vitest';
import { resolveOwnerTarget } from '../notificationTarget.js';

describe('resolveOwnerTarget (M4)', () => {
  it('prefers the explicit configured target above all', () => {
    expect(
      resolveOwnerTarget({
        configuredTarget: 'explicit',
        ownerChatId: 'owner',
        allowlistSenderIds: ['a', 'b'],
      }),
    ).toEqual({ target: 'explicit' });
  });

  it('falls back to the designated ownerChatId', () => {
    expect(
      resolveOwnerTarget({ ownerChatId: 'owner', allowlistSenderIds: ['a', 'b'] }),
    ).toEqual({ target: 'owner' });
  });

  it('uses the sole allowlisted user when it is unambiguous', () => {
    expect(resolveOwnerTarget({ allowlistSenderIds: ['only'] })).toEqual({ target: 'only' });
  });

  it('does NOT guess among multiple allowlisted users (no misdelivery)', () => {
    const res = resolveOwnerTarget({ allowlistSenderIds: ['a', 'b', 'c'] });
    expect(res.target).toBeUndefined();
    expect(res.reason).toBe('ambiguous-allowlist');
  });

  it('returns no target when nothing is configured and no user is allowlisted', () => {
    const res = resolveOwnerTarget({ allowlistSenderIds: [] });
    expect(res.target).toBeUndefined();
    expect(res.reason).toBe('no-allowlist');
  });
});
