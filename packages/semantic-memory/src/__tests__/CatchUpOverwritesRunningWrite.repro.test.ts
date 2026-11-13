/**
 * Repro: a catch-up rebuild overwrites the inferences of a store that was
 * already running when the catch-up started.
 *
 * The reasoning gate only defers stores that reach the gate AFTER the catch-up
 * started. A `storeFact` that had already passed the gate and waits in
 * `reasoner.materialize` writes its fact and its inferences later; the
 * catch-up, which read the graphs before that, then clears the inferred graph
 * and writes its older result. The new inference is gone, and the catch-up
 * reports `stillStale: false` because the store never touched the marker.
 *
 * Real OxigraphAdapter, real KnowledgeEngine and the real reasoner. The only
 * interposition is a pass-through wrapper on `reasoner.materialize` that
 * computes the real result and then waits on a promise resolved by hand, so
 * the interleaving is forced without sleeps.
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createOxigraphTestAdapter, type OxigraphTestAdapter } from './helpers/oxigraphTestAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import { REASONING_NS } from '../reasoning/ReasoningGate.js';
import type { FactInput, FactContext } from '../types.js';

const AGENT = 'ontofelia';
const CORE = 'urn:ontofelia:core#';
const ONTOLOGY = 'urn:shared:ontology';
const SHARED_INF = GraphUriResolver.getInferredGraph(AGENT);

const here = dirname(fileURLToPath(import.meta.url));
const CORE_TTL = readFileSync(join(here, '..', 'ontologies', 'ontofelia-core.ttl'), 'utf8');

const ownerCtx: FactContext = { agentId: AGENT, userId: 'owner', sessionId: 's', isOwner: true };

// `locatedIn` is transitive in the core ontology, so storing the second fact
// below derives `Hamburg locatedIn Europe` across both facts.
const BASE_FACT: FactInput = {
  subject: 'Hamburg', predicate: 'locatedIn', object: 'Germany', objectType: 'Widget',
  subjectType: 'Widget', sourceKind: 'user',
};
const RUNNING_FACT: FactInput = {
  subject: 'Germany', predicate: 'locatedIn', object: 'Europe', objectType: 'Widget',
  subjectType: 'Widget', sourceKind: 'user',
};
const INFERENCE_ROW = `urn:ontofelia:entity:Hamburg | ${CORE}locatedIn | urn:ontofelia:entity:Europe`;

type Materialize = (...args: unknown[]) => Promise<unknown>;

interface Rig {
  store: OxigraphTestAdapter;
  engine: KnowledgeEngine;
  reasoner: { materialize: Materialize };
}

async function makeRig(): Promise<Rig> {
  const store = createOxigraphTestAdapter();
  await store.initialize({
    backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'cu-race-')), port: 0, endpoint: '',
  });
  await store.putGraph(ONTOLOGY, CORE_TTL, 'turtle');
  const engine = new KnowledgeEngine(store as never);
  engine.setLogger({ info: () => undefined, warn: () => undefined });
  const reasoner = (engine as unknown as { reasoner: { materialize: Materialize } }).reasoner;
  return { store, engine, reasoner };
}

async function inferredRows(store: OxigraphTestAdapter): Promise<string[]> {
  const r = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${SHARED_INF}> { ?s ?p ?o } }`);
  return (r.bindings ?? []).map(b => `${b.s.value} | ${b.p.value} | ${b.o.value}`).sort();
}

async function markerCount(store: OxigraphTestAdapter): Promise<number> {
  const setup = GraphUriResolver.getSetupGraph(AGENT);
  const r = await store.query(
    `SELECT ?v WHERE { GRAPH <${setup}> { ?s <${REASONING_NS}inferredStale> ?v } }`,
  );
  return (r.bindings ?? []).length;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

describe('catch-up racing a store that already passed the reasoning gate', () => {
  it('control: store first, catch-up afterwards, the inference is in the inferred graph', async () => {
    const { store, engine } = await makeRig();
    await engine.storeFact(BASE_FACT, ownerCtx);
    await engine.storeFact(RUNNING_FACT, ownerCtx);
    expect(await inferredRows(store)).toContain(INFERENCE_ROW);

    const result = await engine.catchUpInferredGraphs(AGENT, { force: true });
    expect(result).toMatchObject({ status: 'ran', stillStale: false });
    expect(await inferredRows(store)).toContain(INFERENCE_ROW);
  });

  it('control: the forced interleaving works, the store itself writes its inference before the catch-up finishes', async () => {
    const { store, engine, reasoner } = await makeRig();
    await engine.storeFact(BASE_FACT, ownerCtx);

    const real = reasoner.materialize.bind(reasoner);
    const storeReached = deferred();
    const storeRelease = deferred();
    const rebuildReached = deferred();
    const rebuildRelease = deferred();
    let storeHeld = false;
    let rebuildHeld = false;
    // Pass-through wrapper: the real reasoner computes every result; it only
    // waits, after computing, so the two calls overlap in a fixed order.
    // Rebuilds pass `{ strict: true }` as third argument, on-write calls do not.
    vi.spyOn(reasoner, 'materialize').mockImplementation(async (...args: unknown[]) => {
      const out = await real(...args);
      const isRebuild = (args[2] as { strict?: boolean } | undefined)?.strict === true;
      if (!isRebuild && !storeHeld) {
        storeHeld = true;
        storeReached.resolve();
        await storeRelease.promise;
      } else if (isRebuild && !rebuildHeld) {
        rebuildHeld = true;
        rebuildReached.resolve();
        await rebuildRelease.promise;
      }
      return out;
    });

    const storing = engine.storeFact(RUNNING_FACT, ownerCtx);
    await storeReached.promise;
    const catchingUp = engine.catchUpInferredGraphs(AGENT, { force: true });
    await rebuildReached.promise;

    storeRelease.resolve();
    await storing;
    expect(await inferredRows(store)).toContain(INFERENCE_ROW);

    rebuildRelease.resolve();
    expect((await catchingUp).status).toBe('ran');
  });

  it.fails('a catch-up does not drop the inference of a store that was running when it started', async () => {
    const { store, engine, reasoner } = await makeRig();
    await engine.storeFact(BASE_FACT, ownerCtx);

    const real = reasoner.materialize.bind(reasoner);
    const storeReached = deferred();
    const storeRelease = deferred();
    const rebuildReached = deferred();
    const rebuildRelease = deferred();
    let storeHeld = false;
    let rebuildHeld = false;
    // Same pass-through wrapper as in the control above.
    vi.spyOn(reasoner, 'materialize').mockImplementation(async (...args: unknown[]) => {
      const out = await real(...args);
      const isRebuild = (args[2] as { strict?: boolean } | undefined)?.strict === true;
      if (!isRebuild && !storeHeld) {
        storeHeld = true;
        storeReached.resolve();
        await storeRelease.promise;
      } else if (isRebuild && !rebuildHeld) {
        rebuildHeld = true;
        rebuildReached.resolve();
        await rebuildRelease.promise;
      }
      return out;
    });

    // (1) the store passes the gate and waits in materialize
    const storing = engine.storeFact(RUNNING_FACT, ownerCtx);
    await storeReached.promise;
    // (2) the catch-up has read its source graphs and waits in its rebuild
    const catchingUp = engine.catchUpInferredGraphs(AGENT, { force: true });
    await rebuildReached.promise;
    // (3) the store finishes; its inference is in the inferred graph
    storeRelease.resolve();
    await storing;
    expect(await inferredRows(store)).toContain(INFERENCE_ROW);
    // (4) the catch-up finishes with its older result
    rebuildRelease.resolve();
    const result = await catchingUp;
    expect(result.status).toBe('ran');

    const inferencePresent = (await inferredRows(store)).includes(INFERENCE_ROW);
    const stillStale = result.stillStale === true || (await markerCount(store)) > 0;
    expect(inferencePresent || stillStale).toBe(true);
  });
});
