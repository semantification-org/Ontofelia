import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { EpisodicMemory } from '../cognitive/EpisodicMemory.js';
import { ProceduralMemory, type TraceInput } from '../cognitive/ProceduralMemory.js';
import { GraphRegistry } from '../index.js';

// Batched writes of the cognitive stores: the same data as one write per record,
// in one update.

const AGENT = 'ontofelia';
let dir: string;

async function open(): Promise<OxigraphAdapter> {
  const a = new OxigraphAdapter();
  await a.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
  return a;
}

/** The graph as a sorted list of quads with generated ids and timestamps blanked. */
async function shape(a: OxigraphAdapter, graph: string): Promise<string[]> {
  const res = await a.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  const blank = (v: string) =>
    v
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
      .replace(/(?<=trace:)[0-9a-f]{8}/g, '<id>')
      .replace(/tr_[0-9TZ:.-]+_[0-9a-f]{8}/g, 'tr_<t>')
      .replace(/\d{4}-\d\d-\d\dT[0-9:.Z-]+/g, '<t>');
  return (res.bindings ?? [])
    .map((b) => `${blank(b.p.value)} ${blank(b.o.value)}`)
    .sort();
}

describe('batched writes', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'batched-writes-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const trace = (i: number): TraceInput => ({
    toolName: `tool${i}`,
    toolArgsHash: 'h',
    toolArgsBrief: 'q',
    executedAt: new Date('2026-10-01T10:00:00Z'),
    durationMs: 5,
    outcome: 'success',
    sequencePos: i + 1,
    sequenceLen: 3,
    cycleId: 'c1',
    sessionId: 's1',
    forUser: 'alice',
  });

  it('recordTraces stores the chain recordTrace stored, in one update', async () => {
    const seq = await open();
    const pmSeq = new ProceduralMemory(seq, AGENT, GraphRegistry.create([AGENT]));
    let prev: string | undefined;
    for (let i = 0; i < 3; i++) prev = await pmSeq.recordTrace({ ...trace(i), previousTrace: prev });

    const dir2 = mkdtempSync(join(tmpdir(), 'batched-writes-'));
    try {
      const batch = new OxigraphAdapter();
      await batch.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir2, port: 0, endpoint: '' });
      const updates = vi.spyOn(batch, 'update');
      const pm = new ProceduralMemory(batch, AGENT, GraphRegistry.create([AGENT]));
      const uris = await pm.recordTraces([trace(0), trace(1), trace(2)]);
      expect(uris).toHaveLength(3);
      expect(updates).toHaveBeenCalledTimes(1);
      const g = pm.graphUri();
      expect(await shape(batch, g)).toEqual(await shape(seq, pm.graphUri()));
      // The chain: each trace after the first points at the one before.
      const links = await batch.query(`SELECT ?t ?p WHERE { GRAPH <${g}> { ?t <urn:shared:ontology#cog/previousTrace> ?p } }`);
      const pairs = (links.bindings ?? []).map((b) => `${b.t.value}>${b.p.value}`).sort();
      expect(pairs).toEqual([`${uris[1]}>${uris[0]}`, `${uris[2]}>${uris[1]}`].sort());
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it('prepareAppendMany writes nothing before commit and one update at commit', async () => {
    const a = await open();
    const updates = vi.spyOn(a, 'update');
    const em = new EpisodicMemory(a, AGENT);
    const { uris, commit } = await em.prepareAppendMany([
      { episodeType: 'message-received', sessionId: 's', payload: 'one', occurredAt: new Date('2026-10-01T10:00:00Z') },
      { episodeType: 'response-sent', sessionId: 's', payload: 'two', occurredAt: new Date('2026-10-01T10:00:01Z') },
    ]);
    expect(updates).not.toHaveBeenCalled();
    await commit();
    expect(updates).toHaveBeenCalledTimes(1);
    const res = await a.query(`SELECT ?e ?p WHERE { GRAPH <${em.graphUri()}> { ?e <urn:shared:ontology#cog/precededBy> ?p } }`);
    expect((res.bindings ?? []).map((b) => `${b.e.value}>${b.p.value}`)).toEqual([`${uris[1]}>${uris[0]}`]);
  });
});
