import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime, type StreamChunk } from '../index.js';
import { CycleManager } from '../cognitive/CycleManager.js';
import { CognitiveConfig } from '../cognitive/CognitiveConfig.js';
import type {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, MessageEnvelope, TriplestoreAdapter,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog, ArmGoalTool } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import { OxigraphAdapter, KnowledgeEngine, GraphRegistry } from '@ontofelia/semantic-memory';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

// Streamed turns join the cognitive cycle: with the cycle manager on, one
// streamed turn is one cycle with an inbound and a response episode, the chunks
// the consumer receives are unchanged, an aborted stream records an aborted
// cycle, and with the flag off nothing cognitive is written.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const OWNER = { id: 'owner', channelPrefix: 'webchat', isOwner: true };

const envelope = (text = 'tell me about the garden plan'): MessageEnvelope => ({
  id: 'm1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender: OWNER, timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
} as MessageEnvelope);

const USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** A mock provider: scripted stream rounds, no network. Records the stream requests. */
class ScriptedProvider implements ProviderAdapter {
  name = 'stub';
  requests: ChatRequest[] = [];
  private round = 0;
  constructor(private readonly rounds: StreamEvent[][]) {}
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; }
  async chat(_r: ChatRequest): Promise<ChatResponse> {
    return { id: 'x', content: '', finishReason: 'stop', toolCalls: [], usage: USAGE };
  }
  async *chatStream(r: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(JSON.parse(JSON.stringify(r)));
    const events = this.rounds[Math.min(this.round++, this.rounds.length - 1)];
    for (const e of events) yield e;
  }
}

const textRound = (...parts: string[]): StreamEvent[] => [
  ...parts.map((content) => ({ type: 'text_delta', content }) as StreamEvent),
  { type: 'done', response: { id: 'r', content: parts.join(''), finishReason: 'stop', toolCalls: [], usage: USAGE } },
];
const toolRound = (name: string, args: object): StreamEvent[] => [
  { type: 'done', response: { id: 't', content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'tc1', name, arguments: JSON.stringify(args) }], usage: USAGE } },
];

const config: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-streamcycle-ws',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' }, enabledTools: ['arm_goal'], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
};

const strip = (chunks: StreamChunk[]) =>
  chunks.map((c) => JSON.parse(JSON.stringify(c, (k, v) => (k === 'sessionId' ? '<sid>' : v))));

const rows = async (store: TriplestoreAdapter, q: string) => (await store.query(q)).bindings ?? [];
const count = async (store: TriplestoreAdapter, type: string) =>
  (await rows(store, `SELECT ?s WHERE { GRAPH ?g { ?s a <${type}> } }`)).length;
const cogTypes = ['Episode', 'WorkingMemoryEntry', 'Cycle', 'Goal', 'ReflectiveMarker', 'SkillTrace'].map((t) => `${COGT}${t}`);

describe('streamed turns and the cognitive cycle', () => {
  let store: TriplestoreAdapter;
  let dir: string;
  let sessDir: string;
  let cfg: CognitiveConfig;
  let toolRegistry: ToolRegistry;
  let armRequests: unknown[];
  let armResults: unknown[];

  async function makeRuntime(provider: ProviderAdapter): Promise<AgentRuntime> {
    const ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    const sid = Math.random().toString(36).slice(2);
    toolRegistry = new ToolRegistry();
    const runtime = new AgentRuntime(
      AGENT, config, provider, new SessionStore(sessDir),
      toolRegistry, new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(`/tmp/streamcycle-ws-${sid}`), new SkillRegistry(),
      new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined, ke, undefined,
    );
    toolRegistry.register(new ArmGoalTool({
      arm: async (req) => {
        armRequests.push(req);
        const res = await runtime.armGoal(req, async () => {});
        armResults.push(res);
        return res;
      },
    }));
    return runtime;
  }

  async function drain(runtime: AgentRuntime, env = envelope()): Promise<StreamChunk[]> {
    const out: StreamChunk[] = [];
    for await (const c of runtime.handleMessageStream(env)) out.push(c);
    await (runtime as unknown as { cycleManager?: CycleManager }).cycleManager?.flushPending();
    return out;
  }

  async function freshStore() {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamcycle-store-'));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
    cfg = new CognitiveConfig(store, AGENT);
  }

  beforeEach(async () => {
    sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'streamcycle-sess-'));
    toolRegistry = new ToolRegistry();
    armRequests = [];
    armResults = [];
    await freshStore();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(sessDir, { recursive: true, force: true }).catch(() => {});
  });

  it('cycle manager on: one cycle, one inbound and one response episode carrying the sender key; chunks identical to cycle manager off', async () => {
    const off = await drain(await makeRuntime(new ScriptedProvider([textRound('The garden ', 'plan is ', 'ready.')])));
    for (const type of cogTypes) expect(await count(store, type)).toBe(0);

    await fs.rm(dir, { recursive: true, force: true });
    await freshStore();
    await cfg.setCycleManagerEnabled(true);
    await cfg.setEpisodicMemoryEnabled(true);
    const on = await drain(await makeRuntime(new ScriptedProvider([textRound('The garden ', 'plan is ', 'ready.')])));

    expect(strip(on)).toEqual(strip(off));
    expect(on.map((c) => c.type)).toEqual(['stream_start', 'text_delta', 'text_delta', 'text_delta', 'stream_end']);
    expect(await count(store, `${COGT}Cycle`)).toBe(1);
    const eps = await rows(store, `SELECT ?t ?u ?p WHERE { GRAPH ?g { ?e a <${COGT}Episode> ; <${COGT}episodeType> ?t ; <${COGT}forUser> ?u . OPTIONAL { ?e <${COGT}payload> ?p } } }`);
    const byType = (t: string) => eps.filter((r) => r.t.value === t);
    expect(byType('message-received')).toHaveLength(1);
    expect(byType('response-sent')).toHaveLength(1);
    expect(byType('message-received')[0].u.value).toBe('owner');
    expect(byType('response-sent')[0].u.value).toBe('owner');
    expect(byType('response-sent')[0].p?.value).toContain('The garden plan is ready.');
    const status = await rows(store, `SELECT ?s WHERE { GRAPH ?g { ?c a <${COGT}Cycle> ; <${COGT}cycleStatus> ?s } }`);
    expect(status.map((r) => r.s.value)).toEqual(['completed']);
  });

  it('records the tool events of a streamed turn', async () => {
    await cfg.setCycleManagerEnabled(true);
    await cfg.setEpisodicMemoryEnabled(true);
    const rt = await makeRuntime(new ScriptedProvider([toolRound('arm_goal', { newGoal: 'x', wakeIn: 'PT2H' }), textRound('done')]));
    await drain(rt);
    const types = (await rows(store, `SELECT ?t WHERE { GRAPH ?g { ?e a <${COGT}Episode> ; <${COGT}episodeType> ?t } }`)).map((r) => r.t.value);
    expect(types.filter((t) => t === 'tool-called')).toHaveLength(1);
    expect(types.filter((t) => t === 'tool-completed')).toHaveLength(1);
  });

  it('cycle manager off: zero cognitive writes, even with the other flags on', async () => {
    await cfg.setEpisodicMemoryEnabled(true);
    await cfg.setGoalStackEnabled(true);
    const chunks = await drain(await makeRuntime(new ScriptedProvider([textRound('plain ', 'answer')])));
    expect(chunks.map((c) => c.type)).toEqual(['stream_start', 'text_delta', 'text_delta', 'stream_end']);
    expect(chunks.filter((c) => c.type === 'text_delta').map((c) => (c as { content: string }).content)).toEqual(['plain ', 'answer']);
    for (const type of cogTypes) expect(await count(store, type)).toBe(0);
  });

  it('abort mid-stream: the cycle is recorded as aborted, no response episode, nothing unhandled', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      await cfg.setCycleManagerEnabled(true);
      await cfg.setEpisodicMemoryEnabled(true);
      const rt = await makeRuntime(new ScriptedProvider([textRound('first ', 'second ', 'third')]));
      const seen: StreamChunk[] = [];
      for await (const c of rt.handleMessageStream(envelope())) {
        seen.push(c);
        if (c.type === 'text_delta') break; // the consumer stops after the first delta
      }
      await (rt as unknown as { cycleManager: CycleManager }).cycleManager.flushPending();
      expect(seen.map((c) => c.type)).toEqual(['stream_start', 'text_delta']);
      const status = await rows(store, `SELECT ?s WHERE { GRAPH ?g { ?c a <${COGT}Cycle> ; <${COGT}cycleStatus> ?s } }`);
      expect(status.map((r) => r.s.value)).toEqual(['aborted']);
      const types = (await rows(store, `SELECT ?t WHERE { GRAPH ?g { ?e a <${COGT}Episode> ; <${COGT}episodeType> ?t } }`)).map((r) => r.t.value);
      expect(types).toContain('message-received');
      expect(types).not.toContain('response-sent');
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('goal stack on: a streamed turn gets the [Active goal] block in its system prompt; off: it does not', async () => {
    await cfg.setCycleManagerEnabled(true);
    await cfg.setEpisodicMemoryEnabled(true);
    await cfg.setGoalStackEnabled(true);
    const p = new ScriptedProvider([textRound('ok')]);
    await drain(await makeRuntime(p));
    expect(String(p.requests[0].messages[0].content)).toContain('[Active goal]');

    await cfg.setGoalStackEnabled(false);
    const p2 = new ScriptedProvider([textRound('ok')]);
    await drain(await makeRuntime(p2));
    expect(String(p2.requests[0].messages[0].content)).not.toContain('[Active goal]');
  });

  describe('arm_goal on a streamed owner turn', () => {
    it('is no longer refused: the stream records the mandate episode and the goal is armed', async () => {
      await cfg.setCycleManagerEnabled(true);
      await cfg.setEpisodicMemoryEnabled(true);
      const rt = await makeRuntime(new ScriptedProvider([
        toolRound('arm_goal', { newGoal: 'Review the garden plan', wakeIn: 'PT2H' }),
        textRound('armed'),
      ]));
      const chunks = await drain(rt, envelope('please review the garden plan in two hours'));
      const result = chunks.find((c) => c.type === 'tool_result') as { success: boolean; output: unknown };
      expect(result.success).toBe(true);
      expect(armRequests).toHaveLength(1);
      expect(armResults[0]).toMatchObject({ ok: true, created: true });
      const goals = (await rt.goalsForCommand(String((armRequests[0] as { sessionId: string }).sessionId))) ?? [];
      expect(goals.some((g) => g.goalLabel === 'Review the garden plan' && g.forUser === 'owner')).toBe(true);
    });

    it('still refuses without the cycle manager (no mandate episode) and names the flag', async () => {
      const rt = await makeRuntime(new ScriptedProvider([
        toolRound('arm_goal', { newGoal: 'Review the garden plan', wakeIn: 'PT2H' }),
        textRound('refused'),
      ]));
      const chunks = await drain(rt);
      const result = chunks.find((c) => c.type === 'tool_result') as { success: boolean; output: unknown };
      expect(result.success).toBe(false);
      expect(JSON.stringify(result.output)).toContain('cog.flagCycleManager');
      expect(armRequests).toHaveLength(0);
    });

    it('still refuses a non-owner on a streamed turn', async () => {
      await cfg.setCycleManagerEnabled(true);
      await cfg.setEpisodicMemoryEnabled(true);
      const rt = await makeRuntime(new ScriptedProvider([
        toolRound('arm_goal', { newGoal: 'Review the garden plan', wakeIn: 'PT2H' }),
        textRound('refused'),
      ]));
      const env = { ...envelope(), sender: { id: 'telegram:111', channelPrefix: 'telegram', isOwner: false } } as MessageEnvelope;
      const chunks = await drain(rt, env);
      const result = chunks.find((c) => c.type === 'tool_result') as { success: boolean };
      expect(result.success).toBe(false);
      expect(armRequests).toHaveLength(0);
    });
  });
});

describe('CycleManager.runCycleStream', () => {
  const AG = 'ontofelia';
  let store: TriplestoreAdapter;
  let cm: CycleManager;
  let errors: unknown[];
  beforeEach(async () => {
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: `/tmp/cms-test-${Math.random().toString(16).slice(2)}`, port: 0, endpoint: '' });
    errors = [];
    cm = new CycleManager(store, GraphRegistry.create([AG]), AG, (e) => errors.push(e), { awaitPersist: true });
  });
  const describeChunk = (c: string) => ({ sessionId: 's-stream', text: c === 'end' ? 'abc' : undefined, final: c === 'end' });
  const statuses = async () =>
    ((await store.query(`SELECT ?s WHERE { GRAPH ?g { ?c a <${COGT}Cycle> ; <${COGT}cycleStatus> ?s } }`)).bindings ?? []).map((r) => r.s.value);

  it('passes chunks through as they arrive, without buffering the answer', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    async function* core() {
      yield 'a';
      await gate; // the core is held here; the consumer must already have 'a'
      yield 'b';
      yield 'end';
    }
    const it = cm.runCycleStream(envelope(), () => core(), describeChunk, { episodicEnabled: false });
    const first = await it.next();
    expect(first).toEqual({ value: 'a', done: false });
    release();
    const rest: string[] = [];
    for await (const c of it) rest.push(c);
    expect(rest).toEqual(['b', 'end']);
    expect(await statuses()).toEqual(['completed']);
  });

  it('a core that throws closes the cycle as aborted and the error reaches the consumer', async () => {
    async function* core(): AsyncGenerator<string> {
      yield 'a';
      throw new Error('provider down');
    }
    const got: string[] = [];
    await expect((async () => { for await (const c of cm.runCycleStream(envelope(), () => core(), describeChunk)) got.push(c); })())
      .rejects.toThrow('provider down');
    expect(got).toEqual(['a']);
    expect(await statuses()).toEqual(['aborted']);
  });

  it('a consumer that stops after the final chunk still gets a completed cycle', async () => {
    async function* core() { yield 'a'; yield 'end'; yield 'never-read'; }
    for await (const c of cm.runCycleStream(envelope(), () => core(), describeChunk)) if (c === 'end') break;
    expect(await statuses()).toEqual(['completed']);
    expect(errors).toEqual([]);
  });
});
