import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramAdapter } from '../telegram/TelegramAdapter.js';
import type { PairingStore } from '../pairing/PairingStore.js';
import type { AllowlistStore } from '../pairing/AllowlistStore.js';

// Drives the adapter's real inbound handler (no bot, no network) and checks
// what of the message reaches stdout.

const OWNER = '1000001';
const PRIVATE_TEXT = 'my private message text';

async function deliver(): Promise<string[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const pairing = { createRequest: async () => ({ code: 'X' }) } as unknown as PairingStore;
  const allowlist = { isAllowed: async () => true } as unknown as AllowlistStore;
  const adapter = new TelegramAdapter(pairing, allowlist);
  await adapter.initialize({ ownerId: OWNER } as never);
  const seen: unknown[] = [];
  adapter.onMessage(async (e) => { seen.push(e); });
  await adapter.handleMessage({
    message_id: 7, date: 1_700_000_000, text: PRIVATE_TEXT,
    chat: { id: Number(OWNER), type: 'private' },
    from: { id: Number(OWNER), first_name: 'Someone', username: 'someone' },
  } as never);
  // Positive control: the message really went through the handler.
  expect(seen).toHaveLength(1);
  return log.mock.calls.map((args) => args.map(String).join(' '));
}

describe('TelegramAdapter inbound message on stdout', () => {
  const saved = process.env.ONTOFELIA_AGENT_DEBUG;
  afterEach(() => {
    if (saved === undefined) delete process.env.ONTOFELIA_AGENT_DEBUG;
    else process.env.ONTOFELIA_AGENT_DEBUG = saved;
    vi.restoreAllMocks();
  });

  it('prints nothing of the message without ONTOFELIA_AGENT_DEBUG', async () => {
    delete process.env.ONTOFELIA_AGENT_DEBUG;
    const lines = await deliver();
    expect(lines.filter((line) => line.includes(PRIVATE_TEXT) || line.includes('someone'))).toEqual([]);
  });

  it('prints the raw update with ONTOFELIA_AGENT_DEBUG=1', async () => {
    process.env.ONTOFELIA_AGENT_DEBUG = '1';
    const lines = await deliver();
    expect(lines.some((line) => line.startsWith('Incoming Telegram msg:') && line.includes(PRIVATE_TEXT))).toBe(true);
  });
});
