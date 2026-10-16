import { AgentRuntime, type StreamChunk } from '../index.js';
import { CycleManager } from '../cognitive/CycleManager.js';
import { CognitiveConfig, type CognitiveFlagInfo } from '../cognitive/CognitiveConfig.js';
import type {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, MessageEnvelope, TriplestoreAdapter,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import type { ToolAuditEntry, ToolCategory } from '@ontofelia/core';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import {
  OxigraphAdapter, KnowledgeEngine, GraphRegistry, GraphUriResolver, EpisodicMemory,
  ProceduralMemory, SelfModel,
} from '@ontofelia/semantic-memory';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

// Shared fixture for the prompt tests: a real embedded store, the full runtime
// path and a provider that records the system prompt of every answer call.
// Uses only fixture data; nothing here is real.

export const AGENT = 'ontofelia';
export const COGT = 'urn:shared:ontology#cog/';
export const OWNER = { id: 'owner', channelPrefix: 'webchat', isOwner: true };
export const ALICE = { id: 'alice', channelPrefix: 'webchat', isOwner: false };
export type Sender = typeof OWNER | typeof ALICE;
const USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const ANSWER = 'Here is what I know.';
const NO_FACTS = JSON.stringify({ facts: [], proposals: [], confidence: 'high' });

export const envelope = (text: string, sender: Sender = ALICE): MessageEnvelope => ({
  id: 'm1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender, timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
} as MessageEnvelope);

export interface Probe {
  writes: () => number;
  /** One entry per answer call: the system prompt and the writes counted before it. */
  answers: Array<{ system: string; writesBefore: number }>;
}

class MockProvider implements ProviderAdapter {
  name = 'stub';
  constructor(private readonly probe: Probe) {}
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; }
  private note(r: ChatRequest) {
    const first = r.messages[0];
    this.probe.answers.push({
      system: first?.role === 'system' && typeof first.content === 'string' ? first.content : '',
      writesBefore: this.probe.writes(),
    });
  }
  async chat(r: ChatRequest): Promise<ChatResponse> {
    if (!r.tools) return { id: 'p', content: NO_FACTS, finishReason: 'stop', toolCalls: [], usage: USAGE };
    this.note(r);
    return { id: 'a', content: ANSWER, finishReason: 'stop', toolCalls: [], usage: USAGE };
  }
  async *chatStream(r: ChatRequest): AsyncIterable<StreamEvent> {
    this.note(r);
    yield { type: 'text_delta', content: ANSWER } as StreamEvent;
    yield { type: 'done', response: { id: 'r', content: ANSWER, finishReason: 'stop', toolCalls: [], usage: USAGE } } as StreamEvent;
  }
}

const config: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-prompt-ws',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
};

export interface Env {
  store: TriplestoreAdapter;
  runtime: AgentRuntime;
  cfg: CognitiveConfig;
  em: EpisodicMemory;
  probe: Probe;
  updates: string[];
  dirs: string[];
}

export const flagInfo = (name: string): CognitiveFlagInfo => ({ name, key: name.replace(/^flag/, ''), description: '' });
export const setFlag = (cfg: CognitiveConfig, name: string, on = true) => cfg.setEnabled(flagInfo(name), on);

export const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

export async function makeEnv(opts: {
  /** Flag names to switch on (besides nothing). */
  flags?: string[];
  seed?: (e: { store: TriplestoreAdapter; em: EpisodicMemory }) => Promise<void>;
  /** Replaces the default answer-only provider (e.g. one that makes tool calls). */
  provider?: (probe: Probe) => ProviderAdapter;
  /** Tools to register and allow; a failing tool returns an error result. */
  tools?: Array<{ name: string; fails?: boolean; category?: ToolCategory; description?: string }>;
  /** Tool names on the policy's deny list (they stay registered). */
  deny?: string[];
} = {}): Promise<Env> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-store-'));
  const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-sess-'));
  const raw = new OxigraphAdapter();
  await raw.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
  const updates: string[] = [];
  let counting = false;
  const store = new Proxy(raw, {
    get(target, prop, recv) {
      if (prop === 'update') {
        return async (sparql: string) => { if (counting) updates.push(sparql); return target.update(sparql); };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as TriplestoreAdapter;
  const ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
  const em = new EpisodicMemory(store, AGENT);
  await opts.seed?.({ store, em });
  const cfg = new CognitiveConfig(store, AGENT);
  for (const f of opts.flags ?? []) await setFlag(cfg, f);
  const probe: Probe = { writes: () => updates.length, answers: [] };
  const toolRegistry = new ToolRegistry();
  for (const t of opts.tools ?? []) {
    toolRegistry.register({
      name: t.name, description: t.description ?? 'test', category: t.category ?? 'utility', inputSchema: {}, permissions: [],
      execute: async () => ({
        success: !t.fails, output: t.fails ? 'failed' : 'ok', ...(t.fails ? { error: 'boom' } : {}),
        auditEntry: {} as unknown as ToolAuditEntry,
      }),
    });
  }
  const toolNames = (opts.tools ?? []).map((t) => t.name);
  const runtime = new AgentRuntime(
    AGENT, { ...config, enabledTools: toolNames }, opts.provider ? opts.provider(probe) : new MockProvider(probe), new SessionStore(sessDir),
    toolRegistry, new ToolPolicyEngine({ allow: toolNames, deny: opts.deny ?? [] }),
    new AuditLog(`/tmp/prompt-ws-${Math.random().toString(36).slice(2)}`), new SkillRegistry(),
    new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined, ke, undefined,
  );
  counting = true;
  return { store, runtime, cfg, em, probe, updates, dirs: [dir, sessDir] };
}

export const flushEnv = async (e: Env) => {
  await (e.runtime as unknown as { cycleManager?: CycleManager }).cycleManager?.flushPending();
};

export async function send(e: Env, text: string, sender: Sender = ALICE) {
  const res = await e.runtime.handleMessage(envelope(text, sender));
  await flushEnv(e);
  return res;
}

export async function stream(e: Env, text: string, sender: Sender = ALICE): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of e.runtime.handleMessageStream(envelope(text, sender))) out.push(c);
  await flushEnv(e);
  return out;
}

export async function cleanup(envs: Env[]) {
  for (const e of envs) {
    await flushEnv(e);
    for (const d of e.dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
}

/** Seed one learned skill and a self model, both for the AnswerQuestion goal type. */
export async function seedSkillAndSelf(store: TriplestoreAdapter): Promise<void> {
  const pm = new ProceduralMemory(store, AGENT);
  for (let i = 0; i < 3; i++) {
    const uri = await pm.recordTrace({
      toolName: 'searchKb', toolArgsHash: 'h', toolArgsBrief: 'query', executedAt: new Date(),
      durationMs: 20, outcome: 'success', forGoalType: `${COGT}AnswerQuestion`, sequencePos: 1,
    });
    await pm.backfillSatisfaction(uri, true);
  }
  await pm.consolidate({ since: new Date(0), until: new Date(Date.now() + 1000) });
  await new SelfModel(store, AGENT).seed({
    capabilities: [{ id: 'answer', label: 'Answer questions', requires: ['searchKb'], relevantToGoalType: [`${COGT}AnswerQuestion`] }],
    constraints: [{ id: 'no_secret', label: 'Never persist secrets', applies: ['memory_store'], enforcedBy: 'MemorySkill' }],
  });
}

/** Set a numeric setup-graph value on the cognitive config subject. */
export async function setNumber(store: TriplestoreAdapter, name: string, value: number): Promise<void> {
  const graph = GraphUriResolver.getSetupGraph(AGENT);
  await store.update(`INSERT DATA { GRAPH <${graph}> { <urn:${AGENT}:setup:cognitive> <${COGT}${name}> "${value}"^^<http://www.w3.org/2001/XMLSchema#decimal> } }`);
}

export const rows = async (store: TriplestoreAdapter, q: string) => (await store.query(q)).bindings ?? [];

/** The legacy goal / skills / self blocks for the seeded fixture and the question below. */
export const GOLDEN_SECTIONS =
  '[Active goal]\n- Answer: what is oxigraph? (type: AnswerQuestion, priority: 0.7)\n\n' +
  '[Skills that worked before for this kind of goal]\n• searchKb — used 3×, 100% success, satisfied 100%, ~20 ms avg\n\n' +
  '[Self]\nCapabilities relevant to this goal:\n• Answer questions (uses searchKb)\nConstraints I must respect:\n• Never persist secrets [MemorySkill]';

