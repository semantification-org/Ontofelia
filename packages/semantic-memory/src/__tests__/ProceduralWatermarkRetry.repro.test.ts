/**
 * Repro: the consolidation watermark is written after the aggregates, in two
 * separate updates.
 *
 * `consolidateIncremental` raises the skill aggregates first and calls
 * `setWatermark` afterwards, which is a DELETE of the old value followed by an
 * INSERT of the new one. Two consequences are pinned here:
 *  - if the watermark write fails, the aggregates are already raised; a retry
 *    still sees the old watermark, aggregates the same traces again
 *    (`prev + new`) and counts them twice;
 *  - a failure between the DELETE and the INSERT leaves no watermark at all.
 *
 * Real OxigraphAdapter and real ProceduralMemory. The store is wrapped in a
 * Proxy that rejects ONLY the updates that touch `lastConsolidatedAt`
 * (matched on the query text); every other call passes through.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { createOxigraphTestAdapter } from './helpers/oxigraphTestAdapter.js';
import { GraphRegistry } from '../utils/GraphRegistry.js';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import { ProceduralMemory, type TraceInput } from '../cognitive/ProceduralMemory.js';

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const GOAL = `${COGT}AnswerQuestion`;
const T0 = Date.UTC(2026, 9, 14, 0, 0, 0);
const at = (min: number) => new Date(T0 + min * 60_000);

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = createOxigraphTestAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'wm-retry-')),
    port: 0,
    endpoint: '',
  });
  return store;
}

function trace(min: number): TraceInput {
  return {
    toolName: 'searchKb',
    toolArgsHash: 'h',
    toolArgsBrief: 'query',
    executedAt: at(min),
    durationMs: 10,
    outcome: 'success',
    forGoalType: GOAL,
    sequencePos: 1,
  };
}

async function successCount(store: TriplestoreAdapter): Promise<number> {
  const g = GraphUriResolver.getCogProceduralGraph(AGENT);
  const r = await store.query(`
    SELECT ?succ WHERE { GRAPH <${g}> {
      ?s a <${COGT}Skill> ; <${COGT}toolName> "searchKb" ; <${COGT}successCount> ?succ } }`);
  return Number(r.bindings![0].succ.value);
}

/**
 * The store with the updates that touch `lastConsolidatedAt` rejected. With
 * `onlyInsert`, the DELETE of the old watermark still goes through and only the
 * INSERT of the new one fails.
 */
function failingWatermarkWrite(store: TriplestoreAdapter, opts: { onlyInsert?: boolean } = {}): TriplestoreAdapter {
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'update') {
        return async (query: string) => {
          const touchesWatermark = query.includes('lastConsolidatedAt');
          const isInsert = query.includes('INSERT DATA');
          if (touchesWatermark && (!opts.onlyInsert || isInsert)) {
            throw new Error('watermark write failed');
          }
          return target.update(query);
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

describe('ProceduralMemory watermark write failures', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let pm: ProceduralMemory;

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    pm = new ProceduralMemory(store, AGENT, registry);
  });

  it('control: when only the watermark write fails, the watermark stays where it was', async () => {
    await pm.recordTrace(trace(1));
    await pm.consolidateIncremental({ until: at(5), firstWindowMs: 86_400_000 * 10 });
    await pm.recordTrace(trace(10));

    const pm2 = new ProceduralMemory(failingWatermarkWrite(store), AGENT, registry);
    await expect(pm2.consolidateIncremental({ until: at(20) })).rejects.toThrow('watermark write failed');
    expect((await pm.getWatermark())?.toISOString()).toBe(at(5).toISOString());
  });

  it('control: without any failure the second run counts the new trace once', async () => {
    await pm.recordTrace(trace(1));
    await pm.consolidateIncremental({ until: at(5), firstWindowMs: 86_400_000 * 10 });
    expect(await successCount(store)).toBe(1);
    await pm.recordTrace(trace(10));
    await pm.consolidateIncremental({ until: at(20) });
    expect(await successCount(store)).toBe(2);
  });

  it.fails('a consolidation retried after a failed watermark write does not count the same traces twice', async () => {
    await pm.recordTrace(trace(1));
    await pm.consolidateIncremental({ until: at(5), firstWindowMs: 86_400_000 * 10 });
    const n = await successCount(store);
    expect(n).toBe(1);

    await pm.recordTrace(trace(10));
    const pm2 = new ProceduralMemory(failingWatermarkWrite(store), AGENT, registry);
    await expect(pm2.consolidateIncremental({ until: at(20) })).rejects.toThrow('watermark write failed');

    // Retry with the real store: the new trace must be counted once in total.
    await pm.consolidateIncremental({ until: at(20) });
    expect(await successCount(store)).toBe(n + 1);
  });

  it.fails('a failure after the watermark DELETE keeps a watermark', async () => {
    await pm.recordTrace(trace(1));
    await pm.consolidateIncremental({ until: at(5), firstWindowMs: 86_400_000 * 10 });
    expect(await pm.getWatermark()).toBeDefined();

    await pm.recordTrace(trace(10));
    const pm2 = new ProceduralMemory(failingWatermarkWrite(store, { onlyInsert: true }), AGENT, registry);
    await expect(pm2.consolidateIncremental({ until: at(20) })).rejects.toThrow('watermark write failed');

    expect(await pm.getWatermark()).toBeDefined();
  });
});
