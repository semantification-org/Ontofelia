import { describe, it, expect, vi } from 'vitest';
import { getDefaultConfig } from '@ontofelia/config';
import { PRIMARY_AGENT_ID } from '@ontofelia/core';
import { setupTelegramChannel } from '../telegram.js';

// Guardian buttons and callback identities, driven through the real
// setupTelegramChannel with a fake bot and a fake agent.

const OWNER = '1000001';
const FRIEND = '2000002';
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

async function setup(ownerId: string | undefined) {
  const sent: { text: string; opts?: { reply_markup?: { inline_keyboard: { callback_data: string }[][] } } }[] = [];
  const answers: { id: string; text?: string }[] = [];
  const bot = {
    sendChatAction: () => Promise.resolve(true),
    sendMessage: (_c: string, text: string, opts?: never) => { sent.push({ text, opts }); return Promise.resolve({ message_id: 1 }); },
    editMessageText: () => Promise.resolve(true),
    deleteMessage: () => Promise.resolve(true),
    answerCallbackQuery: (id: string, o?: { text?: string }) => { answers.push({ id, text: o?.text }); return Promise.resolve(true); },
  };
  let messageCb: ((e: unknown) => Promise<void>) | undefined;
  let callbackCb: ((q: unknown) => Promise<void>) | undefined;
  const adapter = {
    getBot: () => bot,
    onMessage: (cb: (e: unknown) => Promise<void>) => { messageCb = cb; },
    onCallbackQuery: (cb: (q: unknown) => Promise<void>) => { callbackCb = cb; },
  };
  let debugCb: ((e: { phase: string; data?: unknown }) => void) | undefined;
  const handled: { sender: { id: string; isOwner: boolean }; text: string }[] = [];
  const resolveGuardianApproval = vi.fn();
  const agent = {
    onDebug: (cb: typeof debugCb) => { debugCb = cb; return () => { debugCb = undefined; }; },
    resolveGuardianApproval,
    handleMessage: async (env: { sender: { id: string; isOwner: boolean }; text: string }) => {
      handled.push({ sender: env.sender, text: env.text });
      if (env.text === 'run something risky') {
        debugCb?.({ phase: 'guardian_confirm', data: { callId: 'call-1', toolName: 'exec', command: 'rm -rf x', channelType: 'telegram', senderId: 'owner' } });
        await tick();
      }
      return { text: 'ok' };
    },
  };
  const config = getDefaultConfig();
  config.channels.telegram = { enabled: true, allowedChats: [], ...(ownerId ? { ownerId } : {}) };
  await setupTelegramChannel(
    config,
    adapter as unknown as Parameters<typeof setupTelegramChannel>[1],
    { isAllowed: async () => true } as unknown as Parameters<typeof setupTelegramChannel>[2],
    new Map([[PRIMARY_AGENT_ID, agent]]) as unknown as Parameters<typeof setupTelegramChannel>[3],
  );
  // Make the agent raise a guardian prompt so a real short token exists.
  await messageCb!({
    id: '1', channel: 'telegram', accountId: 'default', chatType: 'dm', target: OWNER,
    sender: { id: 'owner', channelPrefix: 'telegram', isOwner: true },
    timestamp: new Date().toISOString(), text: 'run something risky', mentions: [], attachments: [],
  });
  const keyboard = sent.find((m) => m.opts?.reply_markup)?.opts?.reply_markup?.inline_keyboard;
  const approveData = keyboard![0][0].callback_data; // g:a:<token>
  const press = (fromId: string, data: string) => callbackCb!({
    id: 'q1', data, from: { id: Number(fromId), first_name: 'X', username: `u${fromId}` },
    message: { chat: { id: Number(fromId) }, message_id: 5 },
  });
  return { approveData, press, resolveGuardianApproval, answers, handled };
}

describe('guardian buttons with channels.telegram.ownerId set', () => {
  it('a non-owner pressing approve changes nothing and is refused', async () => {
    const t = await setup(OWNER);
    expect(t.approveData).toMatch(/^g:a:/);
    await t.press(FRIEND, t.approveData);
    expect(t.resolveGuardianApproval).not.toHaveBeenCalled();
    expect(t.answers.at(-1)?.text).toMatch(/only the owner/i);
    // the pending approval is still there: the owner can still press it
    await t.press(OWNER, t.approveData);
    expect(t.resolveGuardianApproval).toHaveBeenCalledTimes(1);
    expect(t.resolveGuardianApproval).toHaveBeenCalledWith('call-1', true, false);
  });

  it('a non-owner cannot deny or approve-all either', async () => {
    const t = await setup(OWNER);
    const token = t.approveData.split(':')[2];
    await t.press(FRIEND, `g:d:${token}`);
    await t.press(FRIEND, `g:A:${token}`);
    expect(t.resolveGuardianApproval).not.toHaveBeenCalled();
  });

  it('the owner can approve', async () => {
    const t = await setup(OWNER);
    await t.press(OWNER, t.approveData);
    expect(t.resolveGuardianApproval).toHaveBeenCalledWith('call-1', true, false);
  });
});

describe('guardian buttons in legacy mode (no owner id)', () => {
  it('any approved user can press, as before', async () => {
    const t = await setup(undefined);
    await t.press(FRIEND, t.approveData);
    expect(t.resolveGuardianApproval).toHaveBeenCalledTimes(1);
  });
});

describe('other inline buttons carry the resolved identity', () => {
  it('non-owner press: own id, no owner rights; owner press: owner', async () => {
    const t = await setup(OWNER);
    await t.press(FRIEND, '/model');
    await t.press(OWNER, '/model');
    const fromButtons = t.handled.filter((h) => h.text === '/model');
    expect(fromButtons[0].sender).toMatchObject({ id: `telegram:${FRIEND}`, isOwner: false });
    expect(fromButtons[1].sender).toMatchObject({ id: 'owner', isOwner: true });
  });
});
