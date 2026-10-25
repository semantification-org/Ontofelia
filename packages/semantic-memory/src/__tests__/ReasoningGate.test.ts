/**
 * Reasoning gate: above an owner-set ABox size, `storeFact` skips the
 * synchronous OWL materialisation, marks the inferred graphs stale and a
 * catch-up rebuilds them. Off by default.
 *
 * Real round-trips on the embedded OxigraphAdapter and the native reasoner.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { inferTriples } from '@ontofelia/reasoner';
import { createOxigraphTestAdapter, type OxigraphTestAdapter } from './helpers/oxigraphTestAdapter.js';
import { KnowledgeEngine, type EngineLogger } from '../KnowledgeEngine.js';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import {
  REASONING_NS, reasoningSettingsSubject, readAsyncThreshold, countTriples,
} from '../reasoning/ReasoningGate.js';
import type { FactInput, FactContext } from '../types.js';

const AGENT = 'ontofelia';
const CORE = 'urn:ontofelia:core#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_SUBPROP = 'http://www.w3.org/2000/01/rdf-schema#subPropertyOf';
const ONTOLOGY = 'urn:shared:ontology';
const SETUP = GraphUriResolver.getSetupGraph(AGENT);
const WORLDVIEW = GraphUriResolver.getWorldviewGraph(AGENT);
const SHARED_INF = GraphUriResolver.getInferredGraph(AGENT);
const BOB_GRAPH = GraphUriResolver.getUserGraph(AGENT, 'bob');
const BOB_INF = GraphUriResolver.getUserInferredGraph(AGENT, 'bob');
const STALE = `${REASONING_NS}inferredStale`;
const THRESHOLD = `${REASONING_NS}asyncThreshold`;

const here = dirname(fileURLToPath(import.meta.url));
const CORE_TTL = readFileSync(join(here, '..', 'ontologies', 'ontofelia-core.ttl'), 'utf8');

const ownerCtx: FactContext = { agentId: AGENT, userId: 'owner', sessionId: 's', isOwner: true };
const bobCtx: FactContext = { agentId: AGENT, userId: 'bob', sessionId: 's', isOwner: false };

interface Rig {
  store: OxigraphTestAdapter;
  engine: KnowledgeEngine;
  logger: EngineLogger & { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  materialize: ReturnType<typeof vi.fn>;
}

/** A fresh store with the core TBox plus the custom hierarchy the tests infer over. */
async function makeRig(): Promise<Rig> {
  const store = createOxigraphTestAdapter();
  await store.initialize({
    backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'rg-')), port: 0, endpoint: '',
  });
  await store.putGraph(ONTOLOGY, CORE_TTL, 'turtle');
  await store.update(`INSERT DATA { GRAPH <${ONTOLOGY}> {
    <${CORE}likes> <${RDFS_SUBPROP}> <${CORE}enjoys> .
    <${CORE}livesIn> <${RDFS_SUBPROP}> <${CORE}residesIn> .
    <${CORE}mentors> <${OWL}inverseOf> <${CORE}mentoredBy> .
  } }`);
  const engine = new KnowledgeEngine(store as never);
  const logger = { info: vi.fn(), warn: vi.fn() };
  engine.setLogger(logger);
  // Spy without replacing: the real reasoner still runs.
  const reasoner = (engine as unknown as { reasoner: { materialize: (...a: unknown[]) => unknown } }).reasoner;
  const materialize = vi.spyOn(reasoner, 'materialize') as unknown as ReturnType<typeof vi.fn>;
  return { store, engine, logger, materialize };
}

async function setThreshold(store: OxigraphTestAdapter, value: string | number | null): Promise<void> {
  const subject = reasoningSettingsSubject(AGENT);
  await store.update(`DELETE WHERE { GRAPH <${SETUP}> { <${subject}> <${THRESHOLD}> ?v } }`);
  if (value !== null) {
    await store.update(`INSERT DATA { GRAPH <${SETUP}> { <${subject}> <${THRESHOLD}> "${value}" } }`);
  }
}

async function graphRows(store: OxigraphTestAdapter, graph: string): Promise<string[]> {
  const r = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  return (r.bindings ?? []).map(b => `${b.s.value} | ${b.p.value} | ${b.o.value}`).sort();
}

async function markerRows(store: OxigraphTestAdapter): Promise<string[]> {
  const r = await store.query(`SELECT ?v WHERE { GRAPH <${SETUP}> { ?s <${STALE}> ?v } }`);
  return (r.bindings ?? []).map(b => b.v.value);
}

const fact = (subject: string, predicate: string, object: string, objectType?: string): FactInput => ({
  subject, predicate, object, ...(objectType ? { objectType } : {}), sourceKind: 'user',
});

/**
 * Facts whose entities are typed with a class the TBox says nothing about
 * (`Widget`). `storeFact` writes the type assertion of a new entity directly,
 * without materialising it, so on-write materialisation never records what a
 * type like `Person` or `Place` implies (`X a Entity`); see the "typed
 * entities" test. A neutral class keeps that out of the comparison, and the
 * property axioms do the inferring: domain/range (Person, Place, Entity),
 * subproperty (livesIn -> residesIn), symmetric (knows), transitive
 * (locatedIn, partOf) and inverse (mentors -> mentoredBy).
 */
const WORLD_FACTS: FactInput[] = [
  fact('Anna', 'livesIn', 'Hamburg', 'Widget'),
  fact('Anna', 'knows', 'Tom', 'Widget'),
  fact('Hamburg', 'locatedIn', 'Germany', 'Widget'),
  fact('Germany', 'locatedIn', 'Europe', 'Widget'),
  fact('Europe', 'partOf', 'Earth', 'Widget'),
  fact('Tom', 'mentors', 'Lena', 'Widget'),
  fact('Lena', 'worksAt', 'Acme', 'Widget'),
].map(f => ({ ...f, subjectType: 'Widget' }));

describe('settings', () => {
  let rig: Rig;
  beforeEach(async () => { rig = await makeRig(); });

  it.each([
    [null, 0],
    ['0', 0],
    ['-5', 0],
    ['abc', 0],
    ['1.5', 0],
    ['', 0],
    ['1', 1],
    ['5000', 5000],
  ])('asyncThreshold %j reads as %j', async (value, expected) => {
    await setThreshold(rig.store, value);
    expect(await readAsyncThreshold(rig.store as unknown as TriplestoreAdapter, AGENT)).toBe(expected);
  });

  it('setAsyncThreshold writes what readAsyncThreshold reads, and null removes it', async () => {
    const ts = rig.store as unknown as TriplestoreAdapter;
    await rig.engine.setAsyncThreshold(AGENT, 20_000);
    expect(await readAsyncThreshold(ts, AGENT)).toBe(20_000);
    expect(await rig.engine.reasoningGateStatus(AGENT)).toEqual({
      asyncThreshold: 20_000, staleSince: null, catchUpRunning: false,
    });
    await rig.engine.setAsyncThreshold(AGENT, 5);
    expect(await readAsyncThreshold(ts, AGENT)).toBe(5);
    expect(await graphRows(rig.store, SETUP)).toHaveLength(1);
    await rig.engine.setAsyncThreshold(AGENT, null);
    expect(await readAsyncThreshold(ts, AGENT)).toBe(0);
    expect(await graphRows(rig.store, SETUP)).toEqual([]);
  });

  it.each([0, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('setAsyncThreshold refuses %j', async (bad) => {
    await expect(rig.engine.setAsyncThreshold(AGENT, bad)).rejects.toThrow(/positive integer/);
    expect(await graphRows(rig.store, SETUP)).toEqual([]);
  });

  it('a threshold set through setAsyncThreshold gates storeFact', async () => {
    await rig.engine.setAsyncThreshold(AGENT, 1);
    await rig.engine.storeFact(fact('Anna', 'livesIn', 'Hamburg', 'Place'), ownerCtx);
    expect(rig.materialize).not.toHaveBeenCalled();
    expect((await rig.engine.reasoningGateStatus(AGENT)).staleSince).not.toBeNull();
  });

  it('a failing read means "never skip"', async () => {
    const broken = { query: async () => { throw new Error('down'); } } as unknown as TriplestoreAdapter;
    expect(await readAsyncThreshold(broken, AGENT)).toBe(0);
    expect(await countTriples(broken, [WORLDVIEW])).toBeUndefined();
  });

  it('counts the triples of the given graphs only', async () => {
    await rig.store.update(`INSERT DATA {
      GRAPH <${WORLDVIEW}> { <urn:t:a> <urn:t:p> "1" . <urn:t:b> <urn:t:p> "2" . }
      GRAPH <${BOB_GRAPH}> { <urn:t:c> <urn:t:p> "3" . }
      GRAPH <urn:t:other> { <urn:t:d> <urn:t:p> "4" . }
    }`);
    expect(await countTriples(rig.store as unknown as TriplestoreAdapter, [WORLDVIEW])).toBe(2);
    expect(await countTriples(rig.store as unknown as TriplestoreAdapter, [WORLDVIEW, BOB_GRAPH])).toBe(3);
  });
});

describe('off by default', () => {
  it('without a setting storeFact materialises as before: no skip log, no marker', async () => {
    const { store, engine, logger, materialize } = await makeRig();
    await engine.storeFact(fact('Anna', 'livesIn', 'Hamburg', 'Place'), ownerCtx);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(await markerRows(store)).toEqual([]);
    expect(await engine.inferredStaleSince(AGENT)).toBeUndefined();
    expect(await graphRows(store, SHARED_INF)).toContain(
      `urn:ontofelia:entity:Anna | ${CORE}residesIn | urn:ontofelia:entity:Hamburg`,
    );
  });

  it.each(['0', '-1', 'many', '2.5'])('an unusable setting (%j) never skips', async (value) => {
    const { store, engine, logger, materialize } = await makeRig();
    await setThreshold(store, value);
    await engine.storeFact(fact('Anna', 'livesIn', 'Hamburg', 'Place'), ownerCtx);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(await markerRows(store)).toEqual([]);
  });

  it('a threshold above the ABox size does not skip', async () => {
    const { store, engine, logger, materialize } = await makeRig();
    await setThreshold(store, 100_000);
    await engine.storeFact(fact('Anna', 'livesIn', 'Hamburg', 'Place'), ownerCtx);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(await markerRows(store)).toEqual([]);
    expect(await graphRows(store, SHARED_INF)).not.toEqual([]);
  });
});

describe('above the threshold', () => {
  it('does not call the reasoner, logs the skip and sets the marker', async () => {
    const { store, engine, logger, materialize } = await makeRig();
    await setThreshold(store, 1);
    // The worldview must hold more than 1 triple: the first fact's own type and
    // label assertions already make it so.
    const r = await engine.storeFact(fact('Anna', 'livesIn', 'Hamburg', 'Place'), ownerCtx);
    expect(r.success).toBe(true);
    expect(materialize).not.toHaveBeenCalled();
    // The fact itself is stored; only its derivations are missing.
    expect(await graphRows(store, WORLDVIEW)).toContain(
      `urn:ontofelia:entity:Anna | ${CORE}livesIn | urn:ontofelia:entity:Hamburg`,
    );
    expect(await graphRows(store, SHARED_INF)).toEqual([]);
    // Auditable: agent, graph, ABox size and threshold are in the line.
    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = logger.info.mock.calls[0][0] as string;
    expect(line).toContain('reasoning gate');
    expect(line).toContain(`agent=${AGENT}`);
    expect(line).toContain(`graph=${WORLDVIEW}`);
    expect(line).toMatch(/abox-triples=\d+/);
    expect(line).toContain('threshold=1');
    // The marker is durable and readable.
    expect(await markerRows(store)).toHaveLength(1);
    expect(await engine.inferredStaleSince(AGENT)).toBeDefined();
  });

  it('the log line carries the real ABox size', async () => {
    const { store, engine, logger } = await makeRig();
    await store.update(`INSERT DATA { GRAPH <${WORLDVIEW}> {
      <urn:t:a> <urn:t:p> "1" . <urn:t:b> <urn:t:p> "2" . <urn:t:c> <urn:t:p> "3" .
    } }`);
    await setThreshold(store, 4);
    // Base: 3 seeded triples. The untyped subject adds none; the typed object
    // adds its type and label (2) before the gate looks: 5 > 4.
    await engine.storeFact(fact('Anna', 'livesIn', 'Hamburg', 'Place'), ownerCtx);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = logger.info.mock.calls[0][0] as string;
    expect(Number(/abox-triples=(\d+)/.exec(line)?.[1])).toBe(5);
    expect(line).toContain('threshold=4');
  });

  it('writes the marker once per stale period, not once per fact', async () => {
    const { store, engine, logger, materialize } = await makeRig();
    await setThreshold(store, 1);
    for (const f of WORLD_FACTS) await engine.storeFact(f, ownerCtx);
    expect(materialize).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(WORLD_FACTS.length);
    expect(await markerRows(store)).toHaveLength(1);
  });

  it('the marker survives a restart (a new engine on the same store sees it)', async () => {
    const { store, engine } = await makeRig();
    await setThreshold(store, 1);
    await engine.storeFact(fact('Anna', 'livesIn', 'Hamburg', 'Place'), ownerCtx);
    const restarted = new KnowledgeEngine(store as never);
    restarted.setLogger({ info: vi.fn(), warn: vi.fn() });
    expect(await restarted.inferredStaleSince(AGENT)).toBeDefined();
    expect((await restarted.catchUpInferredGraphs(AGENT)).status).toBe('ran');
    expect(await restarted.inferredStaleSince(AGENT)).toBeUndefined();
  });

  it('a private fact is measured over worldview plus the user graph, a worldview fact over the worldview alone', async () => {
    const { store, engine, logger } = await makeRig();
    await store.update(`INSERT DATA {
      GRAPH <${WORLDVIEW}> { <urn:t:a> <urn:t:p> "1" . <urn:t:b> <urn:t:p> "2" . }
      GRAPH <${BOB_GRAPH}> { <urn:t:c> <urn:t:p> "3" . }
    }`);
    await setThreshold(store, 3);
    // Worldview fact: reads the worldview only (2 triples), not above 3. It adds one.
    await engine.storeFact(fact('Zed', 'knows', 'Zoe'), ownerCtx);
    expect(logger.info).not.toHaveBeenCalled();
    // Bob's fact: worldview (3) + his own graph (1) = 4 > 3.
    await engine.storeFact(fact('User', 'likes', 'Tea'), bobCtx);
    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = logger.info.mock.calls[0][0] as string;
    expect(line).toContain(`graph=${BOB_GRAPH}`);
    expect(line).toContain('abox-triples=4');
  });

  it('falls back to synchronous materialisation when the marker cannot be written', async () => {
    const { store, engine, logger, materialize } = await makeRig();
    await setThreshold(store, 1);
    const realUpdate = store.update.bind(store);
    vi.spyOn(store, 'update').mockImplementation(async (q: string) => {
      if (q.includes('inferredStale')) throw new Error('disk full');
      return realUpdate(q);
    });
    await engine.storeFact(fact('Anna', 'livesIn', 'Hamburg', 'Place'), ownerCtx);
    expect(materialize).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
    expect(await graphRows(store, SHARED_INF)).not.toEqual([]);
  });
});

describe('catch-up', () => {
  /** Run `facts` through a fresh rig; returns it with all inferred graphs read. */
  async function run(
    facts: Array<{ f: FactInput; ctx: FactContext }>,
    threshold: number | null,
  ): Promise<{ rig: Rig; inferred: () => Promise<string[]> }> {
    const rig = await makeRig();
    await setThreshold(rig.store, threshold);
    for (const { f, ctx } of facts) await rig.engine.storeFact(f, ctx);
    const inferred = async () => {
      const r = await rig.store.query(
        `SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), ":inferred")) }`,
      );
      return (r.bindings ?? []).map(b => `${b.g.value} | ${b.s.value} | ${b.p.value} | ${b.o.value}`).sort();
    };
    return { rig, inferred };
  }

  /**
   * The rebuild never stores the reasoner's `X a owl:Thing` bookkeeping (it
   * always skipped it); on-write materialisation does. Compare without it.
   */
  const withoutBuiltins = (rows: string[]) => rows.filter(r => !r.endsWith(`| ${OWL}Thing`));

  const MIXED = [
    ...WORLD_FACTS.map(f => ({ f, ctx: ownerCtx })),
    { f: fact('User', 'likes', 'Tea'), ctx: bobCtx },
    { f: fact('User', 'likes', 'Coffee'), ctx: bobCtx },
  ];

  it('converges: gate on + catch-up gives the same inferred graphs as gate off', async () => {
    const off = await run(MIXED, null);
    const reference = withoutBuiltins(await off.inferred());
    // The scenario must actually infer something in every family.
    expect(reference.length).toBeGreaterThan(10);
    const text = reference.join('\n');
    expect(text).toContain(`${CORE}residesIn`);          // subproperty
    expect(text).toContain(`${CORE}Entity`);              // subclass via domain/range
    expect(text).toContain(`${CORE}mentoredBy`);          // inverse
    expect(text).toContain('urn:ontofelia:entity:Hamburg | urn:ontofelia:core#locatedIn | urn:ontofelia:entity:Europe'); // transitive
    expect(text).toContain('urn:ontofelia:entity:Tom | urn:ontofelia:core#knows | urn:ontofelia:entity:Anna');          // symmetric
    expect(text).toContain(`${BOB_INF} | urn:ontofelia:entity:user:bob | ${CORE}enjoys | Tea`); // per user

    const on = await run(MIXED, 1);
    expect(on.rig.materialize).not.toHaveBeenCalled();
    expect(await on.inferred()).toEqual([]); // nothing derived yet: stale
    expect(await on.rig.engine.inferredStaleSince(AGENT)).toBeDefined();

    const result = await on.rig.engine.catchUpInferredGraphs(AGENT);
    expect(result.status).toBe('ran');
    expect(result.stillStale).toBe(false);
    expect(withoutBuiltins(await on.inferred())).toEqual(reference);
    expect(await on.rig.engine.inferredStaleSince(AGENT)).toBeUndefined();
    expect(await markerRows(on.rig.store)).toEqual([]);
  });

  it('the catch-up result equals an oracle computed with the reasoner directly', async () => {
    const on = await run(MIXED, 1);
    await on.rig.engine.catchUpInferredGraphs(AGENT);
    // Oracle for the shared graph: full(TBox, worldview) minus full(TBox) minus the worldview itself.
    const nt = (rows: string[]) => rows.map(r => {
      const [s, p, o] = r.split(' | ');
      return `<${s}> <${p}> ${o.startsWith('urn:') ? `<${o}>` : JSON.stringify(o)} .`;
    }).join('\n');
    const abox = await graphRows(on.rig.store, WORLDVIEW);
    const tbox = await on.rig.store.getGraph(ONTOLOGY, 'turtle');
    const base = new Set((await inferTriples(tbox, '')).map(t => `${t.subject} ${t.predicate} ${t.object}`));
    const full = await inferTriples(tbox, nt(abox));
    const given = new Set(abox.map(r => { const [s, p, o] = r.split(' | '); return `<${s}> <${p}> ${o.startsWith('urn:') ? `<${o}>` : JSON.stringify(o)}`; }));
    const expected = full
      .map(t => `${t.subject} ${t.predicate} ${t.object}`)
      .filter(k => !base.has(k) && !given.has(k))
      .filter(k => !k.includes(`${OWL}Thing`))
      .map(k => k.replace(/<([^>]*)>/g, '$1').split(' ').slice(0, 3))
      .map(([s, p, o]) => `${s} | ${p} | ${o}`)
      .sort();
    const actual = (await graphRows(on.rig.store, SHARED_INF)).filter(r => !r.includes(`${OWL}Thing`));
    expect(actual).toEqual([...new Set(expected)]);
    expect(actual.length).toBeGreaterThan(5);
  });

  it('typed entities: the catch-up is a superset of the on-write graph and adds the missing typings', async () => {
    // storeFact writes `X a Class` for a typed entity directly, without
    // materialising it, so on-write materialisation never records `X a Entity`.
    // The rebuild does.
    const typed = [
      { f: { ...fact('Anna', 'livesIn', 'Hamburg', 'Place'), subjectType: 'Person' }, ctx: ownerCtx },
      { f: { ...fact('Anna', 'knows', 'Tom', 'Person'), subjectType: 'Person' }, ctx: ownerCtx },
    ];
    const off = await run(typed, null);
    const onWrite = withoutBuiltins(await off.inferred());
    const on = await run(typed, 1);
    await on.rig.engine.catchUpInferredGraphs(AGENT);
    const caughtUp = withoutBuiltins(await on.inferred());
    expect(caughtUp).toEqual(expect.arrayContaining(onWrite));
    const extra = caughtUp.filter(r => !onWrite.includes(r));
    expect(extra).toEqual([
      `${SHARED_INF} | urn:ontofelia:entity:Anna | ${RDF_TYPE} | ${CORE}Entity`,
      `${SHARED_INF} | urn:ontofelia:entity:Hamburg | ${RDF_TYPE} | ${CORE}Entity`,
      `${SHARED_INF} | urn:ontofelia:entity:Tom | ${RDF_TYPE} | ${CORE}Entity`,
    ]);
  });

  it('does not run when nothing is stale, unless forced', async () => {
    const { rig } = await run([{ f: WORLD_FACTS[0], ctx: ownerCtx }], null);
    const rebuild = vi.spyOn(rig.engine, 'rebuildInferredGraphs');
    expect((await rig.engine.catchUpInferredGraphs(AGENT)).status).toBe('not-stale');
    expect(rebuild).not.toHaveBeenCalled();
    expect((await rig.engine.catchUpInferredGraphs(AGENT, { force: true })).status).toBe('ran');
    expect(rebuild).toHaveBeenCalledTimes(1);
  });

  it('clears the marker only after a successful run; a failure keeps it', async () => {
    const { rig } = await run([{ f: WORLD_FACTS[0], ctx: ownerCtx }], 1);
    const rebuild = vi.spyOn(rig.engine, 'rebuildInferredGraphs').mockRejectedValueOnce(new Error('boom'));
    const failed = await rig.engine.catchUpInferredGraphs(AGENT);
    expect(failed).toMatchObject({ status: 'failed', error: 'boom' });
    expect(await markerRows(rig.store)).toHaveLength(1);
    expect(await rig.engine.inferredStaleSince(AGENT)).toBeDefined();
    expect(rig.logger.warn).toHaveBeenCalledTimes(1);
    // The next run retries and succeeds.
    expect((await rig.engine.catchUpInferredGraphs(AGENT)).status).toBe('ran');
    expect(rebuild).toHaveBeenCalledTimes(2);
    expect(await markerRows(rig.store)).toEqual([]);
  });

  it('never overlaps itself', async () => {
    const { rig } = await run([{ f: WORLD_FACTS[0], ctx: ownerCtx }], 1);
    const real = rig.engine.rebuildInferredGraphs.bind(rig.engine);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let concurrent = 0;
    let maxConcurrent = 0;
    const rebuild = vi.spyOn(rig.engine, 'rebuildInferredGraphs').mockImplementation(async (a: string) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await gate;
      try { return await real(a); } finally { concurrent--; }
    });
    const first = rig.engine.catchUpInferredGraphs(AGENT);
    const second = rig.engine.catchUpInferredGraphs(AGENT);
    const third = rig.engine.catchUpInferredGraphs(AGENT, { force: true });
    expect((await second).status).toBe('busy');
    expect((await third).status).toBe('busy');
    release();
    expect((await first).status).toBe('ran');
    expect(rebuild).toHaveBeenCalledTimes(1);
    expect(maxConcurrent).toBe(1);
    // Once finished, a new run is accepted again.
    expect((await rig.engine.catchUpInferredGraphs(AGENT, { force: true })).status).toBe('ran');
  });

  it('a skipped fact whose insert lands after the run read its state keeps the marker', async () => {
    const { rig, inferred } = await run([{ f: WORLD_FACTS[0], ctx: ownerCtx }], 1);
    // Hold the base-triple insert of the next fact: the gate has already marked
    // the graphs stale at that point, but the fact is not in the store yet.
    const realUpdate = rig.store.update.bind(rig.store);
    let insertReached!: () => void;
    const reached = new Promise<void>(r => { insertReached = r; });
    let releaseInsert!: () => void;
    const insertHeld = new Promise<void>(r => { releaseInsert = r; });
    let held = false;
    vi.spyOn(rig.store, 'update').mockImplementation(async (q: string) => {
      if (!held && q.includes('INSERT DATA') && q.includes(`<urn:ontofelia:entity:Tom> <${CORE}mentors> <urn:ontofelia:entity:Lena>`)) {
        held = true;
        insertReached();
        await insertHeld;
      }
      return realUpdate(q);
    });
    const storing = rig.engine.storeFact(fact('Tom', 'mentors', 'Lena', 'Widget'), ownerCtx);
    await reached;
    // The run starts now, reads the graphs without the fact, and is held at its end.
    const real = rig.engine.rebuildInferredGraphs.bind(rig.engine);
    let releaseRun!: () => void;
    const runHeld = new Promise<void>(r => { releaseRun = r; });
    vi.spyOn(rig.engine, 'rebuildInferredGraphs').mockImplementationOnce(async (a: string) => {
      const out = await real(a);
      await runHeld;
      return out;
    });
    const running = rig.engine.catchUpInferredGraphs(AGENT);
    await new Promise(r => setTimeout(r, 50));
    releaseInsert();
    await storing;
    releaseRun();
    expect(await running).toMatchObject({ status: 'ran', stillStale: true });
    expect(await markerRows(rig.store)).toHaveLength(1);
    expect(await inferred()).not.toContain(expect.stringContaining('mentoredBy'));
    // The next run sees the fact and derives its inverse.
    expect((await rig.engine.catchUpInferredGraphs(AGENT)).status).toBe('ran');
    expect((await inferred()).join('\n')).toContain('mentoredBy');
    expect(await markerRows(rig.store)).toEqual([]);
  });

  it('a fact stored during a run keeps the marker, and the next run covers it', async () => {
    const { rig, inferred } = await run([{ f: WORLD_FACTS[0], ctx: ownerCtx }], 1);
    const real = rig.engine.rebuildInferredGraphs.bind(rig.engine);
    let release!: () => void;
    const hold = new Promise<void>(r => { release = r; });
    let entered!: () => void;
    const inside = new Promise<void>(r => { entered = r; });
    vi.spyOn(rig.engine, 'rebuildInferredGraphs').mockImplementationOnce(async (a: string) => {
      entered();
      await hold;
      return real(a);
    });
    const running = rig.engine.catchUpInferredGraphs(AGENT);
    await inside;
    // Setting is now off, yet the write must not race the rebuild: it is deferred.
    await setThreshold(rig.store, null);
    rig.materialize.mockClear();
    rig.logger.info.mockClear();
    await rig.engine.storeFact(fact('Tom', 'mentors', 'Lena', 'Person'), ownerCtx);
    expect(rig.materialize).not.toHaveBeenCalled();
    expect(rig.logger.info.mock.calls[0][0]).toContain('catch-up-running');
    release();
    const first = await running;
    expect(first).toMatchObject({ status: 'ran', stillStale: true });
    expect(await markerRows(rig.store)).toHaveLength(1);
    expect(await inferred()).not.toContain(expect.stringContaining('mentoredBy'));
    // The follow-up run derives it and clears the marker.
    const second = await rig.engine.catchUpInferredGraphs(AGENT);
    expect(second).toMatchObject({ status: 'ran', stillStale: false });
    expect((await inferred()).join('\n')).toContain('mentoredBy');
    expect(await markerRows(rig.store)).toEqual([]);
  });
});
