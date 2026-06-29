import { describe, it, expect, beforeEach } from 'vitest';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '@ontofelia/semantic-memory';
import { CogHealth } from '../cognitive/CogHealth.js';

// CogHealth is a read-only SPARQL projection; it runs against embedded Oxigraph.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const EPI = `urn:${AGENT}:cog:episodic`;
const PROC = `urn:${AGENT}:cog:procedural`;
const GOALS = `urn:${AGENT}:cog:goals:longterm`;
const META = `urn:${AGENT}:cog:meta`;
const CYCLES = `urn:${AGENT}:cog:cycles:sess1`;

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/cog-health-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

const dt = (iso: string) => `"${iso}"^^<${XSD}dateTime>`;

describe('CogHealth', () => {
  let store: TriplestoreAdapter;
  let ch: CogHealth;
  const NOW = new Date('2026-06-01T12:00:00.000Z');

  async function insert(graph: string, triples: string): Promise<void> {
    await store.update(`INSERT DATA { GRAPH <${graph}> {\n${triples}\n} }`);
  }

  beforeEach(async () => {
    store = await makeStore();
    ch = new CogHealth(store, AGENT);

    await insert(
      EPI,
      `<urn:e:1> <${RDF_TYPE}> <${COGT}Episode> ; <${COGT}occurredAt> ${dt('2026-05-31T18:04:35.000Z')} ; <${COGT}payload> "hi" .`,
    );
    await insert(
      PROC,
      `<urn:s:1> <${RDF_TYPE}> <${COGT}Skill> ; <${COGT}updatedAt> ${dt('2026-05-31T18:12:00.000Z')} .
       <urn:s:2> <${RDF_TYPE}> <${COGT}Skill> .
       <urn:q:1> <${RDF_TYPE}> <${COGT}SequenceSkill> .`,
    );
    await insert(
      GOALS,
      `<urn:g:1> <${RDF_TYPE}> <${COGT}Goal> ; <${COGT}goalStatus> "active" .
       <urn:g:2> <${RDF_TYPE}> <${COGT}Goal> ; <${COGT}goalStatus> "resolved" .
       <urn:g:3> <${RDF_TYPE}> <${COGT}Goal> ; <${COGT}goalStatus> "resolved" .
       <urn:g:4> <${RDF_TYPE}> <${COGT}Goal> ; <${COGT}goalStatus> "abandoned" .`,
    );

    // Two cycles; cyc2 is newest and has an impasse marker.
    await insert(
      CYCLES,
      `<urn:${AGENT}:cog:cycle:cyc1> <${RDF_TYPE}> <${COGT}Cycle> ; <${COGT}cycleStatus> "completed" ; <${COGT}startedAt> ${dt('2026-06-01T11:00:00.000Z')} ; <${COGT}endedAt> ${dt('2026-06-01T11:00:00.400Z')} .
       <urn:${AGENT}:cog:cycle:cyc2> <${RDF_TYPE}> <${COGT}Cycle> ; <${COGT}cycleStatus> "completed" ; <${COGT}startedAt> ${dt('2026-06-01T11:30:00.000Z')} ; <${COGT}endedAt> ${dt('2026-06-01T11:30:01.000Z')} .`,
    );
    await insert(
      META,
      `<urn:m:1> <${RDF_TYPE}> <${COGT}ReflectiveMarker> ; <${COGT}reflectsOn> <urn:${AGENT}:cog:cycle:cyc2> ; <${COGT}flaggedImpasse> "tool-error" ; <${COGT}createdAt> ${dt('2026-06-01T11:30:01.000Z')} .
       <urn:i:1> <${RDF_TYPE}> <${COGT}Impasse> ; <${COGT}flaggedAt> ${dt('2026-06-01T10:00:00.000Z')} .
       <urn:i:2> <${RDF_TYPE}> <${COGT}Impasse> ; <${COGT}flaggedAt> ${dt('2026-05-20T10:00:00.000Z')} .`,
    );
  });

  it('reports per-graph counts and last writes', async () => {
    const r = await ch.report(NOW);
    expect(r.agent).toBe(AGENT);
    expect(r.graphs['cog:episodic'].tripleCount).toBe(3);
    expect(r.graphs['cog:episodic'].lastWrite).toBe('2026-05-31T18:04:35Z');
    expect(r.graphs['cog:procedural'].skillCount).toBe(2);
    expect(r.graphs['cog:procedural'].sequenceSkillCount).toBe(1);
    expect(r.graphs['cog:goals:long']).toEqual({ active: 1, blocked: 0, resolved: 2, abandoned: 1 });
    expect(r.graphs['cog:meta'].markerCount).toBe(1);
    expect(r.graphs['cog:meta'].impassesLast24h).toBe(1); // i:1 within 24h, i:2 not
  });

  it('computes cycle latency over the recent cycles', async () => {
    const r = await ch.report(NOW);
    expect(r.cycle.lastCycleId).toBe('cyc2');
    // durations: cyc1=400ms, cyc2=1000ms → mean 700, p95 1000.
    expect(r.cycle.meanLatencyMsLast100).toBe(700);
    expect(r.cycle.p95LatencyMsLast100).toBe(1000);
    // 1 of 2 cycles flagged an impasse.
    expect(r.cycle.impasseRateLast100).toBe(0.5);
  });

  it('returns zeros for an empty store', async () => {
    const empty = new CogHealth(await makeStore(), AGENT);
    const r = await empty.report(NOW);
    expect(r.graphs['cog:episodic'].tripleCount).toBe(0);
    expect(r.cycle.meanLatencyMsLast100).toBe(0);
    expect(r.cycle.impasseRateLast100).toBe(0);
    expect(r.cycle.lastCycleId).toBeUndefined();
  });
});
