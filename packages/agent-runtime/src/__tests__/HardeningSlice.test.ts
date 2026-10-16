import { describe, it, expect, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AGENT, COGT, OWNER, ALICE, makeEnv, send, stream, cleanup, rows, hoursAgo, seedSkillAndSelf, GOLDEN_SECTIONS,
  type Env, type Probe, type Sender,
} from './promptHarness.js';
import { WorkingMemory } from '../cognitive/WorkingMemory.js';
import { CycleManager, SUPERSEDED_REASON, type RunCycleOptions } from '../cognitive/CycleManager.js';
import { Metacognition, CHURN_NOTE_TEXT, UNKNOWN_NUDGE_TEXT } from '../cognitive/Metacognition.js';
import { GoalStack, GOAL_TYPES } from '../cognitive/GoalStack.js';
import { ARG_DIGEST_KEY_FILE, fileKeySource, fixedKeySource, loadOrCreateKey } from '../cognitive/ArgDigestKey.js';
import type { PerceptionSource } from '../cognitive/Perception.js';
import {
  GraphRegistry, GraphUriResolver, OxigraphAdapter, ProceduralMemory, SelfModel,
} from '@ontofelia/semantic-memory';
import type {
  ChatRequest, ChatResponse, MessageEnvelope, ProviderAdapter, StreamEvent, TriplestoreAdapter,
} from '@ontofelia/core';

// The hardening slice of the cognitive layer: carried entries in the live
// prompt, cognitive blocks without the goal stack, the churn warning on a
// streamed turn, the per-user impasse cap, the scheduled reflection, the keyed
// digest of masked arguments and the supersession of idle competition losers.
// Everything here uses fixture data and obviously fake secrets.

const BASE = ['flagCycleManager', 'flagEpisodicMemory'];
const GS = 'flagGoalStack';
const LIVE = 'flagWorkingMemoryPrompt';
const USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const NO_FACTS = JSON.stringify({ facts: [], proposals: [], confidence: 'high' });
const PHASE = 'urn:ontofelia:cog:phase:hardening-test';

/** Answers after the given rounds of tool calls; plain and streamed alike. */
function toolProvider(plan: number[]): (probe: Probe) => ProviderAdapter {
  return (probe) => {
    let answers = 0;
    return {
      name: 'stub',
      async initialize() {},
      async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; },
      async chat(r: ChatRequest): Promise<ChatResponse> {
        if (!r.tools) return { id: 'p', content: NO_FACTS, finishReason: 'stop', toolCalls: [], usage: USAGE };
        const first = r.messages[0];
        if (answers === 0) {
          probe.answers.push({
            system: first?.role === 'system' && typeof first.content === 'string' ? first.content : '',
            writesBefore: probe.writes(),
          });
        }
        const round = answers++;
        if (round < plan.length) {
          return {
            id: `r${round}`, content: '', finishReason: 'tool_calls', usage: USAGE,
            toolCalls: Array.from({ length: plan[round] }, (_, k) => ({ id: `tc${round}_${k}`, name: 'probe_tool', arguments: '{}' })),
          };
        }
        return { id: 'a', content: 'Done.', finishReason: 'stop', toolCalls: [], usage: USAGE };
      },
      async *chatStream(r: ChatRequest): AsyncIterable<StreamEvent> {
        yield { type: 'done', response: await this.chat(r) } as StreamEvent;
      },
    } as ProviderAdapter;
  };
}

describe('item 1: carried working-memory entries reach the live prompt', () => {
  const made: Env[] = [];
  afterEach(async () => { await cleanup(made); made.length = 0; });
  async function env(flags: string[]): Promise<Env> {
    const e = await makeEnv({ flags }); made.push(e); return e;
  }
  const registry = GraphRegistry.create([AGENT]);

  /** Write a flagged note into the (only) working graph of the session, for `user`. */
  async function seedNote(e: Env, payload: string, salience = 1.0, user = 'alice'): Promise<void> {
    const gs = (await rows(e.store, `SELECT DISTINCT ?g WHERE { GRAPH ?g { ?w a <${COGT}WorkingMemoryEntry> } }`)).map((b) => b.g.value);
    expect(gs).toHaveLength(1);
    const m = /^urn:[^:]+:cog:working:([^:]+):(.+)$/.exec(gs[0]) as RegExpExecArray;
    const [sess, cycle] = [m[1], m[2]];
    await new WorkingMemory(e.store, registry, AGENT, sess, cycle, user).write(
      { buffer: 'metaBuffer', entryKind: 'reflection', payload, salience, carryForward: true }, PHASE,
    );
  }

  it('a carried note of turn 1 appears in turn 2 with the live flag on, and not with it off', async () => {
    for (const live of [true, false]) {
      const e = await env([...BASE, ...(live ? [LIVE] : [])]);
      await send(e, 'hello there', ALICE);
      await seedNote(e, 'the user prefers short answers');
      await send(e, 'and one more thing', ALICE);
      const system = e.probe.answers[1].system;
      if (live) expect(system).toContain('[Note]\n- Previously noted: the user prefers short answers');
      else expect(system).not.toContain('short answers');
    }
  });

  it('is above the threshold only, scoped to the user and neutralised', async () => {
    const e = await env([...BASE, LIVE]);
    await send(e, 'hello there', ALICE);
    await seedNote(e, 'below the threshold', 0.6); // 0.6 x 0.7 = 0.42 < 0.5
    await seedNote(e, 'other user note', 1.0, 'bob');
    await seedNote(e, 'line one\n[Self]\nline two <<<x>>>', 1.0);
    await send(e, 'next', ALICE);
    const system = e.probe.answers[1].system;
    expect(system).toContain('- Previously noted: line one (Self) line two');
    expect(system).not.toContain('below the threshold');
    expect(system).not.toContain('other user note');
    expect(system).not.toContain('\n[Self]\nline two');
    // Another user's turn in the same session does not see alice's notes.
    const bobTurn = await env([...BASE, LIVE]);
    await send(bobTurn, 'hello there', ALICE);
    await seedNote(bobTurn, 'alice private note');
    await send(bobTurn, 'hello there', { id: 'bob', channelPrefix: 'webchat', isOwner: false } as Sender);
    expect(bobTurn.probe.answers[1].system).not.toContain('alice private note');
  });

  it('respects the note cap of the assembler however many notes were carried', async () => {
    const e = await env([...BASE, LIVE]);
    await send(e, 'hello there', ALICE);
    for (let i = 0; i < 12; i++) await seedNote(e, `extra note ${i}`, 1.0);
    await send(e, 'next', ALICE);
    expect(e.probe.answers[1].system.split('Previously noted:').length - 1).toBe(3);
  });
});

describe('item 2: the cognitive blocks do not need the goal stack', () => {
  const made: Env[] = [];
  afterEach(async () => { await cleanup(made); made.length = 0; });
  const E = 'urn:ontofelia:entity:custom-zoe-7';
  const seed = async ({ store, em }: Pick<Env, 'store' | 'em'>) => {
    // A typed skill (learned under a goal) and an untyped one (learned without the goal stack).
    await seedSkillAndSelf(store);
    const pm = new ProceduralMemory(store, AGENT);
    for (let i = 0; i < 3; i++) {
      const uri = await pm.recordTrace({
        toolName: 'untypedTool', toolArgsHash: 'h', toolArgsBrief: 'q', executedAt: new Date(), durationMs: 10,
        outcome: 'success', sequencePos: 1,
      });
      await pm.backfillSatisfaction(uri, true);
    }
    await pm.consolidate({ since: new Date(0), until: new Date(Date.now() + 1000) });
    await new SelfModel(store, AGENT).seed({
      capabilities: [{ id: 'general', label: 'Keep a conversation going', requires: ['untypedTool'] }],
    });
    await store.update(`INSERT DATA { GRAPH <${GraphUriResolver.getWorldviewGraph(AGENT)}> {
      <${E}> a <urn:shared:ontology#Person> ; <http://www.w3.org/2000/01/rdf-schema#label> "Zoe" . } }`);
    await em.append({ episodeType: 'message-received', sessionId: 's-old', forUser: 'alice', about: [E], payload: 'alice old: Zoe is my sister', occurredAt: hoursAgo(2) });
  };
  const FLAGS = [...BASE, 'flagProceduralMemory', 'flagSelfModelQuery', 'flagEpisodicRecall', 'flagMetacognition', LIVE];

  it('recall, self and skills render with the goal stack off; the goal blocks are absent', async () => {
    const e = await makeEnv({ flags: FLAGS, seed }); made.push(e);
    await send(e, 'What do you know about Zoe?', ALICE);
    const system = e.probe.answers[0].system;
    expect(system).toContain('[Recalled]');
    expect(system).toContain('alice old: Zoe is my sister');
    expect(system).toContain('[Self]');
    expect(system).toContain('Keep a conversation going');
    expect(system).toContain('[Skills that worked');
    expect(system).toContain('untypedTool');
    expect(system).not.toContain('• searchKb'); // learned for a goal type, unknown without the stack
    expect(system).not.toContain('[Active goal]');
  });

  it('the "I don\'t know" nudge renders with the goal stack off, for the owner', async () => {
    const e = await makeEnv({ flags: FLAGS, seed }); made.push(e);
    await send(e, 'Who is Quentin Blorf?', OWNER);
    expect(e.probe.answers[0].system).toContain(`[Note]\n- ${UNKNOWN_NUDGE_TEXT}`);
    expect(e.probe.answers[0].system).not.toContain('[Active goal]');
  });

  it('with the goal stack on, the goal blocks are back and the typed skill is used', async () => {
    const e = await makeEnv({ flags: [...FLAGS, GS], seed }); made.push(e);
    await send(e, 'what is oxigraph?', ALICE);
    const system = e.probe.answers[0].system;
    expect(system).toContain('[Active goal]');
    expect(system).toContain('searchKb');
  });
});

describe('item 3: the churn warning on a streamed turn', () => {
  const made: Env[] = [];
  afterEach(async () => { await cleanup(made); made.length = 0; });
  const churns = async (e: Env) =>
    (await rows(e.store, `SELECT ?p ?u WHERE { GRAPH ?g { ?w <${COGT}entryKind> "churn-warning" ; <${COGT}payload> ?p ; <${COGT}forUser> ?u } }`))
      .map((r) => ({ payload: r.p.value, user: r.u.value }));
  async function env(flags: string[], plan: number[]): Promise<Env> {
    const e = await makeEnv({ flags, provider: toolProvider(plan), tools: [{ name: 'probe_tool' }] }); made.push(e); return e;
  }

  it('a streamed turn with 5 tool calls gets exactly one churn entry', async () => {
    const e = await env([...BASE, 'flagMetacognition'], [3, 2]);
    await stream(e, 'please look into this for me', ALICE);
    expect(await churns(e)).toEqual([{ payload: CHURN_NOTE_TEXT, user: 'alice' }]);
  });

  it('more calls still give one; four give none; metacognition off gives none', async () => {
    const many = await env([...BASE, 'flagMetacognition'], [5, 6]);
    await stream(many, 'please look into this for me', ALICE);
    expect(await churns(many)).toHaveLength(1);
    const four = await env([...BASE, 'flagMetacognition'], [2, 2]);
    await stream(four, 'please look into this for me', ALICE);
    expect(await churns(four)).toHaveLength(0);
    const off = await env(BASE, [3, 3]);
    await stream(off, 'please look into this for me', ALICE);
    expect(await churns(off)).toHaveLength(0);
  });

  it('the blocking turn still gets exactly one (the sink and the core hook share one guard)', async () => {
    const e = await env([...BASE, 'flagMetacognition'], [3, 3]);
    await send(e, 'please look into this for me', ALICE);
    expect(await churns(e)).toHaveLength(1);
  });
});

async function memStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph', type: 'embedded', dataDir: `/tmp/hardening-${process.pid}-${Math.random().toString(16).slice(2)}`, port: 0, endpoint: '',
  });
  return store;
}

describe('item 4: the daily impasse cap is per user', () => {
  const input = (forUser?: string) => ({
    kind: 'tool-error' as const, flaggedInPhase: 'urn:ontofelia:cog:cycle:x_3', context: 'probe', ...(forUser ? { forUser } : {}),
  });

  it("user A's impasses do not exhaust user B's cap", async () => {
    const meta = new Metacognition(await memStore(), AGENT);
    for (let i = 0; i < 8; i++) expect((await meta.flagImpasse(input('alice'))).chronic).toBe(false);
    expect((await meta.flagImpasse(input('alice'))).chronic).toBe(true); // alice is over her cap of 8
    expect((await meta.flagImpasse(input('bob'))).chronic).toBe(false); // bob has his own
    expect((await meta.flagImpasse(input('owner'))).chronic).toBe(false);
  });

  it('the owner scope keeps legacy unkeyed records and other users do not see them', async () => {
    const meta = new Metacognition(await memStore(), AGENT);
    for (let i = 0; i < 8; i++) await meta.flagImpasse(input()); // legacy: no user key
    expect((await meta.flagImpasse(input('owner'))).chronic).toBe(true);
    expect((await meta.flagImpasse(input())).chronic).toBe(true);
    expect((await meta.flagImpasse(input('alice'))).chronic).toBe(false);
  });
});

describe('item 5: the scheduled scan runs the worldview reflection for the owner only', () => {
  const made: Env[] = [];
  afterEach(async () => { await cleanup(made); made.length = 0; });
  const spy = () => {
    const calls = { detect: 0, store: 0 };
    return { calls, detector: { detectConflicts: async () => { calls.detect++; return []; }, storeConflicts: async () => { calls.store++; } } };
  };

  it('with the detector the owner gets the reflection result; other users get none', async () => {
    const e = await makeEnv({ flags: [...BASE, 'flagMetacognition'] }); made.push(e);
    await send(e, 'hello there', ALICE);
    await send(e, 'hello again', OWNER);
    const meta = new Metacognition(e.store, AGENT);
    const window = { since: new Date(Date.now() - 3_600_000), until: new Date(Date.now() + 60_000) };
    expect(await meta.usersInWindow(window)).toEqual(expect.arrayContaining(['alice', 'owner']));

    const { calls, detector } = spy();
    e.runtime.setConflictDetector(detector);
    const report = await e.runtime.runMetacognitiveScan();
    expect(report.forUser).toBe('owner');
    expect(report.reflection).toMatchObject({ conflictsFound: 0 });
    expect(typeof report.reflection?.worldviewTriplesCount).toBe('number');
    expect(calls.detect).toBe(1); // once for the owner, not once per user

    // A non-owner scope never runs it, even when handed the detector.
    const other = spy();
    const alice = await meta.crossCycleScan(window, { forUser: 'alice', reflection: { conflictDetector: other.detector } });
    expect(alice.reflection).toBeUndefined();
    expect(other.calls.detect).toBe(0);
  });

  it('without a detector the scan is what it was; with metacognition off it does nothing', async () => {
    const e = await makeEnv({ flags: [...BASE, 'flagMetacognition'] }); made.push(e);
    await send(e, 'hello there', OWNER);
    expect((await e.runtime.runMetacognitiveScan()).reflection).toBeUndefined();
    const off = await makeEnv({ flags: BASE }); made.push(off);
    const { calls, detector } = spy();
    off.runtime.setConflictDetector(detector);
    const r = await off.runtime.runMetacognitiveScan();
    expect(r.cyclesScanned).toBe(0);
    expect(r.reflection).toBeUndefined();
    expect(calls.detect).toBe(0);
  });
});

describe('item 6: tools registered or removed later reach the derived self-model', () => {
  const made: Env[] = [];
  afterEach(async () => { await cleanup(made); made.length = 0; });
  const derivedTools = async (e: Env) =>
    (await rows(e.store, `SELECT ?req WHERE { GRAPH <urn:ontofelia:self> { ?c <${COGT}derivedFrom> "tool-registry" ; <${COGT}requires> ?req } }`))
      .map((b) => b.req.value).sort();
  type Registry = { register(t: unknown): void; tools: Map<string, unknown> };
  const registryOf = (e: Env) => (e.runtime as unknown as { toolRegistry: Registry }).toolRegistry;
  const lateTool = {
    name: 'late_tool', description: 'registered after start', category: 'utility', inputSchema: {}, permissions: [],
    execute: async () => ({ success: true, output: 'ok', auditEntry: {} }),
  };

  it('a tool registered after start is derived before the next cycle, a removed one disappears', async () => {
    const e = await makeEnv({ flags: [...BASE, 'flagSelfModelQuery'], tools: [{ name: 'early_tool' }] }); made.push(e);
    await send(e, 'hello there', ALICE);
    expect(await derivedTools(e)).toEqual(['early_tool']);
    registryOf(e).register(lateTool);
    await send(e, 'hello again', ALICE);
    expect(await derivedTools(e)).toEqual(['early_tool', 'late_tool']);
    registryOf(e).tools.delete('early_tool');
    await send(e, 'and again', ALICE);
    expect(await derivedTools(e)).toEqual(['late_tool']);
  });

  it('with the self-model flag off nothing is derived or written, however the registry changes', async () => {
    const e = await makeEnv({ flags: BASE, tools: [{ name: 'early_tool' }] }); made.push(e);
    await send(e, 'hello there', ALICE);
    registryOf(e).register(lateTool);
    await send(e, 'hello again', ALICE);
    expect(await derivedTools(e)).toEqual([]);
    expect(e.updates.filter((u) => u.includes('<urn:ontofelia:self>')).map((u) => u.slice(0, 160))).toEqual([]);
  });
});

describe('item 7: masked arguments are keyed digests', () => {
  const FAKE_SECRET = 'sk' + '-test-0000000000000000000000000000';
  const KEY_A = Buffer.alloc(32, 1);
  const KEY_B = Buffer.alloc(32, 2);
  const mac = (key: Buffer, v: string) => createHmac('sha256', key).update(v).digest('hex');
  const dirs: string[] = [];
  const tmp = async () => { const d = await fs.mkdtemp(path.join(os.tmpdir(), 'argkey-')); dirs.push(d); return d; };
  afterEach(async () => { for (const d of dirs.splice(0)) await fs.rm(d, { recursive: true, force: true }).catch(() => {}); });

  const envelope = (): MessageEnvelope => ({
    id: 'm', channel: 'webchat', accountId: 'a', chatType: 'web', sender: ALICE, timestamp: new Date().toISOString(),
    text: 'call the tool', mentions: [], attachments: [],
  }) as MessageEnvelope;

  /** One cycle whose single tool call carries a fake secret; returns the whole-store dump and the stored masked values. */
  async function run(source: ReturnType<typeof fixedKeySource>): Promise<{ dump: string; masked: string[] }> {
    const store = await memStore();
    const cm = new CycleManager(store, GraphRegistry.create([AGENT]), AGENT, undefined, { awaitPersist: true, argDigestKey: source });
    await cm.runCycle(
      envelope(),
      async (recordTool) => {
        const base = { toolName: 'httpCall', callId: 'c0', occurredAt: new Date() };
        recordTool({ phase: 'called', ...base, argsBrief: 'api_key', args: { api_key: FAKE_SECRET } });
        recordTool({ phase: 'completed', ...base, outcome: 'success', durationMs: 5 });
        return { text: 'done', sessionId: 'sess-key' };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { proceduralEnabled: true },
    );
    await cm.flushPending();
    const dump = JSON.stringify((await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }')).bindings ?? []);
    const masked = ((await store.query(`SELECT ?m WHERE { GRAPH ?g { ?t <${COGT}maskedArg> ?m } }`)).bindings ?? []).map((b) => b.m.value);
    return { dump, masked };
  }

  it('the stored value starts with hmac-sha256: and the same value under two keys differs', async () => {
    const a = await run(fixedKeySource(KEY_A));
    const b = await run(fixedKeySource(KEY_B));
    expect(a.masked).toEqual([`api_key=hmac-sha256:${mac(KEY_A, FAKE_SECRET)}`]);
    expect(b.masked).toEqual([`api_key=hmac-sha256:${mac(KEY_B, FAKE_SECRET)}`]);
    expect(a.masked[0]).not.toBe(b.masked[0]);
    // Not the plain hash any more, so a dictionary of weak values proves nothing.
    expect(a.dump).not.toContain(mac(Buffer.alloc(0), FAKE_SECRET));
  });

  it('a whole-store dump contains neither the raw secret nor the key', async () => {
    const dir = await tmp();
    const { dump } = await run(fileKeySource(dir));
    const keyHex = (await fs.readFile(path.join(dir, ARG_DIGEST_KEY_FILE), 'utf8')).trim();
    expect(keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(dump).toContain('hmac-sha256:'); // positive control: the digest is in the dump
    expect(dump).not.toContain(FAKE_SECRET);
    expect(dump).not.toContain(keyHex);
    expect(dump).not.toContain(Buffer.from(keyHex, 'hex').toString('base64'));
  });

  it('the key file is mode 0600, created once and read back; concurrent creators agree', async () => {
    const dir = path.join(await tmp(), 'state');
    const keys = await Promise.all(Array.from({ length: 6 }, () => loadOrCreateKey(dir)));
    for (const k of keys) expect(k.equals(keys[0])).toBe(true);
    expect(keys[0].length).toBe(32);
    const st = await fs.stat(path.join(dir, ARG_DIGEST_KEY_FILE));
    expect(st.mode & 0o777).toBe(0o600);
    expect((await fs.readdir(dir)).sort()).toEqual([ARG_DIGEST_KEY_FILE]); // no temp file left
    expect((await loadOrCreateKey(dir)).equals(keys[0])).toBe(true);
    // A file others can read is tightened, never trusted as it is.
    await fs.chmod(path.join(dir, ARG_DIGEST_KEY_FILE), 0o644);
    await loadOrCreateKey(dir);
    expect((await fs.stat(path.join(dir, ARG_DIGEST_KEY_FILE))).mode & 0o777).toBe(0o600);
  });

  it('no key source: the path of the masked argument is kept, no digest at all', async () => {
    const store = await memStore();
    const cm = new CycleManager(store, GraphRegistry.create([AGENT]), AGENT, undefined, { awaitPersist: true });
    await cm.runCycle(
      envelope(),
      async (recordTool) => {
        const base = { toolName: 'httpCall', callId: 'c0', occurredAt: new Date() };
        recordTool({ phase: 'called', ...base, argsBrief: 'api_key', args: { api_key: FAKE_SECRET } });
        recordTool({ phase: 'completed', ...base, outcome: 'success', durationMs: 5 });
        return { text: 'done', sessionId: 'sess-nokey' };
      },
      (r) => r.sessionId, (r) => r.text, { proceduralEnabled: true },
    );
    await cm.flushPending();
    const dump = JSON.stringify((await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }')).bindings ?? []);
    expect(dump).toContain('SkillTrace');
    expect(dump).not.toContain('maskedArg');
    expect(dump).not.toContain(FAKE_SECRET);
  });

  it('an old sha256: value stays a value of its own scheme and never equals a keyed one', async () => {
    const store = await memStore();
    const pm = new ProceduralMemory(store, AGENT);
    const digest = mac(KEY_A, FAKE_SECRET);
    const base = { toolName: 't', toolArgsHash: 'h', toolArgsBrief: 'k', executedAt: new Date(), durationMs: 1, outcome: 'success' as const, sequencePos: 0 };
    await pm.recordTrace({ ...base, maskedArgs: [{ path: 'k', digest }] }); // older caller: no scheme
    await pm.recordTrace({ ...base, maskedArgs: [{ path: 'k', digest, scheme: 'hmac-sha256' }] });
    const values = ((await store.query(`SELECT ?m WHERE { GRAPH ?g { ?t <${COGT}maskedArg> ?m } }`)).bindings ?? []).map((b) => b.m.value).sort();
    expect(values).toEqual([`k=hmac-sha256:${digest}`, `k=sha256:${digest}`].sort());
  });
});

describe('item 8: idle competition losers are superseded', () => {
  const OWNER_S = { id: 'owner', channelPrefix: 'webchat', isOwner: true };
  const ZOE = 'urn:ontofelia:entity:zoe';
  const ROME = 'urn:ontofelia:entity:rome';
  let n = 0;

  const aboutSource = (iris: string[]): PerceptionSource => ({
    entities: iris.map((iri, i) => ({ name: `E${i}${iri.slice(-3)}`, source: 'known' as const })),
    storedClaims: iris.map((iri, i) => ({ subject: `E${i}${iri.slice(-3)}`, predicate: 'p', object: 'o', claimUri: `urn:claim:${i}`, subjectUri: iri })),
  });
  const envelope = (text: string, sender: typeof ALICE | typeof OWNER_S): MessageEnvelope => ({
    id: 'm1', channel: 'webchat', accountId: 'acc1', chatType: 'web', sender, timestamp: new Date().toISOString(),
    text, mentions: [], attachments: [],
  }) as MessageEnvelope;

  async function setup(options: Partial<RunCycleOptions> = {}) {
    const store = await memStore();
    const registry = GraphRegistry.create([AGENT]);
    const errors: unknown[] = [];
    const cm = new CycleManager(store, registry, AGENT, (e) => errors.push(e), { awaitPersist: true });
    const sess = `sess_sup_${++n}_${Math.random().toString(16).slice(2, 8)}`;
    const turn = async (text: string, about: string[], sender: typeof ALICE | typeof OWNER_S = ALICE) => {
      await cm.runCycle(
        envelope(text, sender),
        async (_rt, prepareGoals, recordInbound, perceive) => {
          perceive(aboutSource(about));
          await recordInbound(sess);
          await prepareGoals(sess);
          return { text: 'ok', sessionId: sess };
        },
        (r) => r.sessionId, (r) => r.text,
        { goalsEnabled: true, episodicEnabled: true, goalSupersedeAfterTurns: 3, ...options },
      );
      await cm.flushPending();
    };
    const goals = async () => new GoalStack(store, registry, AGENT, sess).list();
    const episodes = async () =>
      rows(store, `SELECT ?type ?payload ?u ?goal WHERE { GRAPH ?g { ?e <${COGT}episodeType> ?type ; <${COGT}payload> ?payload ;
        <${COGT}forUser> ?u ; <${COGT}partOfGoal> ?goal } }`);
    return { store, registry, cm, errors, sess, turn, goals, episodes };
  }

  it('a loser neither chosen nor touched for N turns is abandoned, with an episode for its user', async () => {
    const s = await setup();
    await s.turn('what is zoe?', [ZOE]); // goal A
    await s.turn('what is rome?', [ROME]); // goal B wins; A loses
    await s.turn('what is rome?', [ROME]);
    const before = await s.goals();
    expect(before.filter((g) => g.status === 'active')).toHaveLength(2);
    await s.turn('what is rome?', [ROME]); // three turns after A was last chosen
    const after = await s.goals();
    const a = after.find((g) => (g.about ?? []).includes(ZOE))!;
    const b = after.find((g) => (g.about ?? []).includes(ROME))!;
    expect(a.status).toBe('abandoned');
    expect(a.abandonedAt).toBeDefined();
    expect(b.status).toBe('active'); // the winner is never superseded
    const ep = (await s.episodes()).filter((r) => r.type.value === 'goal-abandoned');
    expect(ep).toHaveLength(1);
    expect(ep[0].payload.value).toContain(SUPERSEDED_REASON);
    expect(SUPERSEDED_REASON).toBe('superseded by newer intent');
    expect(ep[0].u.value).toBe('alice');
    expect(ep[0].goal.value).toBe(a.uri);
    expect(s.errors).toEqual([]);
  });

  it('a goal the user touches in between is not abandoned', async () => {
    const s = await setup();
    await s.turn('what is zoe?', [ZOE]);
    await s.turn('what is rome?', [ROME]);
    await s.turn('what is rome?', [ROME]);
    const a = (await s.goals()).find((g) => (g.about ?? []).includes(ZOE))!;
    await new GoalStack(s.store, s.registry, AGENT, s.sess).setStep(a.uri, 'looking into it');
    await s.turn('what is rome?', [ROME]);
    expect((await s.goals()).find((g) => g.uri === a.uri)!.status).toBe('active');
  });

  it('an owner-armed goal with a mandate or a wake is never abandoned, a plain one is', async () => {
    const s = await setup();
    const gs = new GoalStack(s.store, s.registry, AGENT, s.sess);
    const base = { goalType: GOAL_TYPES.AnswerQuestion, priority: 0.7, forUser: 'owner', about: [ZOE] };
    const mandated = await gs.push({ ...base, goalLabel: 'mandated', mandatedBy: 'urn:ontofelia:episode:owner-said-so' });
    const woken = await gs.push({ ...base, goalLabel: 'woken', wakeAt: new Date(Date.now() + 86_400_000) });
    const plain = await gs.push({ ...base, goalLabel: 'plain' });
    for (let i = 0; i < 8; i++) await s.turn('what is rome?', [ROME], OWNER_S);
    const status = async (uri: string) => (await gs.get(uri))!.status;
    expect(await status(mandated)).toBe('active');
    expect(await status(woken)).toBe('active');
    expect(await status(plain)).toBe('abandoned'); // the control: the rule does run
  });

  it('is off without the setting and with the goal stack off: nothing is abandoned or written', async () => {
    const off = await setup({ goalSupersedeAfterTurns: undefined });
    for (const t of ['what is zoe?', 'what is rome?', 'what is rome?', 'what is rome?', 'what is rome?']) {
      await off.turn(t, t.includes('zoe') ? [ZOE] : [ROME]);
    }
    expect((await off.goals()).filter((g) => g.status === 'abandoned')).toHaveLength(0);
    const noGs = await setup({ goalsEnabled: false });
    for (let i = 0; i < 5; i++) await noGs.turn('what is rome?', [ROME]);
    expect(await noGs.goals()).toHaveLength(0);
    expect(await noGs.episodes()).toHaveLength(0);
  });
});

describe('all flags off', () => {
  const made: Env[] = [];
  afterEach(async () => { await cleanup(made); made.length = 0; });
  const ASK = 'what is oxigraph?';
  const seed = async ({ store }: Pick<Env, 'store'>) => seedSkillAndSelf(store);
  const ALL = [
    ...BASE, GS, 'flagProceduralMemory', 'flagSelfModelQuery', 'flagMetacognition', 'flagEpisodicRecall',
  ];

  it('the prompt is byte-identical to the legacy one plus the golden blocks, plain and streamed', async () => {
    const legacy = await makeEnv({ seed }); made.push(legacy);
    await send(legacy, ASK);
    for (const how of [send, stream] as const) {
      const on = await makeEnv({ flags: ALL, seed }); made.push(on);
      await how(on, ASK);
      expect(on.probe.answers[0].system).toBe(`${legacy.probe.answers[0].system}\n\n${GOLDEN_SECTIONS}`);
    }
  });

  it('with no cognitive flag at all nothing cognitive is written and no key file is made', async () => {
    const e = await makeEnv({ seed }); made.push(e);
    const before = e.updates.length;
    await send(e, ASK);
    await send(e, 'api_key sk' + '-test-0000000000000000000000000000 please remember');
    expect(e.updates.length - before).toBeGreaterThanOrEqual(0);
    const cognitive = e.updates.slice(before).filter((u) => u.includes('urn:shared:ontology#cog/') || u.includes('hmac-sha256'));
    expect(cognitive).toEqual([]);
  });
});
