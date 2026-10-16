import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphRegistry, GraphUriResolver } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter, MessageEnvelope } from '@ontofelia/core';
import { CycleManager, type RunCycleOptions } from '../cognitive/CycleManager.js';
import { WorkingMemory } from '../cognitive/WorkingMemory.js';
import type { PerceptionSource } from '../cognitive/Perception.js';
import { makeEnv, cleanup, setNumber, type Env } from './promptHarness.js';

// Attention and carry-over (docs/cognitive-architecture/04 §6-§7, 07 §6): carry
// into the next cycle of the same session and user, goal-steered salience,
// the wm-overflow impasse and the configurable capacity. Embedded Oxigraph.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const PHASE = 'urn:ontofelia:cog:phase:test';
const ALICE = { id: 'alice', channelPrefix: 'webchat', isOwner: false };
const BOB = { id: 'bob', channelPrefix: 'webchat', isOwner: false };
type Sender = typeof ALICE;
const ZOE = 'urn:ontofelia:entity:zoe';
const ROME = 'urn:ontofelia:entity:rome';
const ATTN = { theta: 0.5, capacity: 200 };

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/attn-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

const envelope = (text: string, sender: Sender = ALICE): MessageEnvelope =>
  ({
    id: 'm1', channel: 'webchat', accountId: 'acc1', chatType: 'web', sender,
    timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
  }) as MessageEnvelope;

const aboutSource = (iris: string[]): PerceptionSource => ({
  entities: iris.map((iri, i) => ({ name: `E${i}${iri.slice(-3)}`, source: 'known' as const })),
  storedClaims: iris.map((iri, i) => ({
    subject: `E${i}${iri.slice(-3)}`, predicate: 'p', object: 'o', claimUri: `urn:claim:${i}`, subjectUri: iri,
  })),
});

describe('attention and carry-over in the cycle', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let cm: CycleManager;
  let n = 0;
  let sess: string;
  const errors: unknown[] = [];

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    cm = new CycleManager(store, registry, AGENT, (e) => errors.push(e), { awaitPersist: true });
    sess = `sess_at_${++n}_${Math.random().toString(16).slice(2, 8)}`;
    errors.length = 0;
  });

  async function turn(
    text: string,
    o: { sender?: Sender; about?: string[]; options?: RunCycleOptions; session?: string } = {},
  ): Promise<void> {
    const s = o.session ?? sess;
    await cm.runCycle(
      envelope(text, o.sender),
      async (_rt, prepareGoals, recordInbound, perceive) => {
        perceive(aboutSource(o.about ?? []));
        await recordInbound(s);
        await prepareGoals(s);
        return { text: 'ok', sessionId: s };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { episodicEnabled: true, attention: ATTN, ...o.options },
    );
    await cm.flushPending();
  }

  /** Working graphs of a session, oldest first. */
  async function graphs(s = sess): Promise<string[]> {
    const prefix = `urn:${AGENT}:cog:working:${s}:`;
    const res = await store.query(`SELECT DISTINCT ?g WHERE { GRAPH ?g { ?e a <${COGT}WorkingMemoryEntry> ;
      <${COGT}writtenAt> ?t } FILTER(STRSTARTS(STR(?g), "${prefix}")) }`);
    const gs = (res.bindings ?? []).map((b) => b.g.value);
    const times = new Map<string, number>();
    for (const g of gs) {
      const r = await store.query(`SELECT ?t WHERE { GRAPH <${g}> { ?e <${COGT}writtenAt> ?t } } ORDER BY ASC(?t) LIMIT 1`);
      // The store drops trailing zeros of the fraction ("41.4Z" for .400), so
      // the strings do not sort as time: compare the parsed instants.
      times.set(g, Date.parse(r.bindings?.[0]?.t?.value ?? ''));
    }
    return gs.sort((a, b) => times.get(a)! - times.get(b)!);
  }
  const cycleOf = (g: string) => g.slice(`urn:${AGENT}:cog:working:${sess}:`.length);
  const wmFor = (cycle: string, user = 'alice', s = sess) =>
    new WorkingMemory(store, registry, AGENT, s, cycle, user);

  /** Seed a carry-eligible entity entry into the newest cycle graph. */
  async function seedStale(user = 'alice', salience = 1.0): Promise<string> {
    const gs = await graphs();
    return wmFor(cycleOf(gs[gs.length - 1]), user).write(
      { buffer: 'retrievalBuffer', entryKind: 'fact', payload: 'stale', salience, refersTo: ROME, carryForward: true },
      PHASE,
    );
  }
  const carriedIn = async (cycle: string, user = 'alice') =>
    (await wmFor(cycle, user).read()).filter((e) => e.carriedFrom !== undefined);

  it('the second turn of a session shows carriedFrom links to the first cycle', async () => {
    await turn('hello');
    const seeded = await seedStale();
    await turn('and again');
    const gs = await graphs();
    expect(gs).toHaveLength(2);
    const carried = await carriedIn(cycleOf(gs[1]));
    expect(carried).toHaveLength(1);
    expect(carried[0].carriedFrom).toBe(seeded);
    expect(carried[0].payload).toBe('stale');
    expect(carried[0].refersTo).toBe(ROME);
    expect(errors).toEqual([]);
  });

  it('a stale entity entry decays across three cycles with exact values', async () => {
    await turn('hello');
    await seedStale('alice', 1.0);
    const seen: number[] = [];
    for (const t of ['two', 'three', 'four']) {
      await turn(t);
      const gs = await graphs();
      const [e] = await carriedIn(cycleOf(gs[gs.length - 1]));
      seen.push(e.salience);
    }
    // carry x0.7 then the stale-entity damping x0.7, per cycle
    expect(seen).toEqual([0.49, 0.2401, 0.117649]);
    await turn('five'); // 0.117649 x 0.49 = 0.057648 is below the 0.1 floor: dropped
    const gs = await graphs();
    expect(await carriedIn(cycleOf(gs[gs.length - 1]))).toHaveLength(0);
    expect(errors).toEqual([]);
  });

  it('the previous working graph is marked closed, not deleted', async () => {
    await turn('hello');
    await turn('again');
    const gs = await graphs();
    const closed = async (g: string) =>
      (await store.query(`SELECT ?t WHERE { GRAPH <${g}> { <${g}> <${COGT}closedAt> ?t } }`)).bindings ?? [];
    expect(await closed(gs[0])).toHaveLength(1);
    expect(await closed(gs[1])).toHaveLength(0);
    expect((await wmFor(cycleOf(gs[0])).read()).length).toBeGreaterThan(0);
  });

  it('boosts entries about the active goal entities by 0.2', async () => {
    await turn('what is zoe?', { about: [ZOE], options: { goalsEnabled: true } });
    const control = `${sess}_c`;
    await turn('what is zoe?', { about: [ZOE], session: control }); // goals off: no boost
    const ner = async (s: string) => {
      const gs = await graphs(s);
      const es = await wmFor(gs[0].slice(`urn:${AGENT}:cog:working:${s}:`.length), 'alice', s).read();
      return es.find((e) => e.entryKind === 'ner-result' && e.refersTo === ZOE)!.salience;
    };
    expect(await ner(control)).toBe(0.7);
    expect(await ner(sess)).toBe(0.9);
  });

  it('never carries across users or sessions', async () => {
    await turn('hello'); // alice
    await seedStale('alice');
    await turn('hi from bob', { sender: BOB }); // same session, other user
    await turn('other session', { session: `${sess}_x` }); // same user, other session
    const gs = await graphs();
    for (const g of gs) expect(await carriedIn(cycleOf(g), 'bob')).toHaveLength(0);
    expect(await carriedIn(cycleOf(gs[1]))).toHaveLength(0);
    const other = await graphs(`${sess}_x`);
    const es = await wmFor(other[0].slice(`urn:${AGENT}:cog:working:${sess}_x:`.length), 'alice', `${sess}_x`).read();
    expect(es.some((e) => e.carriedFrom !== undefined)).toBe(false);
    // alice's own next turn in the session does carry
    await turn('alice again');
    const all = await graphs();
    const aliceLast = all[all.length - 1];
    expect((await carriedIn(cycleOf(aliceLast))).map((e) => e.forUser)).toEqual(['alice']);
    expect(errors).toEqual([]);
  });

  it('raises exactly one wm-overflow impasse per cycle even with several drops', async () => {
    const tight = { theta: 0.5, capacity: 1 };
    const impasses = async () =>
      (await store.query(`SELECT ?i ?u WHERE { GRAPH <${GraphUriResolver.getCogMetaGraph(AGENT)}> {
        ?i <${COGT}impasseKind> "wm-overflow" . OPTIONAL { ?i <${COGT}forUser> ?u } } }`)).bindings ?? [];
    await turn('first', { options: { metacognitionEnabled: true, attention: tight } });
    // message-text 1.0, sender 0.9 and intent 0.8 compete for one slot: >= 2 drops above 0.7
    const first = await impasses();
    expect(first).toHaveLength(1);
    expect(first[0].u.value).toBe('alice');
    await turn('second', { options: { metacognitionEnabled: true, attention: tight } });
    expect(await impasses()).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('raises no overflow impasse with metacognition off or inside the capacity', async () => {
    const count = async () =>
      (await store.query(`SELECT ?i WHERE { GRAPH <${GraphUriResolver.getCogMetaGraph(AGENT)}> {
        ?i <${COGT}impasseKind> "wm-overflow" } }`)).bindings?.length ?? 0;
    await turn('a', { options: { attention: { theta: 0.5, capacity: 1 } } });
    await turn('b', { options: { metacognitionEnabled: true } });
    expect(await count()).toBe(0);
  });

  it('without the attention option nothing is carried, boosted or closed', async () => {
    const plain = { options: { attention: undefined } };
    await turn('hello', plain);
    await seedStale();
    await turn('again', plain);
    const gs = await graphs();
    expect(await carriedIn(cycleOf(gs[1]))).toHaveLength(0);
    const closed = await store.query(`SELECT ?t WHERE { GRAPH <${gs[0]}> { <${gs[0]}> <${COGT}closedAt> ?t } }`);
    expect(closed.bindings ?? []).toHaveLength(0);
  });
});

describe('WorkingMemory attention primitives', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
  });

  it('carries goal entries of live goals only, with refersTo kept', async () => {
    const wm = new WorkingMemory(store, registry, AGENT, 's1', 'c1', 'alice');
    const live = 'urn:ontofelia:goal:live';
    await wm.write({ buffer: 'goalBuffer', entryKind: 'goal-active', payload: 'live goal', salience: 1, forGoal: live }, PHASE);
    await wm.write({ buffer: 'goalBuffer', entryKind: 'goal-active', payload: 'done goal', salience: 1, forGoal: 'urn:ontofelia:goal:done' }, PHASE);
    expect(await wm.carryForward('c2', { liveGoals: new Set([live]) })).toBe(1);
    const next = await new WorkingMemory(store, registry, AGENT, 's1', 'c2', 'alice').read();
    expect(next.map((e) => e.payload)).toEqual(['live goal']);
    expect(next[0].salience).toBe(0.7);
  });

  it('does not copy an entry the target cycle already holds', async () => {
    const wm = new WorkingMemory(store, registry, AGENT, 's1', 'c1', 'alice');
    const next = new WorkingMemory(store, registry, AGENT, 's1', 'c2', 'alice');
    await wm.write({ buffer: 'selfBuffer', entryKind: 'capability', payload: 'can x', salience: 0.8 }, PHASE);
    await next.write({ buffer: 'selfBuffer', entryKind: 'capability', payload: 'can x', salience: 0.8 }, PHASE);
    expect(await wm.carryForward('c2')).toBe(0);
  });

  it('carries only entries of its own user', async () => {
    const a = new WorkingMemory(store, registry, AGENT, 's1', 'c1', 'alice');
    const b = new WorkingMemory(store, registry, AGENT, 's1', 'c1', 'bob');
    await a.write({ buffer: 'selfBuffer', entryKind: 'capability', payload: 'alice only', salience: 1 }, PHASE);
    await b.write({ buffer: 'selfBuffer', entryKind: 'capability', payload: 'bob only', salience: 1 }, PHASE);
    expect(await a.carryForward('c2')).toBe(1);
    const next = await new WorkingMemory(store, registry, AGENT, 's1', 'c2').read();
    expect(next.map((e) => e.payload)).toEqual(['alice only']);
  });

  it('boost is capped at 1.0 and a refreshed or goal-kept carried entry is not damped', async () => {
    const wm = new WorkingMemory(store, registry, AGENT, 's1', 'c1', 'alice');
    await wm.write({ buffer: 'perceptionBuffer', entryKind: 'ner-result', payload: 'zoe', salience: 0.95, refersTo: ZOE }, PHASE);
    await wm.write({ buffer: 'retrievalBuffer', entryKind: 'fact', payload: 'kept', salience: 0.5, refersTo: ROME, carryForward: true }, PHASE);
    await wm.carryForward('c2');
    const next = new WorkingMemory(store, registry, AGENT, 's1', 'c2', 'alice');
    await next.write({ buffer: 'perceptionBuffer', entryKind: 'ner-result', payload: 'zoe', salience: 0.95, refersTo: ZOE }, PHASE);
    const rep = await next.attend({ boostEntities: new Set([ZOE]), keepEntities: new Set([ROME]), theta: 0.5 });
    const es = await next.read();
    expect(es.find((e) => e.payload === 'zoe')!.salience).toBe(1);
    expect(es.find((e) => e.payload === 'kept')!.salience).toBe(0.35); // carry only, no damping
    expect(rep).toEqual({ boosted: 1, damped: 0, dropped: 0 });
  });

  it('the drop floor is min(0.1, theta)', async () => {
    const wm = new WorkingMemory(store, registry, AGENT, 's1', 'c1', 'alice');
    await wm.write({ buffer: 'retrievalBuffer', entryKind: 'fact', payload: 'low', salience: 0.2, refersTo: ROME, carryForward: true }, PHASE);
    await wm.carryForward('c2'); // 0.14
    const next = new WorkingMemory(store, registry, AGENT, 's1', 'c2', 'alice');
    // damped to 0.098: below 0.1 so dropped, but kept when theta is 0.05
    const keepLow = await next.attend({ boostEntities: new Set(), keepEntities: new Set(), theta: 0.05 });
    expect(keepLow.dropped).toBe(0);
    expect((await next.read())[0].salience).toBe(0.098);
  });

  it('capacity is configurable and reports every drop', async () => {
    const drops: number[] = [];
    const wm = new WorkingMemory(store, registry, AGENT, 's1', 'c1', 'alice', {
      capacity: 2,
      onDrop: (d) => drops.push(d.salience),
    });
    for (const s of [0.9, 0.8, 0.3, 0.75]) {
      await wm.write({ buffer: 'perceptionBuffer', entryKind: 'x', payload: `p${s}`, salience: s }, PHASE);
    }
    expect(drops.sort()).toEqual([0.3, 0.75]);
    expect((await wm.read()).map((e) => e.salience).sort()).toEqual([0.8, 0.9]);
  });
});

describe('attention settings from the setup graph', () => {
  const made: Env[] = [];
  it('default to theta 0.5 and capacity 200 and ignore invalid values', async () => {
    const e = await makeEnv(); made.push(e);
    expect(await e.cfg.attentionSettings()).toEqual({ theta: 0.5, capacity: 200 });
    await setNumber(e.store, 'salienceThreshold', 0.6);
    await setNumber(e.store, 'workingMemoryCapacity', 50);
    expect(await e.cfg.attentionSettings()).toEqual({ theta: 0.6, capacity: 50 });
    await e.store.update(`DELETE WHERE { GRAPH ?g { ?s <${COGT}workingMemoryCapacity> ?o } }`);
    await setNumber(e.store, 'workingMemoryCapacity', 0);
    expect(await e.cfg.attentionSettings()).toEqual({ theta: 0.6, capacity: 200 });
    await cleanup(made);
  });
});
