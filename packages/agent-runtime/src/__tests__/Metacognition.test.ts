import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphUriResolver } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { Metacognition } from '../cognitive/Metacognition.js';

// Metacognition projects typed SPARQL, so these run against embedded Oxigraph
// rather than the SPARQL-less InMemoryAdapter.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const PHASE = `urn:${AGENT}:cog:cycle:c1_4`;

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/meta-test-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

const WIDE = { since: new Date('2000-01-01T00:00:00Z'), until: new Date('2100-01-01T00:00:00Z') };

async function countType(
  store: TriplestoreAdapter,
  graph: string,
  type: string,
): Promise<number> {
  const res = await store.query(`
    SELECT ?s WHERE { GRAPH <${graph}> { ?s a <${type}> } }`);
  return (res.bindings ?? []).length;
}

describe('Metacognition', () => {
  let store: TriplestoreAdapter;
  let meta: Metacognition;
  let metaGraph: string;

  beforeEach(async () => {
    store = await makeStore();
    meta = new Metacognition(store, AGENT);
    metaGraph = GraphUriResolver.getCogMetaGraph(AGENT);
  });

  it('flags an ordinary impasse as cogt:Impasse', async () => {
    const f = await meta.flagImpasse({
      kind: 'tool-error',
      flaggedInPhase: PHASE,
      context: 'fs_read failed: ENOENT',
      cycleId: 'c1',
    });
    expect(f.chronic).toBe(false);
    expect(f.kind).toBe('tool-error');
    expect(await countType(store, metaGraph, `${COGT}Impasse`)).toBe(1);
    expect(await countType(store, metaGraph, `${COGT}ChronicImpasse`)).toBe(0);
  });

  it('promotes an over-cap impasse kind to cogt:ChronicImpasse', async () => {
    const base = new Date('2026-05-20T10:00:00Z');
    // action-selection-empty cap is 5; raise 5 within 24h, the 6th is chronic.
    for (let i = 0; i < 5; i++) {
      const f = await meta.flagImpasse({
        kind: 'action-selection-empty',
        flaggedInPhase: PHASE,
        context: `attempt ${i}`,
        occurredAt: new Date(base.getTime() + i * 60_000),
      });
      expect(f.chronic).toBe(false);
    }
    const sixth = await meta.flagImpasse({
      kind: 'action-selection-empty',
      flaggedInPhase: PHASE,
      context: 'attempt 5',
      occurredAt: new Date(base.getTime() + 6 * 60_000),
    });
    expect(sixth.chronic).toBe(true);
    expect(await countType(store, metaGraph, `${COGT}Impasse`)).toBe(5);
    expect(await countType(store, metaGraph, `${COGT}ChronicImpasse`)).toBe(1);
  });

  it('does not count impasses older than 24h toward the cap', async () => {
    const now = new Date('2026-05-20T10:00:00Z');
    const old = new Date(now.getTime() - 48 * 3_600_000);
    for (let i = 0; i < 5; i++) {
      await meta.flagImpasse({
        kind: 'goal-conflict',
        flaggedInPhase: PHASE,
        context: 'stale',
        occurredAt: old,
      });
    }
    const fresh = await meta.flagImpasse({
      kind: 'goal-conflict',
      flaggedInPhase: PHASE,
      context: 'fresh',
      occurredAt: now,
    });
    expect(fresh.chronic).toBe(false);
  });

  it('stamps resolution, resolvedBy and resolvedAt on resolveImpasse', async () => {
    const f = await meta.flagImpasse({
      kind: 'tool-timeout',
      flaggedInPhase: PHASE,
      context: 'timed out',
    });
    await meta.resolveImpasse(f.id, 'skip', 'metacog', new Date('2026-05-21T09:00:00Z'));
    const res = await store.query(`
      SELECT ?r ?b ?a WHERE { GRAPH <${metaGraph}> {
        <${f.id}> <${COGT}resolution> ?r ; <${COGT}resolvedBy> ?b ; <${COGT}resolvedAt> ?a . } }`);
    const row = res.bindings?.[0];
    expect(row?.r.value).toBe('skip');
    expect(row?.b.value).toBe('metacog');
    expect(row?.a.value).toContain('2026-05-21T09:00:00');
  });

  it('picks resolutions from the policy table and escalates under chronic/retry', () => {
    const fresh = { attempt: 0, recentDensity: 0, chronic: false };
    const retried = { attempt: 1, recentDensity: 0, chronic: false };
    const chronic = { attempt: 0, recentDensity: 9, chronic: true };

    expect(meta.pickResolution('action-selection-empty', fresh)).toBe('retry');
    expect(meta.pickResolution('action-selection-empty', retried)).toBe('ask-user');
    expect(meta.pickResolution('tool-error', fresh)).toBe('retry');
    expect(meta.pickResolution('tool-error', retried)).toBe('skip');
    expect(meta.pickResolution('goal-conflict', fresh)).toBe('change-goal');
    expect(meta.pickResolution('tool-policy-denied-all', fresh)).toBe('ask-user');
    // Chronic always short-circuits to ask-user, whatever the kind.
    expect(meta.pickResolution('tool-error', chronic)).toBe('ask-user');
  });

  it('writes a full ReflectiveMarker with all signal fields', async () => {
    const cycleUri = `urn:${AGENT}:cog:cycle:c9`;
    const id = await meta.writeMarker({
      cycleUri,
      cycleStatus: 'impasse-resolved',
      goalProgress: 'advanced',
      uncertainty: 'high',
      toolsUsed: 3,
      toolErrors: 1,
      emptyRetrieval: false,
      goalDrift: true,
      toolChurn: false,
      constraintPressure: 2,
      flaggedImpasse: [`urn:${AGENT}:cog:impasse:x`],
      resolvedImpasse: [`urn:${AGENT}:cog:impasse:x`],
      noted: 'retried then skipped',
    });
    const res = await store.query(`
      SELECT ?status ?drift ?errors ?pressure ?reflects WHERE { GRAPH <${metaGraph}> {
        <${id}> <${COGT}cycleStatus> ?status ; <${COGT}reflectsOn> ?reflects ;
                <${COGT}goalDrift> ?drift ; <${COGT}toolErrors> ?errors ;
                <${COGT}constraintPressure> ?pressure . } }`);
    const row = res.bindings?.[0];
    expect(row?.status.value).toBe('impasse-resolved');
    expect(row?.reflects.value).toBe(cycleUri);
    expect(row?.drift.value).toBe('true');
    expect(row?.errors.value).toBe('1');
    expect(row?.pressure.value).toBe('2');
  });

  it('crossCycleScan raises a chronic impasse + long-term goal for a recurring kind', async () => {
    for (let i = 0; i < 3; i++) {
      await meta.flagImpasse({
        kind: 'tool-error',
        flaggedInPhase: PHASE,
        context: `err ${i}`,
        occurredAt: new Date(`2026-05-2${i}T10:00:00Z`),
      });
    }
    const report = await meta.crossCycleScan(WIDE);
    expect(report.chronicImpassesRaised).toBe(1);
    expect(report.longtermGoalsCreated).toBe(1);
    expect(await countType(store, metaGraph, `${COGT}ChronicImpasse`)).toBe(1);

    const goalsGraph = GraphUriResolver.getCogGoalsLongtermGraph(AGENT);
    const goals = await store.query(`
      SELECT ?g ?type WHERE { GRAPH <${goalsGraph}> {
        ?g a <${COGT}Goal> ; <${COGT}goalType> ?type ; <${COGT}goalStatus> "active" . } }`);
    expect((goals.bindings ?? []).length).toBe(1);
    expect(goals.bindings?.[0]?.type.value).toBe(`${COGT}ResolveChronicImpasse`);

    // Idempotent: a second scan must not duplicate the long-term goal.
    const second = await meta.crossCycleScan(WIDE);
    expect(second.longtermGoalsCreated).toBe(1); // still raises, but de-dupes the write
    const goals2 = await store.query(`
      SELECT ?g WHERE { GRAPH <${goalsGraph}> {
        ?g a <${COGT}Goal> ; <${COGT}goalStatus> "active" . } }`);
    expect((goals2.bindings ?? []).length).toBe(1);
  });

  it('crossCycleScan raises a CapabilityGap when constraint pressure accumulates', async () => {
    await meta.writeMarker({
      cycleUri: `urn:${AGENT}:cog:cycle:a`,
      cycleStatus: 'completed',
      constraintPressure: 3,
      createdAt: new Date('2026-05-20T10:00:00Z'),
    });
    await meta.writeMarker({
      cycleUri: `urn:${AGENT}:cog:cycle:b`,
      cycleStatus: 'completed',
      constraintPressure: 4,
      createdAt: new Date('2026-05-20T11:00:00Z'),
    });
    const report = await meta.crossCycleScan(WIDE);
    expect(report.capabilityGapsRaised).toBe(1);
    expect(await countType(store, metaGraph, `${COGT}CapabilityGap`)).toBe(1);
  });

  it('crossCycleScan reports drift when it dominates the window', async () => {
    // 2 of 3 cycles drift = 0.66 > 0.3 threshold.
    await meta.writeMarker({
      cycleUri: `urn:${AGENT}:cog:cycle:d1`,
      cycleStatus: 'completed',
      goalDrift: true,
      createdAt: new Date('2026-05-20T10:00:00Z'),
    });
    await meta.writeMarker({
      cycleUri: `urn:${AGENT}:cog:cycle:d2`,
      cycleStatus: 'completed',
      goalDrift: true,
      createdAt: new Date('2026-05-20T11:00:00Z'),
    });
    await meta.writeMarker({
      cycleUri: `urn:${AGENT}:cog:cycle:d3`,
      cycleStatus: 'completed',
      goalDrift: false,
      createdAt: new Date('2026-05-20T12:00:00Z'),
    });
    const report = await meta.crossCycleScan(WIDE);
    expect(report.driftDetected).toBe(true);
    expect(report.cyclesScanned).toBe(3);
  });
});
