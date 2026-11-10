import { describe, it, expect } from 'vitest';
import { getDefaultConfig } from '@ontofelia/config';
import { PRIMARY_AGENT_ID } from '@ontofelia/core';
import { setupTelegramChannel } from '../telegram.js';

type DebugEvent = { phase: string; data?: unknown };
type DebugCb = (event: DebugEvent) => void;

const CANARY = 'OWNER_PRIVATE_CANARY';
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function makeEnvelope(senderId: string, isOwner: boolean, id: string) {
  return {
    id, channel: 'telegram', accountId: 'a', chatType: 'dm',
    sender: { id: senderId, channelPrefix: 'telegram', isOwner },
    timestamp: new Date().toISOString(), text: 'hi', mentions: [], attachments: [],
  };
}

function makeHarness() {
  const sent: { chat: string; text: string }[] = [];
  const bot = {
    sendChatAction: () => Promise.resolve(true),
    sendMessage: (chat: string, text: string) => {
      sent.push({ chat: String(chat), text });
      return Promise.resolve({ message_id: 1 });
    },
    editMessageText: () => Promise.resolve(true),
    deleteMessage: () => Promise.resolve(true),
  };
  let messageCb: ((envelope: unknown) => Promise<void>) | undefined;
  const adapter = {
    getBot: () => bot,
    onMessage: (cb: (envelope: unknown) => Promise<void>) => { messageCb = cb; },
    onCallbackQuery: () => {},
  };
  // Broadcast semantics, like the real runtime: every registered listener
  // receives every event.
  const listeners = new Set<DebugCb>();
  const emit = (event: DebugEvent) => { for (const l of [...listeners]) l(event); };
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => { release = r; });
  const agent = {
    onDebug: (cb: DebugCb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    // Conversations whose sender id starts with "wait-" stay in flight until released.
    handleMessage: async (env: { sender: { id: string } }) => {
      if (env.sender.id.startsWith('wait-')) await gate;
      return { text: 'done' };
    },
  };
  return { sent, adapter, agent, emit, release: () => release?.(), getMessageCb: () => messageCb };
}

async function setup(h: ReturnType<typeof makeHarness>) {
  const config = getDefaultConfig();
  const agents = new Map([[PRIMARY_AGENT_ID, h.agent]]);
  await setupTelegramChannel(
    config,
    h.adapter as unknown as Parameters<typeof setupTelegramChannel>[1],
    { isAllowed: async () => true } as unknown as Parameters<typeof setupTelegramChannel>[2],
    agents as unknown as Parameters<typeof setupTelegramChannel>[3],
  );
}

describe('guardian request isolation between overlapping conversations', () => {
  type Origin = { channelType?: string; senderId?: string };
  async function runOverlap(origin: Origin) {
    const h = makeHarness();
    await setup(h);
    const cb = h.getMessageCb()!;
    const ownerRun = cb(makeEnvelope('wait-owner', true, 'm1'));
    const otherRun = cb(makeEnvelope('wait-other', false, 'm2'));
    await tick();
    h.emit({
      phase: 'guardian_confirm',
      data: { callId: 'call-1', toolName: 'shell', command: `cat ${CANARY}`, ...origin },
    });
    await tick();
    h.release();
    await Promise.all([ownerRun, otherRun]);
    return h;
  }
  const textsIn = (h: ReturnType<typeof makeHarness>, chat: string) =>
    h.sent.filter((m) => m.chat === chat).map((m) => m.text);

  it('control: the owner chat receives its own guardian request', async () => {
    const h = await runOverlap({ channelType: 'telegram', senderId: 'wait-owner' });
    expect(textsIn(h, 'wait-owner').some((t) => t.includes(CANARY))).toBe(true);
  });

  it('does not show the owner guardian request in another conversation', async () => {
    const h = await runOverlap({ channelType: 'telegram', senderId: 'wait-owner' });
    expect(textsIn(h, 'wait-other').some((t) => t.includes(CANARY))).toBe(false);
  });

  it("shows the other conversation's own request only in that conversation", async () => {
    const h = await runOverlap({ channelType: 'telegram', senderId: 'wait-other' });
    expect(textsIn(h, 'wait-other').some((t) => t.includes(CANARY))).toBe(true);
    expect(textsIn(h, 'wait-owner').some((t) => t.includes(CANARY))).toBe(false);
  });

  it('shows an untagged guardian event in no conversation', async () => {
    const h = await runOverlap({});
    expect(h.sent.some((m) => m.text.includes(CANARY))).toBe(false);
  });

  it('shows a request tagged with another channel in no Telegram chat', async () => {
    const h = await runOverlap({ channelType: 'webchat', senderId: 'wait-owner' });
    expect(h.sent.some((m) => m.text.includes(CANARY))).toBe(false);
  });
});
