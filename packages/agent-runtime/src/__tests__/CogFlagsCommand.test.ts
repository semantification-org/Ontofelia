import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
import { CognitiveConfig, COGNITIVE_FLAGS } from '../cognitive/CognitiveConfig.js';
import type {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, MessageEnvelope, TriplestoreAdapter,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import {
  OxigraphAdapter, KnowledgeEngine, GraphRegistry, GraphUriResolver, EpisodicMemory,
} from '@ontofelia/semantic-memory';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

// `/cog flags` and `/cog flag <name> on|off` are the owner's control surface for
// every cognitive flag. Same gate as the other state-changing /cog commands:
// owner AND a live human turn.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';

const mockConfig: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-cogflags-ws',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
};

class StubProvider implements ProviderAdapter {
  name = 'stub';
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; }
  async chat(_r: ChatRequest): Promise<ChatResponse> {
    return { id: 'x', content: 'a reply', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async *chatStream(r: ChatRequest): AsyncIterable<StreamEvent> { yield { type: 'done', response: await this.chat(r) }; }
}

const env = (text: string, over: Partial<MessageEnvelope> & { sender?: MessageEnvelope['sender'] } = {}): MessageEnvelope => ({
  id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender: { id: 'u1', channelPrefix: 'webchat', isOwner: true },
  timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
  ...over,
} as MessageEnvelope);

const stranger = { id: 'stranger', channelPrefix: 'webchat', isOwner: false };
const schedulerEnv = (text: string) => env(text, {
  channel: 'cron' as ChannelType, chatType: 'cron' as MessageEnvelope['chatType'],
  sender: { id: 'scheduler', channelPrefix: 'cron', isOwner: true },
});

describe('/cog flags and /cog flag <name> on|off', () => {
  let store: TriplestoreAdapter;
  let runtime: AgentRuntime;
  let cfg: CognitiveConfig;
  let dataDir: string;

  const allValues = async () =>
    Object.fromEntries(await Promise.all(COGNITIVE_FLAGS.map(async (f) => [f.name, await cfg.isEnabled(f)])));
  const countTyped = async (graph: string, type: string) =>
    ((await store.query(`SELECT ?s WHERE { GRAPH <${graph}> { ?s a <${type}> } }`)).bindings ?? []).length;
  const countCycleResources = async (type: string) =>
    ((await store.query(`SELECT ?s WHERE { GRAPH ?g { ?s a <${type}> } }`)).bindings ?? []).length;
  const episodeCount = () => countTyped(GraphUriResolver.getCogEpisodicGraph(AGENT), `${COGT}Episode`);

  beforeEach(async () => {
    const sid = Math.random().toString(36).slice(2);
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `cogflags-store-${sid}-`));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    const ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    const sessionStore = new SessionStore(await fs.mkdtemp(path.join(os.tmpdir(), `cogflags-sess-${sid}-`)));
    runtime = new AgentRuntime(
      AGENT, mockConfig, new StubProvider(), sessionStore,
      new ToolRegistry(), new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(`/tmp/cogflags-ws-${sid}`), new SkillRegistry(),
      new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined, ke, undefined,
    );
    cfg = new CognitiveConfig(store, AGENT);
  });

  afterEach(async () => {
    await runtime.flushCognitiveWrites();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('knows exactly thirteen flags and all of them default to off', async () => {
    expect(COGNITIVE_FLAGS).toHaveLength(13);
    expect(Object.values(await allValues()).every((v) => v === false)).toBe(true);
  });

  it('a non-owner is refused and nothing changes', async () => {
    const before = await allValues();
    for (const text of ['/cog flags', '/cog flag goalstack on', '/cog flag flagInitiative on']) {
      const res = await runtime.handleMessage(env(text, { sender: stranger }));
      expect(res.text).toContain('owner-only');
    }
    expect(await allValues()).toEqual(before);
  });

  it('a scheduler/synthetic owner envelope is refused and nothing changes', async () => {
    const before = await allValues();
    for (const text of ['/cog flags', '/cog flag goalstack on', '/cog flag flagInitiative on']) {
      const res = await runtime.handleMessage(schedulerEnv(text));
      expect(res.text).toContain('live owner turn');
    }
    expect(await allValues()).toEqual(before);
  });

  it('/cog flags lists every flag with value and a description', async () => {
    await cfg.setGoalStackEnabled(true);
    const res = await runtime.handleMessage(env('/cog flags'));
    for (const f of COGNITIVE_FLAGS) {
      expect(res.text).toContain(f.name);
      expect(res.text).toContain(f.description);
    }
    expect(res.text).toMatch(/flagGoalStack[^\n]*: on /);
    expect(res.text).toMatch(/flagCycleManager[^\n]*: off /);
  });

  for (const f of COGNITIVE_FLAGS) {
    it(`flag ${f.name} round-trips on and off and is read back by CognitiveConfig`, async () => {
      const others = async () => Object.entries(await allValues()).filter(([n]) => n !== f.name);
      const on = await runtime.handleMessage(env(`/cog flag ${f.name} on`));
      expect(on.text).toContain(`${f.name} = true`);
      expect(await cfg.isEnabled(f)).toBe(true);
      expect((await others()).every(([, v]) => v === false)).toBe(true);
      const off = await runtime.handleMessage(env(`/cog flag ${f.name} off`));
      expect(off.text).toContain(`${f.name} = false`);
      expect(await cfg.isEnabled(f)).toBe(false);
    });
  }

  it('short forms work, case-insensitively', async () => {
    await runtime.handleMessage(env('/cog flag goalstack on'));
    expect(await cfg.isGoalStackEnabled()).toBe(true);
    await runtime.handleMessage(env('/cog flag EpisodicMemory on'));
    expect(await cfg.isEpisodicMemoryEnabled()).toBe(true);
    await runtime.handleMessage(env('/cog flag FLAGDEBUGPANEL on'));
    expect(await cfg.isDebugPanelEnabled()).toBe(true);
    await runtime.handleMessage(env('/cog flag Goalstack off'));
    expect(await cfg.isGoalStackEnabled()).toBe(false);
  });

  it('an unknown name or bad value is refused, lists the valid names, and writes nothing', async () => {
    const before = await allValues();
    for (const text of ['/cog flag nonsense on', '/cog flag goalstack maybe', '/cog flag goalstack', '/cog flag']) {
      const res = await runtime.handleMessage(env(text));
      expect(res.text).toContain('Nothing was changed');
      for (const f of COGNITIVE_FLAGS) expect(res.text).toContain(f.name);
    }
    expect(await allValues()).toEqual(before);
  });

  it('/cog health shows all twelve flags and follows the commands', async () => {
    const read = async () => {
      const text = (await runtime.handleMessage(env('/cog health'))).text;
      return JSON.parse(text.replace(/^```json\n/, '').replace(/\n```$/, '')) as { flags: Record<string, boolean> };
    };
    const first = await read();
    expect(Object.keys(first.flags)).toHaveLength(13);
    expect(Object.keys(first.flags).sort()).toEqual(COGNITIVE_FLAGS.map((f) => f.key).sort());
    expect(Object.values(first.flags).every((v) => v === false)).toBe(true);
    await runtime.handleMessage(env('/cog flag episodicmemory on'));
    expect((await read()).flags.episodicMemory).toBe(true);
    await runtime.handleMessage(env('/cog flag episodicrecall on'));
    const after = await read();
    expect(after.flags.episodicRecall).toBe(true);
    expect(after.flags.episodicMemory).toBe(true);
  });

  it('/help mentions both commands for the owner', async () => {
    const text = (await runtime.handleMessage(env('/help'))).text;
    expect(text).toContain('/cog flags');
    expect(text).toContain('/cog flag <name> on|off');
  });

  it('/cog cycle on sets only the cycle flag and points to the episodic flag', async () => {
    const res = await runtime.handleMessage(env('/cog cycle on'));
    expect(res.text).toContain('/cog flag episodicmemory on');
    const v = await allValues();
    expect(v.flagCycleManager).toBe(true);
    expect(Object.entries(v).filter(([n, x]) => n !== 'flagCycleManager' && x)).toEqual([]);
  });

  it('cycle on + episodic off writes cycle, working memory and marker but zero episodes', async () => {
    await runtime.handleMessage(env('/cog cycle on'));
    const res = await runtime.handleMessage(env('hello there'));
    expect(res.text).toBe('a reply');
    await runtime.flushCognitiveWrites(); // records are queued off the reply path
    expect(await episodeCount()).toBe(0);
    expect(await countCycleResources(`${COGT}Cycle`)).toBe(1);
    expect(await countCycleResources(`${COGT}WorkingMemoryEntry`)).toBeGreaterThan(0);
    expect(await countTyped(GraphUriResolver.getCogMetaGraph(AGENT), `${COGT}ReflectiveMarker`)).toBe(1);
  });

  it('cycle on + episodic on writes episodes as before', async () => {
    await runtime.handleMessage(env('/cog cycle on'));
    await runtime.handleMessage(env('/cog flag episodicmemory on'));
    await runtime.handleMessage(env('hello there'));
    await runtime.flushCognitiveWrites();
    expect(await episodeCount()).toBeGreaterThanOrEqual(2); // message-received + response-sent
    expect(await countCycleResources(`${COGT}Cycle`)).toBe(1);
    expect(await countTyped(GraphUriResolver.getCogMetaGraph(AGENT), `${COGT}ReflectiveMarker`)).toBe(1);
  });

  it('arm_goal refuses naming flagEpisodicMemory while it is off, writes nothing, and works once it is on', async () => {
    await runtime.handleMessage(env('/cog cycle on'));
    const mandate = await new EpisodicMemory(store, AGENT).append({
      episodeType: 'message-received',
      sessionId: 'sess-1',
      actor: 'urn:entity:agent-sender:u1',
      actorIsOwner: true,
      payload: 'please remind me tomorrow',
    });
    const req = { sessionId: 'sess-1', mandateEpisodeUri: mandate, newGoal: 'Remind', wakeIn: 'PT2H' };
    let scheduled = 0;
    const register = async () => { scheduled++; };

    const refused = await runtime.armGoal(req, register);
    expect(refused?.ok).toBe(false);
    expect(refused && !refused.ok ? refused.message : '').toContain('flagEpisodicMemory');
    expect((await runtime.goalsForCommand('sess-1')) ?? []).toHaveLength(0);
    expect(scheduled).toBe(0);

    await runtime.handleMessage(env('/cog flag episodicmemory on'));
    const armed = await runtime.armGoal(req, register);
    expect(armed?.ok).toBe(true);
    expect(scheduled).toBe(1);
  });
});
