import { describe, it, expect } from 'vitest';
import { resolveTelegramSender } from '@ontofelia/channels';
import { resolveOwnerTarget } from '../notificationTarget.js';

// A proactive owner notification must never be addressed to a user whom the
// gateway's own identity check treats as a non-owner. The resolver is called
// here as the gateway wires it: the configured target, the owner chat id, the
// configured owner id and the allowlist sender ids are passed in.

const OWNER_ID = '111';

function isOwnerWith(userId: string, ownerId: string | undefined): boolean {
  return resolveTelegramSender(userId, undefined, ownerId)?.isOwner === true;
}

function isOwnerPerGateway(userId: string): boolean {
  return isOwnerWith(userId, OWNER_ID);
}

describe('owner notification target versus the gateway owner check', () => {
  it('control: an allowlist holding only the owner resolves to the owner', () => {
    const res = resolveOwnerTarget({ allowlistSenderIds: ['111'] });
    expect(res.target).toBe('111');
    expect(isOwnerPerGateway(res.target!)).toBe(true);
  });

  it('control: the identity check calls 222 a non-owner when the owner id is 111', () => {
    expect(isOwnerPerGateway('111')).toBe(true);
    expect(isOwnerPerGateway('222')).toBe(false);
  });

  it('never resolves to a user the identity check calls a non-owner', () => {
    const res = resolveOwnerTarget({ ownerId: OWNER_ID, allowlistSenderIds: ['222'] });
    expect(res.target).toBeDefined();
    expect(isOwnerPerGateway(res.target!)).toBe(true);
  });

  it('legacy mode: without an owner id the sole allowlist entry stays the owner', () => {
    const res = resolveOwnerTarget({ allowlistSenderIds: ['222'] });
    expect(res.target).toBe('222');
    expect(isOwnerWith(res.target!, undefined)).toBe(true);
  });

  it('prefers the owner id over the allowlist entries', () => {
    const res = resolveOwnerTarget({ ownerId: OWNER_ID, allowlistSenderIds: ['111', '222'] });
    expect(res.target).toBe('111');
  });

  it('an explicit configured target and owner chat id still win over the owner id', () => {
    expect(
      resolveOwnerTarget({ configuredTarget: '333', ownerChatId: '444', ownerId: OWNER_ID, allowlistSenderIds: [] })
        .target,
    ).toBe('333');
    expect(
      resolveOwnerTarget({ ownerChatId: '444', ownerId: OWNER_ID, allowlistSenderIds: ['222'] }).target,
    ).toBe('444');
  });
});
