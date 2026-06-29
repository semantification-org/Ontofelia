import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphRegistry, GraphUriResolver } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { WorkingMemory } from '../cognitive/WorkingMemory.js';

// NOTE: doc 04 §8 names InMemoryAdapter, but that adapter does not implement
// SPARQL (query() returns empty, update() is a no-op). WorkingMemory is a SPARQL
// projection, so the only faithful unit-test backend is the embedded Oxigraph
// store, which runs fully in-process (WASM) with real SPARQL.

const AGENT = 'ontofelia';
const SESS = 'sessB1';
const CYCLE = 'cyc1';
const PHASE = 'urn:ontofelia:cog:phase:test';

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/wm-test-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

describe('WorkingMemory', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let wm: WorkingMemory;

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    wm = new WorkingMemory(store, registry, AGENT, SESS, CYCLE);
  });

  it('targets the registered cog:working graph', () => {
    expect(wm.graphUri()).toBe(GraphUriResolver.getCogWorkingGraph(AGENT, SESS, CYCLE));
    expect(registry.isAllowed(wm.graphUri())).toBe(true);
  });

  it('round-trips an entry with all core fields', async () => {
    const id = await wm.write(
      {
        buffer: 'perceptionBuffer',
        entryKind: 'message-text',
        payload: 'hello "world"\nline2',
        salience: 1.0,
      },
      PHASE,
    );
    const entries = await wm.read();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.id).toBe(id);
    expect(e.buffer).toBe('perceptionBuffer');
    expect(e.entryKind).toBe('message-text');
    expect(e.payload).toBe('hello "world"\nline2');
    expect(e.salience).toBe(1);
    expect(e.writtenBy).toBe(PHASE);
    expect(e.writtenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('round-trips optional fields', async () => {
    await wm.write(
      {
        buffer: 'retrievalBuffer',
        entryKind: 'fact',
        payload: 'Ontofelia uses Oxigraph',
        salience: 0.7,
        retrievalScore: 0.7,
        sourceGraph: 'urn:ontofelia:worldview',
        refersTo: 'urn:entity:oxigraph',
        carryForward: true,
        expiresAfter: 2,
      },
      PHASE,
    );
    const [e] = await wm.read();
    expect(e.retrievalScore).toBe(0.7);
    expect(e.sourceGraph).toBe('urn:ontofelia:worldview');
    expect(e.refersTo).toBe('urn:entity:oxigraph');
    expect(e.carryForward).toBe(true);
    expect(e.expiresAfter).toBe(2);
  });

  it('filters reads by buffer, kind and minSalience', async () => {
    await wm.write({ buffer: 'perceptionBuffer', entryKind: 'message-text', payload: 'a', salience: 0.9 }, PHASE);
    await wm.write({ buffer: 'retrievalBuffer', entryKind: 'fact', payload: 'b', salience: 0.3 }, PHASE);
    await wm.write({ buffer: 'retrievalBuffer', entryKind: 'fact', payload: 'c', salience: 0.8 }, PHASE);

    expect(await wm.read({ buffer: 'retrievalBuffer' })).toHaveLength(2);
    expect(await wm.read({ entryKind: 'message-text' })).toHaveLength(1);
    expect(await wm.read({ minSalience: 0.5 })).toHaveLength(2);
  });

  it('globalWorkspace returns only salience >= theta, in fixed buffer order', async () => {
    await wm.write({ buffer: 'perceptionBuffer', entryKind: 'message-text', payload: 'msg', salience: 1.0 }, PHASE);
    await wm.write({ buffer: 'selfBuffer', entryKind: 'persona-fragment', payload: 'persona', salience: 0.6 }, PHASE);
    await wm.write({ buffer: 'retrievalBuffer', entryKind: 'fact', payload: 'lowfact', salience: 0.2 }, PHASE);
    await wm.write({ buffer: 'goalBuffer', entryKind: 'goal-active', payload: 'goal', salience: 0.9 }, PHASE);

    const gw = await wm.globalWorkspace(0.5);
    expect(gw.map((e) => e.payload)).toEqual(['persona', 'goal', 'msg']); // self → goal → perception
    expect(gw.every((e) => e.salience >= 0.5)).toBe(true);
  });

  it('globalWorkspace orders by descending salience within a buffer', async () => {
    await wm.write({ buffer: 'retrievalBuffer', entryKind: 'fact', payload: 'low', salience: 0.6 }, PHASE);
    await wm.write({ buffer: 'retrievalBuffer', entryKind: 'fact', payload: 'high', salience: 0.95 }, PHASE);
    const gw = await wm.globalWorkspace(0.5);
    expect(gw.map((e) => e.payload)).toEqual(['high', 'low']);
  });

  it('adjustSalience moves an entry across the theta cutoff, clamped to [0,1]', async () => {
    const id = await wm.write({ buffer: 'retrievalBuffer', entryKind: 'fact', payload: 'x', salience: 0.4 }, PHASE);
    expect(await wm.globalWorkspace(0.5)).toHaveLength(0);

    await wm.adjustSalience(id, 0.3);
    expect((await wm.read())[0].salience).toBeCloseTo(0.7);
    expect(await wm.globalWorkspace(0.5)).toHaveLength(1);

    await wm.adjustSalience(id, 5); // clamps at 1
    expect((await wm.read())[0].salience).toBe(1);
    await wm.adjustSalience(id, -5); // clamps at 0
    expect((await wm.read())[0].salience).toBe(0);
  });

  it('clamps out-of-range salience on write', async () => {
    await wm.write({ buffer: 'metaBuffer', entryKind: 'reflection', payload: 'r', salience: 9 }, PHASE);
    expect((await wm.read())[0].salience).toBe(1);
  });

  it('enforces the 200-entry cap, dropping lowest-salience first', async () => {
    // Write 200 mid-salience entries, then one clearly-lowest entry that must be dropped.
    for (let i = 0; i < 200; i++) {
      await wm.write({ buffer: 'retrievalBuffer', entryKind: 'fact', payload: `f${i}`, salience: 0.5 }, PHASE);
    }
    expect(await wm.read()).toHaveLength(200);

    await wm.write({ buffer: 'retrievalBuffer', entryKind: 'fact', payload: 'lowest', salience: 0.01 }, PHASE);
    const after = await wm.read();
    expect(after).toHaveLength(200);
    expect(after.some((e) => e.payload === 'lowest')).toBe(false);
  });

  it('carryForward copies eligible entries to the next cycle with decay and a back-link', async () => {
    const selfId = await wm.write({ buffer: 'selfBuffer', entryKind: 'persona-fragment', payload: 'persona', salience: 0.6 }, PHASE);
    await wm.write({ buffer: 'metaBuffer', entryKind: 'reflection', payload: 'keep', salience: 0.5, carryForward: true }, PHASE);
    await wm.write({ buffer: 'metaBuffer', entryKind: 'reflection', payload: 'drop', salience: 0.5 }, PHASE);
    await wm.write({ buffer: 'metaBuffer', entryKind: 'reflection', payload: 'expired', salience: 0.5, carryForward: true, expiresAfter: 0 }, PHASE);

    const carried = await wm.carryForward('cyc2');
    expect(carried).toBe(2); // selfBuffer + the carryForward meta entry

    const next = new WorkingMemory(store, registry, AGENT, SESS, 'cyc2');
    const nextEntries = await next.read();
    expect(nextEntries).toHaveLength(2);
    const persona = nextEntries.find((e) => e.payload === 'persona')!;
    expect(persona.salience).toBeCloseTo(0.42); // 0.6 * 0.7
    expect(persona.carriedFrom).toBe(selfId);
    expect(nextEntries.some((e) => e.payload === 'drop')).toBe(false);
    expect(nextEntries.some((e) => e.payload === 'expired')).toBe(false);
  });

  it('close() drops the working graph', async () => {
    await wm.write({ buffer: 'perceptionBuffer', entryKind: 'message-text', payload: 'x', salience: 1 }, PHASE);
    expect(await wm.read()).toHaveLength(1);
    await wm.close();
    expect(await wm.read()).toHaveLength(0);
  });

  it('rejects writes to an unregistered graph (assertWritable gate)', async () => {
    const rogue = new WorkingMemory(store, GraphRegistry.create(['someoneelse']), AGENT, SESS, CYCLE);
    await expect(
      rogue.write({ buffer: 'perceptionBuffer', entryKind: 'message-text', payload: 'x', salience: 1 }, PHASE),
    ).rejects.toThrow();
  });
});
