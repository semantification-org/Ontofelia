import { describe, it, expect, beforeEach } from 'vitest';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { GraphRegistry } from '../utils/GraphRegistry.js';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import { ProceduralMemory, type TraceInput } from '../cognitive/ProceduralMemory.js';

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const GOAL = `${COGT}AnswerQuestion`;
const T0 = Date.UTC(2026, 9, 14, 0, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000);

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/wm-mark-test-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

function trace(min: number, over: Partial<TraceInput> = {}): TraceInput {
  return {
    toolName: 'searchKb',
    toolArgsHash: 'h',
    toolArgsBrief: 'query',
    executedAt: at(min),
    durationMs: 10,
    outcome: 'success',
    forGoalType: GOAL,
    sequencePos: 1,
    ...over,
  };
}

async function skillRow(store: TriplestoreAdapter) {
  const g = GraphUriResolver.getCogProceduralGraph(AGENT);
  const r = await store.query(`
    SELECT ?succ ?fail ?part ?rate WHERE { GRAPH <${g}> {
      ?s a <${COGT}Skill> ; <${COGT}toolName> "searchKb" ; <${COGT}successCount> ?succ ;
         <${COGT}failureCount> ?fail ; <${COGT}partialCount> ?part ; <${COGT}successRate> ?rate } }`);
  const b = r.bindings![0];
  return { succ: Number(b.succ.value), fail: Number(b.fail.value), part: Number(b.part.value), rate: Number(b.rate.value) };
}

async function seed(pm: ProceduralMemory) {
  // 12 traces over 120 minutes; every fourth fails.
  for (let i = 0; i < 12; i++) {
    await pm.recordTrace(trace(i * 10, { outcome: i % 4 === 3 ? 'error' : 'success', sequencePos: 1 }));
  }
}

describe('ProceduralMemory incremental consolidation (watermark)', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let pm: ProceduralMemory;

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    pm = new ProceduralMemory(store, AGENT, registry);
  });

  it('running four times over overlapping time gives the same counts as one run', async () => {
    await seed(pm);
    // The reference runs once over everything, in its own store.
    const refStore = await makeStore();
    const once = new ProceduralMemory(refStore, AGENT, GraphRegistry.create([AGENT]));
    await seed(once);
    const refReport = await once.consolidateIncremental({ until: at(130), firstWindowMs: 10 * 86_400_000 });
    expect(refReport.tracesScanned).toBe(12);
    const reference = await skillRow(refStore);

    // Four runs whose "windows" overlap in wall-clock terms: each later run could
    // see earlier traces again, but the watermark gives each trace to one run only.
    const scanned: number[] = [];
    for (const until of [at(45), at(85), at(130), at(130)]) {
      const rep = await pm.consolidateIncremental({ until, firstWindowMs: 10 * 86_400_000 });
      scanned.push(rep.tracesScanned);
    }
    expect(scanned.reduce((a, b) => a + b, 0)).toBe(12);
    expect(scanned[3]).toBe(0);
    expect(await skillRow(store)).toEqual(reference);
    expect(reference).toMatchObject({ succ: 9, fail: 3 });
  });

  it('plain consolidate over the same window still double counts (what the watermark fixes)', async () => {
    await seed(pm);
    const window = { since: at(-1), until: at(130) };
    await pm.consolidate(window);
    await pm.consolidate(window);
    expect((await skillRow(store)).succ).toBe(18);
  });

  it('stores the watermark in the setup graph, advances it, and never moves it back', async () => {
    expect(await pm.getWatermark()).toBeUndefined();
    await seed(pm);
    await pm.consolidateIncremental({ until: at(130), firstWindowMs: 10 * 86_400_000 });
    expect((await pm.getWatermark())?.toISOString()).toBe(at(130).toISOString());

    const setup = GraphUriResolver.getSetupGraph(AGENT);
    const raw = await store.query(
      `SELECT ?v WHERE { GRAPH <${setup}> { ?s <${COGT}lastConsolidatedAt> ?v } }`,
    );
    expect(raw.bindings).toHaveLength(1);

    const stale = await pm.consolidateIncremental({ until: at(60) });
    expect(stale.tracesScanned).toBe(0);
    expect((await pm.getWatermark())?.toISOString()).toBe(at(130).toISOString());
  });

  it('a trace exactly at the watermark is counted once; later traces are picked up next run', async () => {
    await pm.recordTrace(trace(10));
    await pm.recordTrace(trace(20));
    await pm.consolidateIncremental({ until: at(20), firstWindowMs: 86_400_000 * 10 });
    expect((await skillRow(store)).succ).toBe(2);
    await pm.recordTrace(trace(30));
    const rep = await pm.consolidateIncremental({ until: at(40) });
    expect(rep.tracesScanned).toBe(1);
    expect((await skillRow(store)).succ).toBe(3);
  });

  it('the write goes through the registry: an agent the registry does not know is refused', async () => {
    const other = new ProceduralMemory(store, AGENT, GraphRegistry.create(['someoneelse']));
    await other.recordTrace(trace(1));
    await expect(other.consolidateIncremental({ until: at(5), firstWindowMs: 86_400_000 * 10 })).rejects.toThrow(
      /not a registered Named Graph/,
    );
    expect(await other.getWatermark()).toBeUndefined();
  });

  it('a failed consolidation leaves the watermark where it was', async () => {
    await pm.recordTrace(trace(1));
    await pm.consolidateIncremental({ until: at(5), firstWindowMs: 86_400_000 * 10 });
    const failing = new Proxy(store, {
      get(t, p, r) {
        if (p === 'update') return async () => { throw new Error('boom'); };
        const v = Reflect.get(t, p, r);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    const pm2 = new ProceduralMemory(failing, AGENT, registry);
    await pm.recordTrace(trace(10));
    await expect(pm2.consolidateIncremental({ until: at(20) })).rejects.toThrow('boom');
    expect((await pm.getWatermark())?.toISOString()).toBe(at(5).toISOString());
  });
});
