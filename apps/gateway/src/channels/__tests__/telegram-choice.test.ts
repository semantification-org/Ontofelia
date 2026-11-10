import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import { getDefaultConfig } from '@ontofelia/config';
import { PRIMARY_AGENT_ID } from '@ontofelia/core';
import type { AgentConfig, ChannelBinding, ChannelType, ChatRequest, ChatResponse, ProviderAdapter, StreamEvent, TriplestoreAdapter } from '@ontofelia/core';
import { AgentRuntime, CognitiveConfig } from '@ontofelia/agent-runtime';
import { OxigraphAdapter, KnowledgeEngine, GraphRegistry, EpisodicMemory } from '@ontofelia/semantic-memory';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import { setupTelegramChannel } from '../telegram.js';

// Choice capture through the real setupTelegramChannel and a real AgentRuntime on
// a real in-process store: a keyboard the bot sent is an offer to its recipient,
// the recipient's press is a choice, anyone else's press and every Guardian
// approval press write nothing. The model is never called.

const AGENT = 'ontofelia';
const OWNER = '1000001';
const FRIEND = '2000002';
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const BUTTONS = [{ text: 'A', callbackData: '/model a' }, { text: 'B', callbackData: '/model b' }];

class StubProvider implements ProviderAdapter {
  name = 'stub';
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; }
  async chat(_r: ChatRequest): Promise<ChatResponse> {
    return { id: 'x', content: '', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async *chatStream(r: ChatRequest): AsyncIterable<StreamEvent> { yield { type: 'done', response: await this.chat(r) }; }
}

const agentConfig: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-tgchoice-ws',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
};

describe('telegram choice capture', { timeout: 60_000 }, () => {
  let store: TriplestoreAdapter;
  let runtime: AgentRuntime;
  let cfg: CognitiveConfig;
  let em: EpisodicMemory;
  let dataDir: string;

  beforeEach(async () => {
    const sid = Math.random().toString(36).slice(2);
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `tgchoice-store-${sid}-`));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    const ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    runtime = new AgentRuntime(
      AGENT, agentConfig, new StubProvider(), new SessionStore(await fs.mkdtemp(path.join(os.tmpdir(), `tgchoice-sess-${sid}-`))),
      new ToolRegistry(), new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(`/tmp/tgchoice-ws-${sid}`), new SkillRegistry(),
      new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined, ke, undefined,
    );
    cfg = new CognitiveConfig(store, AGENT);
    em = new EpisodicMemory(store, AGENT);
  });

  afterEach(async () => {
    await runtime.flushCognitiveWrites();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  async function setup() {
    let nextMessageId = 100;
    const sent: { chat: string; id: number; text: string; keyboard?: { callback_data: string }[][] }[] = [];
    const bot = {
      sendChatAction: () => Promise.resolve(true),
      sendMessage: (chat: string, text: string, opts?: { reply_markup?: { inline_keyboard: { callback_data: string }[][] } }) => {
        const id = nextMessageId++;
        sent.push({ chat, id, text, keyboard: opts?.reply_markup?.inline_keyboard });
        return Promise.resolve({ message_id: id });
      },
      editMessageText: () => Promise.resolve(true),
      deleteMessage: () => Promise.resolve(true),
      answerCallbackQuery: () => Promise.resolve(true),
    };
    let messageCb: ((e: unknown) => Promise<void>) | undefined;
    let callbackCb: ((q: unknown) => Promise<void>) | undefined;
    const adapter = {
      getBot: () => bot,
      onMessage: (cb: (e: unknown) => Promise<void>) => { messageCb = cb; },
      onCallbackQuery: (cb: (q: unknown) => Promise<void>) => { callbackCb = cb; },
    };
    let debugCb: ((e: { phase: string; data?: unknown }) => void) | undefined;
    const handled: string[] = [];
    const resolveGuardianApproval = vi.fn();
    const recordChoiceMade = vi.fn((p: Parameters<AgentRuntime['recordChoiceMade']>[0]) => runtime.recordChoiceMade(p));
    const agent = {
      onDebug: (cb: typeof debugCb) => { debugCb = cb; return () => { debugCb = undefined; }; },
      resolveGuardianApproval,
      recordChoiceOffered: (p: Parameters<AgentRuntime['recordChoiceOffered']>[0]) => runtime.recordChoiceOffered(p),
      recordChoiceMade,
      handleMessage: async (env: { text: string }) => {
        handled.push(env.text);
        if (env.text === 'run something risky') {
          debugCb?.({ phase: 'guardian_confirm', data: { callId: 'call-1', toolName: 'exec', command: 'rm -rf x', channelType: 'telegram', senderId: 'owner' } });
          await tick();
          return { text: 'ok', sessionId: 'sess-1' };
        }
        if (env.text === '/model') return { text: 'pick one', sessionId: 'sess-1', inlineButtons: BUTTONS };
        return { text: 'ok', sessionId: 'sess-1' };
      },
    };
    const config = getDefaultConfig();
    config.channels.telegram = { enabled: true, allowedChats: [], ownerId: OWNER };
    await setupTelegramChannel(
      config,
      adapter as unknown as Parameters<typeof setupTelegramChannel>[1],
      { isAllowed: async () => true } as unknown as Parameters<typeof setupTelegramChannel>[2],
      new Map([[PRIMARY_AGENT_ID, agent]]) as unknown as Parameters<typeof setupTelegramChannel>[3],
    );
    const say = (text: string, fromId = OWNER) => messageCb!({
      id: '1', channel: 'telegram', accountId: 'default', chatType: 'dm', target: OWNER,
      sender: fromId === OWNER
        ? { id: 'owner', channelPrefix: 'telegram', isOwner: true }
        : { id: `telegram:${fromId}`, channelPrefix: 'telegram', isOwner: false },
      timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
    });
    const press = (fromId: string, data: string, messageId: number, chat = OWNER) => callbackCb!({
      id: 'q1', data, from: { id: Number(fromId), first_name: 'X', username: `u${fromId}` },
      message: { chat: { id: Number(chat) }, message_id: messageId },
    });
    const keyboardMessage = () => sent.filter((m) => m.keyboard && m.keyboard[0][0].callback_data.startsWith('/model')).at(-1)!;
    return { say, press, keyboardMessage, sent, handled, resolveGuardianApproval, recordChoiceMade };
  }

  const episodes = async (user: string) =>
    (await em.recent(user, 100)).filter((e) => e.episodeType === 'choice-offered' || e.episodeType === 'choice-made');
  const quads = async () => ((await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }')).bindings ?? []).length;

  it('a sent keyboard is an offer to its recipient and the same user\'s press is the choice', async () => {
    await cfg.setEnabled({ name: 'flagEpisodicMemory', key: 'episodicMemory', description: '' }, true);
    const t = await setup();
    await t.say('/model');
    const kb = t.keyboardMessage();
    const offered = await episodes('owner');
    expect(offered.map((e) => e.episodeType)).toEqual(['choice-offered']);
    expect(offered[0].tags).toContain(`offer-ref:telegram:${OWNER}:${kb.id}`);
    expect(offered[0].sessionId).toBe('sess-1');

    await t.press(OWNER, '/model b', kb.id);
    const all = await episodes('owner');
    expect(all.map((e) => e.episodeType).sort()).toEqual(['choice-made', 'choice-offered']);
    expect(all.find((e) => e.episodeType === 'choice-made')!.tags).toEqual(['chosen:/model b']);
    // The press still reaches the agent as before.
    expect(t.handled).toContain('/model b');
  });

  it('a press by another user writes nothing, but is still handled as before', async () => {
    await cfg.setEnabled({ name: 'flagEpisodicMemory', key: 'episodicMemory', description: '' }, true);
    const t = await setup();
    await t.say('/model');
    const kb = t.keyboardMessage();
    const before = await quads();
    await t.press(FRIEND, '/model a', kb.id, OWNER); // the friend taps the owner's keyboard in a shared chat
    expect(t.recordChoiceMade).toHaveBeenCalledTimes(1); // it reached the capture, which refused it
    expect(await quads()).toBe(before);
    expect(await episodes(`telegram:${FRIEND}`)).toEqual([]);
    expect(t.handled).toContain('/model a');
  });

  it('Guardian g: presses write nothing and never reach the capture; the approval prompt is no offer', async () => {
    await cfg.setEnabled({ name: 'flagEpisodicMemory', key: 'episodicMemory', description: '' }, true);
    const t = await setup();
    await t.say('run something risky');
    const prompt = t.sent.find((m) => m.keyboard)!;
    const approve = prompt.keyboard![0][0].callback_data;
    expect(approve).toMatch(/^g:a:/);
    expect(await episodes('owner')).toEqual([]);
    const before = await quads();
    await t.press(OWNER, approve, prompt.id);
    await t.press(OWNER, `g:d:${approve.split(':')[2]}`, prompt.id);
    expect(t.resolveGuardianApproval).toHaveBeenCalled();
    expect(t.recordChoiceMade).not.toHaveBeenCalled();
    expect(await episodes('owner')).toEqual([]);
    expect(await quads()).toBe(before);
  });

  it('with episodic memory off nothing is written', async () => {
    const t = await setup();
    await t.say('/model');
    const kb = t.keyboardMessage();
    const before = await quads();
    await t.press(OWNER, '/model a', kb.id);
    expect(await quads()).toBe(before);
    expect(await episodes('owner')).toEqual([]);
  });
});
