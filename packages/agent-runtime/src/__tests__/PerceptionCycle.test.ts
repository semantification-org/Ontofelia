import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime, type StreamChunk } from '../index.js';
import { CycleManager } from '../cognitive/CycleManager.js';
import { CognitiveConfig } from '../cognitive/CognitiveConfig.js';
import type {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, MessageEnvelope, TriplestoreAdapter,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import { OxigraphAdapter, KnowledgeEngine, GraphRegistry, GraphUriResolver } from '@ontofelia/semantic-memory';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

// Phase 1 runs before the LLM call and adds no awaited store write there; its
// record reaches the episode (about / tags / hasClaim / transcriptRef), working
// memory and the phase resources through the queued persist. Both the plain and
// the streamed path behave the same, and the answer text does not change.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const OWNER = { id: 'owner', channelPrefix: 'webchat', isOwner: true };
const USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const TEXT = 'Anna works at Acme since last year';
const ANSWER = 'Noted, Anna works at Acme.';
const PARSED = JSON.stringify({
  facts: [
    { subject: 'Anna', subjectType: 'Person', predicate: 'worksAt', object: 'Acme', objectType: 'Organization', confidence: 'high', sourceSpan: TEXT, kind: 'fact' },
  ],
  proposals: [],
  confidence: 'high',
});

const envelope = (text = TEXT): MessageEnvelope => ({
  id: 'm1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender: OWNER, timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
} as MessageEnvelope);

interface Probe {
  /** Store writes seen so far; read by the provider at the moment of the answer call. */
  writes: () => number;
  answerCalls: Array<{ writesBefore: number; stream: boolean }>;
}

/** Answers the semantic parser (no tools) with scripted JSON and the answer call with fixed text. */
class MockProvider implements ProviderAdapter {
  name = 'stub';
  constructor(private readonly probe: Probe, private readonly delayMs = 0, private readonly parsed = PARSED) {}
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; }
  private async pause() { if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs)); }
  async chat(r: ChatRequest): Promise<ChatResponse> {
    await this.pause();
    if (!r.tools) return { id: 'p', content: this.parsed, finishReason: 'stop', toolCalls: [], usage: USAGE };
    this.probe.answerCalls.push({ writesBefore: this.probe.writes(), stream: false });
    return { id: 'a', content: ANSWER, finishReason: 'stop', toolCalls: [], usage: USAGE };
  }
  async *chatStream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    this.probe.answerCalls.push({ writesBefore: this.probe.writes(), stream: true });
    await this.pause();
    yield { type: 'text_delta', content: ANSWER } as StreamEvent;
    yield { type: 'done', response: { id: 'r', content: ANSWER, finishReason: 'stop', toolCalls: [], usage: USAGE } } as StreamEvent;
  }
}

const config: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-perception-ws',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
};

const rows = async (store: TriplestoreAdapter, q: string) => (await store.query(q)).bindings ?? [];

interface Env {
  store: TriplestoreAdapter;
  runtime: AgentRuntime;
  cfg: CognitiveConfig;
  probe: Probe;
  sessions: SessionStore;
  updates: string[];
  dirs: string[];
}

describe('Phase 1 perceives before answering', () => {
  const made: Env[] = [];

  /** A fresh store seeded with a known entity "Anna", and a runtime over it. */
  async function setup(opts: { cycle: boolean; delayMs?: number; parsed?: string; seed?: (ke: KnowledgeEngine, store: TriplestoreAdapter) => Promise<void> }): Promise<Env> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'perception-store-'));
    const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'perception-sess-'));
    const raw = new OxigraphAdapter();
    await raw.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
    const updates: string[] = [];
    let counting = false;
    const store = new Proxy(raw, {
      get(target, prop, recv) {
        if (prop === 'update') {
          return async (sparql: string) => {
            if (counting) updates.push(sparql);
            return target.update(sparql);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as TriplestoreAdapter;
    const ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    await ke.storeFact(
      { subject: 'Anna', subjectType: 'Person', predicate: 'livesIn', object: 'Berlin', objectType: 'Place', confidenceLabel: 'high', status: 'accepted' } as never,
      { agentId: AGENT, sessionId: 'seed', isOwner: true, userId: 'owner' } as never,
    );
    await opts.seed?.(ke, store);
    const cfg = new CognitiveConfig(store, AGENT);
    if (opts.cycle) {
      await cfg.setCycleManagerEnabled(true);
      await cfg.setEpisodicMemoryEnabled(true);
    }
    const probe: Probe = { writes: () => updates.length, answerCalls: [] };
    const sessions = new SessionStore(sessDir);
    const toolRegistry = new ToolRegistry();
    const runtime = new AgentRuntime(
      AGENT, config, new MockProvider(probe, opts.delayMs ?? 0, opts.parsed), sessions,
      toolRegistry, new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(`/tmp/perception-ws-${Math.random().toString(36).slice(2)}`), new SkillRegistry(),
      new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined, ke, undefined,
    );
    counting = true;
    const env = { store, runtime, cfg, probe, sessions, updates, dirs: [dir, sessDir] };
    made.push(env);
    return env;
  }

  const flush = (e: Env) => (e.runtime as unknown as { cycleManager?: CycleManager }).cycleManager?.flushPending();
  async function send(e: Env, text = TEXT) {
    const res = await e.runtime.handleMessage(envelope(text));
    await flush(e);
    return res;
  }
  async function stream(e: Env, text = TEXT): Promise<StreamChunk[]> {
    const out: StreamChunk[] = [];
    for await (const c of e.runtime.handleMessageStream(envelope(text))) out.push(c);
    await flush(e);
    return out;
  }
  const sessionIdOf = async (e: Env) => (await rows(e.store, `SELECT ?s WHERE { GRAPH ?g { ?e <${COGT}sessionId> ?s } } LIMIT 1`))[0].s.value;

  interface Inbound { ref: string; u: string; abouts: string[]; tags: string[]; claims: string[] }
  async function inboundEpisodes(e: Env): Promise<Inbound[]> {
    const eps = await rows(e.store, `
      SELECT ?ep ?u ?ref WHERE {
        GRAPH ?g { ?ep a <${COGT}Episode> ; <${COGT}episodeType> "message-received" ; <${COGT}forUser> ?u ;
          <${COGT}transcriptRef> ?ref } } ORDER BY ?ref`);
    const values = async (ep: string, p: string) =>
      (await rows(e.store, `SELECT ?o WHERE { GRAPH ?g { <${ep}> <${COGT}${p}> ?o } }`)).map((r) => r.o.value).sort();
    const out: Inbound[] = [];
    for (const r of eps) {
      out.push({
        ref: r.ref.value, u: r.u.value,
        abouts: await values(r.ep.value, 'about'),
        tags: await values(r.ep.value, 'tags'),
        claims: await values(r.ep.value, 'hasClaim'),
      });
    }
    return out;
  }

  async function wmEntries(e: Env) {
    const r = await rows(e.store, `
      SELECT ?kind ?payload ?sal ?refers ?u WHERE { GRAPH ?g { ?w a <${COGT}WorkingMemoryEntry> ; <${COGT}entryKind> ?kind ;
        <${COGT}payload> ?payload ; <${COGT}salience> ?sal ; <${COGT}forUser> ?u .
        OPTIONAL { ?w <${COGT}refersTo> ?refers } } }`);
    return r
      .map((b) => ({ kind: b.kind.value, payload: b.payload.value, sal: Number(b.sal.value), refers: b.refers?.value, u: b.u.value }))
      // Claim IRIs are minted per run; compare everything else.
      .map((x) => (x.kind === 'parsed-claim' ? { ...x, refers: x.refers ? '<claim>' : undefined } : x))
      .sort((a, b) => (a.kind + a.payload).localeCompare(b.kind + b.payload));
  }

  beforeEach(() => { made.length = 0; });
  afterEach(async () => {
    for (const e of made) for (const d of e.dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  });

  it('the inbound episode carries about (known entity), tags, hasClaim (stored fact), transcriptRef with a line index and forUser', async () => {
    const e = await setup({ cycle: true });
    await send(e);
    const sid = await sessionIdOf(e);
    const eps = await inboundEpisodes(e);
    expect(eps).toHaveLength(1);
    const ep = eps[0];
    expect(ep.abouts).toHaveLength(1);
    expect(ep.abouts[0]).toMatch(/Anna$/);
    expect(ep.tags).toEqual(['chit-chat']);
    expect(ep.claims).toHaveLength(1);
    // The claim exists in the claims graph under exactly that IRI.
    const found = await rows(e.store, `SELECT ?p WHERE { GRAPH ?g { <${ep.claims[0]}> ?p ?o } } LIMIT 1`);
    expect(found).toHaveLength(1);
    expect(ep.ref).toBe(`${sid}.jsonl:line_0`);
    expect(ep.u).toBe('owner');
    // The line index points at the user entry of the transcript file.
    const lines = (await fs.readFile(e.sessions.getTranscriptPath(sid), 'utf-8')).split('\n').filter(Boolean);
    expect(JSON.parse(lines[0])).toMatchObject({ role: 'user', content: TEXT });
  });

  it('a later turn gets the next line index; the response episode carries about and forUser', async () => {
    const e = await setup({ cycle: true });
    await send(e);
    await send(e);
    const sid = await sessionIdOf(e);
    const eps = await inboundEpisodes(e);
    expect(eps.map((x) => x.ref)).toEqual([`${sid}.jsonl:line_0`, `${sid}.jsonl:line_2`]);
    const lines = (await fs.readFile(e.sessions.getTranscriptPath(sid), 'utf-8')).split('\n').filter(Boolean);
    expect(JSON.parse(lines[2])).toMatchObject({ role: 'user', content: TEXT });
    const resp = await rows(e.store, `
      SELECT ?u ?about WHERE { GRAPH ?g { ?ep <${COGT}episodeType> "response-sent" ; <${COGT}forUser> ?u ; <${COGT}about> ?about } }`);
    expect(resp).toHaveLength(2);
    expect(resp.every((r) => r.u.value === 'owner' && /Anna$/.test(r.about.value))).toBe(true);
  });

  it('writes the perception entries to working memory with the doc salience values, for the sender key', async () => {
    const e = await setup({ cycle: true });
    await send(e);
    const wm = await wmEntries(e);
    const by = (k: string) => wm.filter((x) => x.kind === k);
    expect(by('message-text')).toMatchObject([{ sal: 1.0, payload: TEXT }]);
    expect(by('sender-id')).toMatchObject([{ sal: 1.0 }]); // 0.9 + 0.1 owner
    expect(by('ner-result')).toMatchObject([{ sal: 0.7, payload: 'entity=Anna (resolved)' }]);
    expect(by('parsed-claim')).toMatchObject([{ sal: 0.6, payload: 'Anna | worksAt | Acme', refers: '<claim>' }]);
    expect(by('intent')).toMatchObject([{ sal: 0.8, payload: 'intent=chit-chat' }]);
    expect(wm.every((x) => x.u === 'owner')).toBe(true);
  });

  it('determinism: the same input in a fresh store gives the same working-memory entries', async () => {
    const a = await setup({ cycle: true });
    await send(a);
    const b = await setup({ cycle: true });
    await send(b);
    expect(await wmEntries(a)).toEqual(await wmEntries(b));
  });

  it('the streamed path writes the same records as the plain path', async () => {
    const plain = await setup({ cycle: true });
    await send(plain);
    const streamed = await setup({ cycle: true });
    const chunks = await stream(streamed);
    expect(chunks.map((c) => c.type)).toEqual(['stream_start', 'text_delta', 'stream_end']);
    expect(await wmEntries(streamed)).toEqual(await wmEntries(plain));
    const strip = (r: Inbound) => ({
      abouts: r.abouts, tags: r.tags, claims: r.claims.length, ref: r.ref.replace(/^.*\.jsonl/, ''), u: r.u,
    });
    expect((await inboundEpisodes(streamed)).map(strip)).toEqual((await inboundEpisodes(plain)).map(strip));
  });

  it('the answer text is identical with the cycle manager on and off, and off writes nothing cognitive', async () => {
    const off = await setup({ cycle: false });
    const on = await setup({ cycle: true });
    const a = await send(off);
    const b = await send(on);
    expect(b.text).toBe(a.text);
    expect(a.text).toBe(ANSWER);
    expect(await inboundEpisodes(off)).toHaveLength(0);
    expect(await wmEntries(off)).toHaveLength(0);
    const sOff = await setup({ cycle: false });
    const sOn = await setup({ cycle: true });
    const text = (cs: StreamChunk[]) => cs.filter((c) => c.type === 'text_delta').map((c) => (c as { content: string }).content).join('');
    expect(text(await stream(sOn))).toBe(text(await stream(sOff)));
  });

  it('adds no awaited store write before the LLM call beyond the inbound episode (plain and streamed)', async () => {
    const off = await setup({ cycle: false });
    await send(off);
    const base = off.probe.answerCalls[0].writesBefore;

    const on = await setup({ cycle: true });
    await send(on);
    const withCycle = on.probe.answerCalls[0].writesBefore;
    expect(withCycle - base).toBe(1);
    // The one extra write is the inbound episode, enriched in place.
    const extra = on.updates.slice(0, withCycle).filter((q) => q.includes(`${COGT}Episode`));
    expect(extra).toHaveLength(1);
    expect(extra[0]).toContain('"message-received"');
    expect(extra[0]).toContain(`${COGT}about`);
    expect(extra[0]).toContain(`${COGT}hasClaim`);

    const sOff = await setup({ cycle: false });
    await stream(sOff);
    const sOn = await setup({ cycle: true });
    await stream(sOn);
    expect(sOn.probe.answerCalls[0].writesBefore - sOff.probe.answerCalls[0].writesBefore).toBe(1);

    // No working-memory, cycle or phase write happened before the answer call.
    const before = on.updates.slice(0, withCycle).join('\n');
    expect(before).not.toContain(`${COGT}WorkingMemoryEntry`);
    expect(before).not.toContain(`${COGT}Cycle`);
    expect(before).not.toContain(`${COGT}Phase`);
  });

  it('phase resources: real, monotonic times, perception covers the context build, hasPhase links', async () => {
    const e = await setup({ cycle: true, delayMs: 25 });
    await send(e);
    const phases = await rows(e.store, `
      SELECT ?ord ?s ?e WHERE { GRAPH ?g { ?c <${COGT}hasPhase> ?p . ?p <${COGT}phaseIndex> ?ord ; <${COGT}startedAt> ?s ; <${COGT}endedAt> ?e } }`);
    expect(phases).toHaveLength(6);
    const ph = phases
      .map((r) => ({ ord: Number(r.ord.value), s: Date.parse(r.s.value), e: Date.parse(r.e.value) }))
      .sort((x, y) => x.ord - y.ord);
    expect(ph.map((p) => p.ord)).toEqual([1, 2, 3, 4, 5, 6]);
    for (let i = 0; i < 6; i++) {
      expect(ph[i].e).toBeGreaterThanOrEqual(ph[i].s);
      if (i > 0) expect(ph[i].s).toBeGreaterThanOrEqual(ph[i - 1].e);
    }
    // The parser call (25 ms) runs inside the context build: Phase 1 is not degenerate.
    expect(ph[0].e - ph[0].s).toBeGreaterThanOrEqual(20);
    // No tools: the answer call (25 ms) is the response phase.
    expect(ph[4].e - ph[4].s).toBeGreaterThanOrEqual(20);
    // The earlier predicates are still there.
    const legacy = await rows(e.store, `SELECT ?p WHERE { GRAPH ?g { ?p <${COGT}partOfCycle> ?c } }`);
    expect(legacy).toHaveLength(6);
  });

  // ── entity resolution: the real node, never a slug guess ──────────────────

  const NO_FACTS = JSON.stringify({ facts: [], proposals: [], confidence: 'high' });
  const objFact = (object: string, objectType: string) =>
    ({ subject: 'Tom', subjectType: 'Person', predicate: objectType === 'Place' ? 'visited' : 'knows', object, objectType, confidenceLabel: 'high', status: 'accepted' }) as never;
  const ctxOf = (userId: string) => ({ agentId: AGENT, sessionId: 'seed', isOwner: userId === 'owner', userId }) as never;
  const labelNodes = async (e: Env, label: string) =>
    (await rows(e.store, `SELECT DISTINCT ?n WHERE { GRAPH ?g { ?n <http://www.w3.org/2000/01/rdf-schema#label> ?l } FILTER(LCASE(STR(?l)) = "${label.toLowerCase()}") }`))
      .map((r) => r.n.value).sort();
  const nerRefs = async (e: Env) =>
    (await wmEntries(e)).filter((x) => x.kind === 'ner-result').map((x) => x.refers).sort();
  const ASK = 'Tell me what is new with this one today';

  it('a disambiguated entity (same label, two types): about holds the real node IRIs, not the slug guess', async () => {
    const e = await setup({
      cycle: true, parsed: NO_FACTS,
      seed: async (ke) => {
        // Objects are resolved by label and type, so the second Paris gets a minted node.
        await ke.storeFact(objFact('Paris', 'Person'), ctxOf('owner'));
        await ke.storeFact(objFact('Paris', 'Place'), ctxOf('owner'));
      },
    });
    await send(e, `${ASK} Paris`);
    const nodes = await labelNodes(e, 'Paris');
    expect(nodes).toHaveLength(2);
    expect(nodes.some((n) => !n.endsWith('/Paris') && !n.endsWith(':Paris'))).toBe(true); // one is a minted, non-slug node
    const [ep] = await inboundEpisodes(e);
    expect(ep.abouts).toEqual(nodes);
    expect(await nerRefs(e)).toEqual(nodes);
    const resp = await rows(e.store, `SELECT ?a WHERE { GRAPH ?g { ?ep <${COGT}episodeType> "response-sent" ; <${COGT}about> ?a } }`);
    expect(resp.map((r) => r.a.value).sort()).toEqual(nodes);
  });

  it('a label-matched entity whose URI differs from the slug: Phase 2 resolves it before the answer, so the inbound episode carries it from the start', async () => {
    const custom = 'urn:ontofelia:entity:custom-zoe-7';
    const e = await setup({
      cycle: true, parsed: NO_FACTS,
      seed: async (_ke, store) => {
        await store.update(`INSERT DATA { GRAPH <${GraphUriResolver.getWorldviewGraph(AGENT)}> {
          <${custom}> a <urn:shared:ontology#Person> ; <http://www.w3.org/2000/01/rdf-schema#label> "Zoe" . } }`);
      },
    });
    await send(e, `${ASK} Zoe`);
    const [ep] = await inboundEpisodes(e);
    expect(ep.abouts).toEqual([custom]);
    expect(await nerRefs(e)).toEqual([custom]);
    expect(JSON.stringify(e.updates)).not.toContain('entity:Zoe>'); // no slug guess stored anywhere
    // The episode was written once, with the node, before the tool loop; nothing was added later.
    const eps = await rows(e.store, `SELECT ?ep WHERE { GRAPH ?g { ?ep <${COGT}episodeType> "message-received" } }`);
    expect(eps).toHaveLength(1);
    const writes = e.updates.filter((q) => q.includes('"message-received"'));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain(`${COGT}about> <${custom}>`);
    expect(e.updates.some((q) => q.startsWith('INSERT DATA') && q.includes(`${COGT}about> <${custom}>`) && !q.includes('"message-received"') && !q.includes('"response-sent"'))).toBe(false);
    // The write before the answer call is still just the inbound episode.
    expect(e.probe.answerCalls[0].writesBefore).toBeGreaterThan(0);
    expect(e.updates.slice(0, e.probe.answerCalls[0].writesBefore).filter((q) => q.includes(`${COGT}Episode>`))).toHaveLength(1);
  });

  it('a name no node carries produces no about and no ner-result', async () => {
    const e = await setup({ cycle: true, parsed: NO_FACTS });
    await send(e, `${ASK} Quentin`);
    const [ep] = await inboundEpisodes(e);
    expect(ep.abouts).toEqual([]);
    expect(await nerRefs(e)).toEqual([]);
  });

  it('user scoping: another user\'s private entity is not resolved into this user\'s episode', async () => {
    const e = await setup({
      cycle: true, parsed: NO_FACTS,
      seed: async (ke) => {
        await ke.storeFact(
          { subject: 'Bruno', subjectType: 'Person', predicate: 'knows', object: 'Berlin', objectType: 'Place', confidenceLabel: 'high', status: 'accepted' } as never,
          ctxOf('bob'),
        );
      },
    });
    const ke = new KnowledgeEngine(e.store, undefined, GraphRegistry.create([AGENT]));
    // Positive control: bob's own scope finds the node; the owner's scope does not.
    expect((await ke.lookupExistingEntityUris('Bruno', { agentId: AGENT, userId: 'bob' })).length).toBeGreaterThan(0);
    expect(await ke.lookupExistingEntityUris('Bruno', { agentId: AGENT, userId: 'owner' })).toEqual([]);
    await send(e, `${ASK} Bruno`);
    const [ep] = await inboundEpisodes(e);
    expect(ep.abouts).toEqual([]);
    expect(await nerRefs(e)).toEqual([]);
  });

  it('an entity named by a fact stored this turn gets the IRI storeFact used (minted, disambiguated node)', async () => {
    const parsed = JSON.stringify({
      facts: [{ subject: 'Tom', subjectType: 'Person', predicate: 'visited', object: 'Paris', objectType: 'Place', confidence: 'high', sourceSpan: 'Tom visited Paris', kind: 'fact' }],
      proposals: [], confidence: 'high',
    });
    const e = await setup({
      cycle: true, parsed,
      seed: async (ke) => { await ke.storeFact(objFact('Paris', 'Person'), ctxOf('owner')); },
    });
    await send(e, 'Tom visited Paris last week');
    const nodes = await labelNodes(e, 'Paris');
    expect(nodes).toHaveLength(2);
    const [ep] = await inboundEpisodes(e);
    // Tom is a pinned subject node; Paris is the minted node, not the older person node.
    const minted = nodes.find((n) => /Paris_/.test(n))!;
    expect(minted).toBeDefined();
    expect(ep.abouts).toContain(minted);
    expect(ep.abouts).not.toContain(nodes.find((n) => !/Paris_/.test(n))!);
    // Written with the inbound episode itself, before the tool loop.
    expect(e.updates.filter((q) => q.includes('"message-received"'))[0]).toContain(`${COGT}about> <${minted}>`);
  });
});
