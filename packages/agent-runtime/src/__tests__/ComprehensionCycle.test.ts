import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime, type StreamChunk } from '../index.js';
import { CycleManager } from '../cognitive/CycleManager.js';
import { CognitiveConfig } from '../cognitive/CognitiveConfig.js';
import { GoalStack } from '../cognitive/GoalStack.js';
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

// Phase 2 recalls before the answer, reads only, and is scoped to the sender.
// Real stores, a mock provider, the full runtime path.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const CORE = 'urn:ontofelia:core#';
const E = 'urn:ontofelia:entity:custom-zoe-7';
const ASK = 'What do you know about Zoe?';
const OWNER = { id: 'owner', channelPrefix: 'webchat', isOwner: true };
const ALICE = { id: 'alice', channelPrefix: 'webchat', isOwner: false };
const USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const ANSWER = 'Here is what I know.';
const NO_FACTS = JSON.stringify({ facts: [], proposals: [], confidence: 'high' });

type Sender = typeof OWNER | typeof ALICE;
const envelope = (text: string, sender: Sender = ALICE): MessageEnvelope => ({
  id: 'm1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender, timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
} as MessageEnvelope);

interface Probe {
  writes: () => number;
  answerCalls: Array<{ writesBefore: number }>;
}

class MockProvider implements ProviderAdapter {
  name = 'stub';
  constructor(private readonly probe: Probe) {}
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; }
  async chat(r: ChatRequest): Promise<ChatResponse> {
    if (!r.tools) return { id: 'p', content: NO_FACTS, finishReason: 'stop', toolCalls: [], usage: USAGE };
    this.probe.answerCalls.push({ writesBefore: this.probe.writes() });
    return { id: 'a', content: ANSWER, finishReason: 'stop', toolCalls: [], usage: USAGE };
  }
  async *chatStream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    this.probe.answerCalls.push({ writesBefore: this.probe.writes() });
    yield { type: 'text_delta', content: ANSWER } as StreamEvent;
    yield { type: 'done', response: { id: 'r', content: ANSWER, finishReason: 'stop', toolCalls: [], usage: USAGE } } as StreamEvent;
  }
}

const config: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-comprehension-ws',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
};

const rows = async (store: TriplestoreAdapter, q: string) => (await store.query(q)).bindings ?? [];

interface Env {
  store: TriplestoreAdapter;
  runtime: AgentRuntime;
  cfg: CognitiveConfig;
  ke: KnowledgeEngine;
  em: EpisodicMemory;
  probe: Probe;
  updates: string[];
  queries: string[];
  dirs: string[];
}

interface Recalled { kind: string; payload: string; score: number; u: string; refers?: string; src: string; cycleId: string }

describe('Phase 2 recalls before the answer', () => {
  const made: Env[] = [];

  async function setup(opts: {
    cycle?: boolean; goals?: boolean; metacog?: boolean;
    seed?: (env: { ke: KnowledgeEngine; store: TriplestoreAdapter; em: EpisodicMemory }) => Promise<void>;
  } = {}): Promise<Env> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compr-store-'));
    const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'compr-sess-'));
    const raw = new OxigraphAdapter();
    await raw.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
    const updates: string[] = [];
    const queries: string[] = [];
    let counting = false;
    const store = new Proxy(raw, {
      get(target, prop, recv) {
        if (prop === 'update') {
          return async (sparql: string) => { if (counting) updates.push(sparql); return target.update(sparql); };
        }
        if (prop === 'query') {
          return async (sparql: string) => { if (counting) queries.push(sparql); return target.query(sparql); };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as TriplestoreAdapter;
    const ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    // The entity Zoe: a node whose IRI differs from the slug, labelled in the worldview.
    await store.update(`INSERT DATA { GRAPH <${GraphUriResolver.getWorldviewGraph(AGENT)}> {
      <${E}> a <urn:shared:ontology#Person> ; <${RDFS_LABEL}> "Zoe" . } }`);
    const em = new EpisodicMemory(store, AGENT);
    await opts.seed?.({ ke, store, em });
    const cfg = new CognitiveConfig(store, AGENT);
    if (opts.cycle ?? true) {
      await cfg.setCycleManagerEnabled(true);
      await cfg.setEpisodicMemoryEnabled(true);
    }
    if (opts.goals) await cfg.setGoalStackEnabled(true);
    if (opts.metacog) await cfg.setMetacognitionEnabled(true);
    const probe: Probe = { writes: () => updates.length, answerCalls: [] };
    const runtime = new AgentRuntime(
      AGENT, config, new MockProvider(probe), new SessionStore(sessDir),
      new ToolRegistry(), new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(`/tmp/compr-ws-${Math.random().toString(36).slice(2)}`), new SkillRegistry(),
      new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined, ke, undefined,
    );
    counting = true;
    const env = { store, runtime, cfg, ke, em, probe, updates, queries, dirs: [dir, sessDir] };
    made.push(env);
    return env;
  }

  const flush = (e: Env) => (e.runtime as unknown as { cycleManager?: CycleManager }).cycleManager?.flushPending();
  async function send(e: Env, text = ASK, sender: Sender = ALICE) {
    const res = await e.runtime.handleMessage(envelope(text, sender));
    await flush(e);
    return res;
  }
  async function stream(e: Env, text = ASK, sender: Sender = ALICE): Promise<StreamChunk[]> {
    const out: StreamChunk[] = [];
    for await (const c of e.runtime.handleMessageStream(envelope(text, sender))) out.push(c);
    await flush(e);
    return out;
  }

  /** The retrieval buffer entries of every cycle, best score first. */
  async function recalled(e: Env): Promise<Recalled[]> {
    const r = await rows(e.store, `
      SELECT ?g ?kind ?payload ?score ?u ?refers ?src WHERE { GRAPH ?g { ?w a <${COGT}WorkingMemoryEntry> ;
        <${COGT}writtenTo> "retrievalBuffer" ; <${COGT}entryKind> ?kind ; <${COGT}payload> ?payload ;
        <${COGT}retrievalScore> ?score ; <${COGT}forUser> ?u ; <${COGT}sourceGraph> ?src .
        OPTIONAL { ?w <${COGT}refersTo> ?refers } } }`);
    return r
      .map((b) => ({
        kind: b.kind.value, payload: b.payload.value, score: Number(b.score.value), u: b.u.value,
        refers: b.refers?.value, src: b.src.value, cycleId: b.g.value.split(':').pop() as string,
      }))
      .sort((a, b) => b.score - a.score || a.payload.localeCompare(b.payload));
  }
  const markers = async (e: Env) =>
    (await rows(e.store, `SELECT ?v WHERE { GRAPH ?g { ?m a <${COGT}ReflectiveMarker> ; <${COGT}emptyRetrieval> ?v } }`)).map((r) => r.v.value);

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

  beforeEach(() => { made.length = 0; });
  afterEach(async () => {
    for (const e of made) for (const d of e.dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  });

  /** alice: two episodes about Zoe in two sessions; bob and the owner also have one; one legacy episode. */
  const seedZoe = async ({ em }: { em: EpisodicMemory }) => {
    await em.append({ episodeType: 'message-received', sessionId: 's-old-1', forUser: 'alice', about: [E], payload: 'alice old: Zoe is my sister', occurredAt: hoursAgo(72) });
    await em.append({ episodeType: 'message-received', sessionId: 's-old-2', forUser: 'alice', about: [E], payload: 'alice newer: Zoe moved flats', occurredAt: hoursAgo(2) });
    await em.append({ episodeType: 'message-received', sessionId: 's-bob', forUser: 'bob', about: [E], payload: 'bob secret: Zoe owes me money', occurredAt: hoursAgo(1) });
    await em.append({ episodeType: 'message-received', sessionId: 's-own', forUser: 'owner', about: [E], payload: 'owner note: Zoe is a contractor', occurredAt: hoursAgo(3) });
    await em.append({ episodeType: 'message-received', sessionId: 's-legacy', about: [E], payload: 'legacy (no user key): Zoe from before keys', occurredAt: hoursAgo(5) });
  };

  it('a question about E in a new session recalls the same user\'s earlier episodes about E, best first, and nothing of another user', async () => {
    const e = await setup({ seed: seedZoe });
    await send(e);
    const r = (await recalled(e)).filter((x) => x.kind === 'episode-ref');
    expect(r.map((x) => x.payload)).toEqual(['alice newer: Zoe moved flats', 'alice old: Zoe is my sister']);
    expect(r.every((x) => x.u === 'alice' && x.src === 'urn:ontofelia:cog:episodic')).toBe(true);
    // entity 1.0 -> 0.4; question tag: neither episode carries one; recency exp(-h/168).
    const expected = (h: number) => 0.4 + 0.2 * Math.exp(-h / 168);
    expect(r[0].score).toBeCloseTo(expected(2), 2);
    expect(r[1].score).toBeCloseTo(expected(72), 2);
    expect(r[0].score).toBeGreaterThan(r[1].score);
    const all = JSON.stringify(await recalled(e));
    for (const secret of ['bob secret', 'owner note', 'legacy (no user key)']) expect(all).not.toContain(secret);
  });

  it('the intent tag adds 0.1: an episode tagged like the question outranks an equally old untagged one', async () => {
    const e = await setup({
      seed: async ({ em }) => {
        const at = hoursAgo(10);
        await em.append({ episodeType: 'message-received', sessionId: 's1', forUser: 'alice', about: [E], payload: 'plain', occurredAt: at });
        await em.append({ episodeType: 'message-received', sessionId: 's2', forUser: 'alice', about: [E], payload: 'tagged', tags: ['question'], occurredAt: at });
      },
    });
    await send(e);
    const r = (await recalled(e)).filter((x) => x.kind === 'episode-ref');
    expect(r.map((x) => x.payload)).toEqual(['tagged', 'plain']);
    expect(r[0].score - r[1].score).toBeCloseTo(0.1, 3);
  });

  it('the owner recalls only the owner\'s own episodes (legacy ones count as the owner\'s), never alice\'s or bob\'s', async () => {
    const e = await setup({ seed: seedZoe });
    await send(e, ASK, OWNER);
    const r = (await recalled(e)).filter((x) => x.kind === 'episode-ref');
    expect(r.map((x) => x.payload).sort()).toEqual([
      'legacy (no user key): Zoe from before keys',
      'owner note: Zoe is a contractor',
    ]);
    expect(r.every((x) => x.u === 'owner')).toBe(true);
  });

  it('goal-anchored recall: episodes of the viewer\'s active goal come back with the goal weight, with the goal stack on', async () => {
    const GOAL_TYPE = `${COGT}AnswerQuestion`;
    let goalUri = '';
    const e = await setup({
      goals: true,
      seed: async ({ store, em }) => {
        const gs = new GraphReg(store, 'gs-old', { userId: 'alice', isOwner: false });
        goalUri = await gs.push({ goalType: GOAL_TYPE, goalLabel: 'Plan the trip', priority: 0.9, longTerm: true });
        await gs.migrateLongterm();
        await em.append({ episodeType: 'message-received', sessionId: 'gs-old', forUser: 'alice', partOfGoal: goalUri, payload: 'we are planning the trip to Lisbon', occurredAt: hoursAgo(30) });
        await em.append({ episodeType: 'message-received', sessionId: 'gs-old', forUser: 'alice', payload: 'unrelated chatter', occurredAt: hoursAgo(30) });
        // Same goal, but another user's episode: must never come back.
        await em.append({ episodeType: 'message-received', sessionId: 'gs-bob', forUser: 'bob', partOfGoal: goalUri, payload: 'bob on the same goal', occurredAt: hoursAgo(30) });
      },
    });
    await send(e, 'Where did we get with the plans?');
    const r = (await recalled(e)).filter((x) => x.kind === 'episode-ref');
    const hit = r.find((x) => x.payload === 'we are planning the trip to Lisbon');
    expect(hit).toBeDefined();
    expect(hit!.score).toBeCloseTo(0.3 + 0.2 * Math.exp(-30 / 168), 2);
    expect(r.some((x) => x.payload === 'bob on the same goal')).toBe(false);
    // Goal stack off: the same episode is not goal-anchored any more.
    const off = await setup({
      goals: false,
      seed: async ({ em }) => {
        await em.append({ episodeType: 'message-received', sessionId: 'gs-old', forUser: 'alice', partOfGoal: 'urn:ontofelia:cog:goal:x', payload: 'we are planning the trip to Lisbon', occurredAt: hoursAgo(30) });
      },
    });
    await send(off, 'Where did we get with the plans?');
    expect((await recalled(off)).filter((x) => x.kind === 'episode-ref')).toEqual([]);
  });

  it('session-temporal recall: the newest episodes of this session come back, with no entity or goal weight', async () => {
    const e = await setup();
    await send(e, 'The weather is nice');
    await send(e, 'Remind me what I just said');
    const r = (await recalled(e)).filter((x) => x.kind === 'episode-ref');
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((x) => x.payload === 'The weather is nice')).toBe(true);
    expect(r.every((x) => x.score <= 0.3 + 1e-9)).toBe(true); // 0.2 recency + 0.1 tag at most
  });

  it('empty recall writes no entries and the marker says so; a non-empty recall says the opposite', async () => {
    const empty = await setup({ metacog: true });
    await send(empty, 'Good morning to you');
    expect(await recalled(empty)).toEqual([]);
    expect(await markers(empty)).toEqual(['true']);

    const full = await setup({ metacog: true, seed: seedZoe });
    await send(full);
    expect((await recalled(full)).length).toBeGreaterThan(0);
    expect(await markers(full)).toEqual(['false']);
  });

  it('the current turn\'s own inbound episode is never recalled', async () => {
    const e = await setup();
    await send(e, ASK);
    await send(e, ASK);
    await send(e, ASK);
    const own = await rows(e.store, `
      SELECT ?ep ?c WHERE { GRAPH ?g { ?ep <${COGT}episodeType> "message-received" ; <${COGT}cycleId> ?c } }`);
    expect(own).toHaveLength(3);
    const byCycle = new Map(own.map((r) => [r.c.value, r.ep.value]));
    const rec = await recalled(e);
    expect(rec.length).toBeGreaterThan(0);
    for (const r of rec) expect(r.refers).not.toBe(byCycle.get(r.cycleId));
    // Positive control: the earlier turns' episodes do come back.
    expect(rec.some((r) => r.cycleId !== undefined && own.some((o) => o.ep.value === r.refers))).toBe(true);
  });

  it('semantic facts: the sender\'s own fact ranks above a worldview fact; both are 1-hop facts of the entity', async () => {
    const e = await setup({
      seed: async ({ store }) => {
        await store.update(`INSERT DATA {
          GRAPH <${GraphUriResolver.getUserGraph(AGENT, 'alice')}> {
            <${E}> <${CORE}likes> <urn:ontofelia:entity:Tea> . <urn:ontofelia:entity:Tea> <${RDFS_LABEL}> "Tea" . }
          GRAPH <${GraphUriResolver.getWorldviewGraph(AGENT)}> {
            <${E}> <${CORE}knows> <urn:ontofelia:entity:Bob> . <urn:ontofelia:entity:Bob> <${RDFS_LABEL}> "Bob" . }
          GRAPH <${GraphUriResolver.getUserGraph(AGENT, 'bob')}> {
            <${E}> <${CORE}fears> <urn:ontofelia:entity:Dogs> . <urn:ontofelia:entity:Dogs> <${RDFS_LABEL}> "Dogs" . } }`);
      },
    });
    await send(e);
    const facts = (await recalled(e)).filter((x) => x.kind === 'fact');
    expect(facts.map((f) => f.payload)).toEqual(['Zoe likes Tea', 'Zoe knows Bob']);
    expect(facts[0].score).toBeCloseTo(0.4 + 0.3 * 1.0, 3);
    expect(facts[1].score).toBeCloseTo(0.4 + 0.3 * 0.6, 3);
    expect(facts[0].src).toBe(GraphUriResolver.getUserGraph(AGENT, 'alice'));
    expect(facts[1].src).toBe(GraphUriResolver.getWorldviewGraph(AGENT));
    expect(JSON.stringify(facts)).not.toContain('Dogs');
    expect(facts.every((f) => f.u === 'alice' && f.refers === E)).toBe(true);
  });

  it('a superseded livesIn is flagged as changed, with the previous value', async () => {
    const e = await setup({
      seed: async ({ ke, store }) => {
        await store.update(`INSERT DATA { GRAPH <urn:shared:ontology> {
          <${CORE}livesIn> a <http://www.w3.org/2002/07/owl#ObjectProperty>, <http://www.w3.org/2002/07/owl#FunctionalProperty> . } }`);
        const ctx = { agentId: AGENT, sessionId: 'seed', isOwner: false, userId: 'alice' } as never;
        for (const place of ['Hamburg', 'Berlin']) {
          await ke.storeFact({ subject: 'Mara', subjectType: 'Person', predicate: 'livesIn', object: place, objectType: 'Place', sourceKind: 'user' } as never, ctx);
        }
      },
    });
    await send(e, 'What do you know about Mara?');
    const facts = (await recalled(e)).filter((x) => x.kind === 'fact');
    const lives = facts.filter((f) => /Berlin/.test(f.payload));
    expect(lives).toHaveLength(1);
    expect(lives[0].payload).toMatch(/changed; previously Hamburg/);
    expect(facts.some((f) => /Hamburg/.test(f.payload) && !/previously/.test(f.payload))).toBe(false);
  });

  it('cap: at most eight entries, best first', async () => {
    const e = await setup({
      seed: async ({ em }) => {
        for (let i = 0; i < 12; i++) {
          await em.append({ episodeType: 'message-received', sessionId: `s${i}`, forUser: 'alice', about: [E], payload: `episode ${i}`, occurredAt: hoursAgo(i + 1) });
        }
      },
    });
    await send(e);
    const r = (await recalled(e)).filter((x) => x.kind === 'episode-ref');
    expect(r).toHaveLength(8);
    expect(r.map((x) => x.payload)).toEqual(Array.from({ length: 8 }, (_, i) => `episode ${i}`));
  });

  it('streaming recalls the same as the plain path', async () => {
    const plain = await setup({ seed: seedZoe });
    await send(plain);
    const streamed = await setup({ seed: seedZoe });
    const chunks = await stream(streamed);
    expect(chunks.map((c) => c.type)).toEqual(['stream_start', 'text_delta', 'stream_end']);
    const strip = (x: Recalled[]) => x.map((r) => ({ k: r.kind, p: r.payload, u: r.u, s: Math.round(r.score * 1000) / 1000 }));
    expect(strip(await recalled(streamed)).length).toBeGreaterThan(0);
    // Scores differ in the third decimal at most (clock); order and content are equal.
    expect(strip(await recalled(streamed)).map((x) => [x.k, x.p, x.u])).toEqual(strip(await recalled(plain)).map((x) => [x.k, x.p, x.u]));
  });

  it('cycle manager off: no cognitive read, no cognitive write, and the same answer', async () => {
    const off = await setup({ cycle: false, seed: seedZoe });
    const on = await setup({ seed: seedZoe });
    const a = await send(off);
    const b = await send(on);
    expect(a.text).toBe(ANSWER);
    expect(b.text).toBe(a.text);
    // The one allowed cognitive read with the cycle off is the flag lookup itself.
    const cognitive = (q: string) => (q.includes(':cog:') || q.includes(COGT)) && !q.includes('flagCycleManager');
    expect(off.queries.filter(cognitive)).toEqual([]);
    expect(off.updates.filter(cognitive)).toEqual([]);
    expect(await recalled(off)).toEqual([]);
    // Positive control: with the cycle on, the same spy does see cognitive reads and writes.
    expect(on.queries.filter(cognitive).length).toBeGreaterThan(0);
    expect(on.updates.filter(cognitive).length).toBeGreaterThan(0);
    const text = (cs: StreamChunk[]) => cs.filter((c) => c.type === 'text_delta').map((c) => (c as { content: string }).content).join('');
    const sOff = await setup({ cycle: false, seed: seedZoe });
    const sOn = await setup({ seed: seedZoe });
    expect(text(await stream(sOn))).toBe(text(await stream(sOff)));
  });

  it('the recall adds reads but no awaited write before the LLM call (plain and streamed)', async () => {
    const empty = await setup({});
    await send(empty, 'Good morning to you');
    const base = empty.probe.answerCalls[0].writesBefore;
    const full = await setup({ seed: seedZoe });
    await send(full);
    const withRecall = full.probe.answerCalls[0].writesBefore;
    // Same as an empty recall: the inbound episode only (seeding happened before the spy).
    expect(withRecall).toBe(base);
    const before = full.updates.slice(0, withRecall).join('\n');
    expect(before).not.toContain(`${COGT}WorkingMemoryEntry`);
    expect(before).not.toContain(`${COGT}Cycle>`);
    // The recall itself was read before the answer.
    expect((await recalled(full)).length).toBeGreaterThan(0);

    const s = await setup({ seed: seedZoe });
    await stream(s);
    expect(s.probe.answerCalls[0].writesBefore).toBe(withRecall);
  });

  it('the new flag is off by default and does not gate the recall', async () => {
    const e = await setup({ seed: seedZoe });
    expect(await e.cfg.isEpisodicRecallEnabled()).toBe(false);
    await send(e);
    expect((await recalled(e)).length).toBeGreaterThan(0);
    await e.cfg.setEpisodicRecallEnabled(true);
    expect(await e.cfg.isEpisodicRecallEnabled()).toBe(true);
  });
});

/** A goal stack for a seeded session (the helper keeps the registry wiring in one place). */
class GraphReg extends GoalStack {
  constructor(store: TriplestoreAdapter, session: string, viewer: { userId: string; isOwner: boolean }) {
    super(store, GraphRegistry.create([AGENT]), AGENT, session, undefined, viewer);
  }
}
