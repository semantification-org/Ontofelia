import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '@ontofelia/config';
import { PRIMARY_AGENT_ID } from '@ontofelia/core';
import { setupTelegramChannel } from '../telegram.js';

// Integration test for the Telegram liveness UX (TG-1 typing + TG-2 live status):
// drive setupTelegramChannel with a fake bot + a fake agent that emits onDebug
// phases, then assert the orchestration: typing pinged, a status message sent,
// updated on a phase, removed at the end, and the final answer delivered.

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function makeFakes() {
  const calls: string[] = [];
  const bot = {
    sendChatAction: (_chat: string, action: string) => { calls.push(`chatAction:${action}`); return Promise.resolve(true); },
    sendMessage: (_chat: string, text: string) => {
      calls.push(`sendMessage:${text.slice(0, 24)}`);
      return Promise.resolve({ message_id: 4242 });
    },
    editMessageText: (text: string) => { calls.push(`edit:${text}`); return Promise.resolve(true); },
    deleteMessage: (_chat: string, id: number) => { calls.push(`delete:${id}`); return Promise.resolve(true); },
    sendPhoto: () => Promise.resolve({ message_id: 1 }),
  };
  let messageCb: ((envelope: unknown) => Promise<void>) | undefined;
  const adapter = {
    getBot: () => bot,
    onMessage: (cb: (envelope: unknown) => Promise<void>) => { messageCb = cb; },
    onCallbackQuery: () => {},
  };
  let debugCb: ((event: { phase: string; data?: unknown }) => void) | undefined;
  const agent = {
    onDebug: (cb: (event: { phase: string; data?: unknown }) => void) => { debugCb = cb; return () => { debugCb = undefined; }; },
    handleMessage: async () => {
      debugCb?.({ phase: 'perception' });
      await tick();
      debugCb?.({ phase: 'kg_context' });
      await tick();
      debugCb?.({ phase: 'tool_call', data: { toolName: 'web_search' } });
      await tick();
      debugCb?.({ phase: 'llm_response' });
      // No usage → sendTelegramResponse skips the "📚 Kontext" prefix, so the
      // delivered message is exactly the answer text.
      return { text: 'Final answer' };
    },
  };
  return { calls, adapter, agent, getMessageCb: () => messageCb };
}

describe('Telegram liveness UX (setupTelegramChannel)', () => {
  it('pings typing, shows a status message, updates it, removes it, then sends the answer', async () => {
    const { calls, adapter, agent, getMessageCb } = makeFakes();
    const config = getDefaultConfig();
    const agents = new Map([[PRIMARY_AGENT_ID, agent]]);

    await setupTelegramChannel(
      config,
      adapter as unknown as Parameters<typeof setupTelegramChannel>[1],
      { isAllowed: async () => true } as unknown as Parameters<typeof setupTelegramChannel>[2],
      agents as unknown as Parameters<typeof setupTelegramChannel>[3],
    );

    const cb = getMessageCb();
    expect(cb).toBeDefined();
    await cb!({
      id: '1', channel: 'telegram', accountId: 'a', chatType: 'dm',
      sender: { id: 'chat123', channelPrefix: 'telegram', isOwner: true },
      timestamp: new Date().toISOString(), text: 'hi', mentions: [], attachments: [],
    });

    // TG-1: typing indicator fired.
    expect(calls.some((c) => c === 'chatAction:typing')).toBe(true);
    // TG-3: an initial status message (the checklist header) was sent...
    expect(calls.some((c) => c.startsWith('sendMessage:🧠'))).toBe(true);
    // ...updated to a checklist with a marked step (the cognitive Perception
    // phase reaches the status)...
    expect(calls.some((c) => c.startsWith('edit:') && /[⏳✓]/.test(c) && c.includes('Perception'))).toBe(true);
    // ...and removed before the final answer.
    const deleteIdx = calls.findIndex((c) => c === 'delete:4242');
    const answerIdx = calls.findIndex((c) => c.startsWith('sendMessage:Final answer'));
    expect(deleteIdx).toBeGreaterThanOrEqual(0);
    expect(answerIdx).toBeGreaterThanOrEqual(0);
    expect(deleteIdx).toBeLessThan(answerIdx);
  });

  it('cleans up (removes status, sends error) when handleMessage throws', async () => {
    const { calls, adapter, getMessageCb } = makeFakes();
    // Override the agent to throw mid-processing after showing progress.
    let debugCb: ((e: { phase: string; data?: unknown }) => void) | undefined;
    const throwingAgent = {
      onDebug: (cb: (e: { phase: string; data?: unknown }) => void) => { debugCb = cb; return () => { debugCb = undefined; }; },
      handleMessage: async () => {
        debugCb?.({ phase: 'kg_context' });
        await tick();
        throw new Error('boom');
      },
    };
    const config = getDefaultConfig();
    const agents = new Map([[PRIMARY_AGENT_ID, throwingAgent]]);

    await setupTelegramChannel(
      config,
      adapter as unknown as Parameters<typeof setupTelegramChannel>[1],
      { isAllowed: async () => true } as unknown as Parameters<typeof setupTelegramChannel>[2],
      agents as unknown as Parameters<typeof setupTelegramChannel>[3],
    );

    await getMessageCb()!({
      id: '1', channel: 'telegram', accountId: 'a', chatType: 'dm',
      sender: { id: 'chat123', channelPrefix: 'telegram', isOwner: true },
      timestamp: new Date().toISOString(), text: 'hi', mentions: [], attachments: [],
    });

    // Status message was created and then removed (no orphan), and an error
    // message was delivered to the chat.
    expect(calls.some((c) => c === 'delete:4242')).toBe(true);
    expect(calls.some((c) => c.startsWith('sendMessage:⚠️ Error'))).toBe(true);
  });

  it('does not send a status message when showProgress is disabled', async () => {
    const { calls, adapter, agent, getMessageCb } = makeFakes();
    const config = getDefaultConfig();
    config.channels.telegram = { enabled: true, allowedChats: [], showProgress: false } as typeof config.channels.telegram;
    const agents = new Map([[PRIMARY_AGENT_ID, agent]]);

    await setupTelegramChannel(
      config,
      adapter as unknown as Parameters<typeof setupTelegramChannel>[1],
      { isAllowed: async () => true } as unknown as Parameters<typeof setupTelegramChannel>[2],
      agents as unknown as Parameters<typeof setupTelegramChannel>[3],
    );

    await getMessageCb()!({
      id: '1', channel: 'telegram', accountId: 'a', chatType: 'dm',
      sender: { id: 'chat123', channelPrefix: 'telegram', isOwner: true },
      timestamp: new Date().toISOString(), text: 'hi', mentions: [], attachments: [],
    });

    // Typing still fires (always-on), but no checklist status message and no edits.
    expect(calls.some((c) => c === 'chatAction:typing')).toBe(true);
    expect(calls.some((c) => c.startsWith('sendMessage:🧠'))).toBe(false);
    expect(calls.some((c) => c.startsWith('edit:'))).toBe(false);
    expect(calls.some((c) => c.startsWith('sendMessage:Final answer'))).toBe(true);
  });
});
