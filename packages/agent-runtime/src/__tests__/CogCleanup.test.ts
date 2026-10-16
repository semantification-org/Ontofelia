import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphRegistry, GraphUriResolver } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { CogCleanup } from '../cognitive/CogCleanup.js';

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const NOW = new Date('2026-10-15T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/cleanup-test-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

async function put(store: TriplestoreAdapter, graph: string, subject: string, predicate: string, at: string) {
  await store.update(
    `INSERT DATA { GRAPH <${graph}> { <${subject}> <${COGT}${predicate}> "${at}"^^<${XSD}dateTime> . <${subject}> <${COGT}payload> "private text" . } }`,
  );
}

async function graphs(store: TriplestoreAdapter): Promise<Set<string>> {
  const r = await store.query('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }');
  return new Set((r.bindings ?? []).map((b) => b.g.value));
}

describe('CogCleanup', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let cleanup: CogCleanup;

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    cleanup = new CogCleanup(store, registry, AGENT);
  });

  it('drops only old cog working and cycle graphs; everything else survives', async () => {
    const W = (s: string, c: string) => GraphUriResolver.getCogWorkingGraph(AGENT, s, c);
    const C = (s: string) => GraphUriResolver.getCogCyclesGraph(AGENT, s);

    const oldWorking = W('s1', 'c-old'); // 8 days: dropped
    const freshWorking = W('s1', 'c-fresh'); // 6 days: kept (positive control)
    const midCycles = C('s-mid'); // 10 days: kept, cycle graphs live 30 days
    const oldCycles = C('s-old'); // 31 days: dropped
    const freshCycles = C('s-fresh'); // 1 day: kept
    const mixedWorking = W('s2', 'c-mixed'); // old + new write: newest counts, kept

    await put(store, oldWorking, 'urn:x:1', 'writtenAt', daysAgo(8));
    await put(store, freshWorking, 'urn:x:2', 'writtenAt', daysAgo(6));
    await put(store, midCycles, 'urn:x:3', 'endedAt', daysAgo(10));
    await put(store, oldCycles, 'urn:x:4', 'endedAt', daysAgo(31));
    await put(store, freshCycles, 'urn:x:5', 'endedAt', daysAgo(1));
    await put(store, mixedWorking, 'urn:x:6', 'writtenAt', daysAgo(20));
    await put(store, mixedWorking, 'urn:x:7', 'writtenAt', daysAgo(1));

    // Old data in graphs that are not cycle graphs must never be touched.
    const others = [
      GraphUriResolver.getCogEpisodicGraph(AGENT),
      GraphUriResolver.getCogProceduralGraph(AGENT),
      GraphUriResolver.getCogMetaGraph(AGENT),
      GraphUriResolver.getSetupGraph(AGENT),
      GraphUriResolver.getCogGoalsSessionGraph(AGENT, 's1'),
      `urn:${AGENT}:user:alice`,
      `urn:${AGENT}:session:s1`,
      'urn:other:cog:working:s1:c1', // another agent's namespace: not registered
      `urn:${AGENT}:cog:working-notes`, // lookalike prefix, not a registered pattern
      'urn:example:not-a-cog-graph',
    ];
    for (const g of others) await put(store, g, 'urn:x:o', 'writtenAt', daysAgo(400));

    const before = await graphs(store);
    const report = await cleanup.run(NOW);
    const after = await graphs(store);

    expect(report).toMatchObject({ workingDropped: 1, cyclesDropped: 1, undated: 0 });
    expect(report.workingScanned).toBe(3);
    expect(report.cyclesScanned).toBe(3);

    expect(before.has(oldWorking) && !after.has(oldWorking)).toBe(true);
    expect(before.has(oldCycles) && !after.has(oldCycles)).toBe(true);
    for (const kept of [freshWorking, midCycles, freshCycles, mixedWorking, ...others]) {
      expect(after.has(kept), kept).toBe(true);
    }
    expect([...before].filter((g) => !after.has(g)).sort()).toEqual([oldWorking, oldCycles].sort());
  });

  it('keeps a candidate graph whose age cannot be read', async () => {
    const g = GraphUriResolver.getCogWorkingGraph(AGENT, 's9', 'c9');
    await store.update(`INSERT DATA { GRAPH <${g}> { <urn:x:u> <${COGT}payload> "no timestamp" . } }`);
    const report = await cleanup.run(NOW);
    expect(report.undated).toBe(1);
    expect(report.workingDropped).toBe(0);
    expect((await graphs(store)).has(g)).toBe(true);
  });

  it('is idempotent', async () => {
    await put(store, GraphUriResolver.getCogWorkingGraph(AGENT, 's1', 'c1'), 'urn:x:1', 'writtenAt', daysAgo(9));
    expect((await cleanup.run(NOW)).workingDropped).toBe(1);
    expect((await cleanup.run(NOW)).workingDropped).toBe(0);
  });
});
