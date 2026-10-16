import { describe, it, expect, beforeEach } from 'vitest';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import {
  ProceduralMemory,
  DURATION_WINDOW,
  FOLLOWUP_SATISFACTION_WEIGHT,
  type TraceInput,
} from '../cognitive/ProceduralMemory.js';

// Procedural memory completion: suggestion filter, cumulative p95, weighted
// follow-up signal, masked-arg hashes, per-user follow-up lookup, 90-day purge.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const GOAL = `${COGT}AnswerQuestion`;
const PROC = `urn:${AGENT}:cog:procedural`;
const BASE = Date.parse('2026-05-20T10:00:00Z');
const WIDE = { since: new Date('2000-01-01T00:00:00Z'), until: new Date('2100-01-01T00:00:00Z') };

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/proc-completion-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

function trace(over: Partial<TraceInput> = {}): TraceInput {
  return {
    toolName: 'fs_read',
    toolArgsHash: 'h0',
    toolArgsBrief: 'path',
    executedAt: new Date(BASE),
    durationMs: 100,
    outcome: 'success',
    forGoalType: GOAL,
    sequencePos: 1,
    ...over,
  };
}

describe('ProceduralMemory completion', () => {
  let store: TriplestoreAdapter;
  let pm: ProceduralMemory;

  const skillValue = async (tool: string, pred: string): Promise<string | undefined> => {
    const r = await store.query(
      `SELECT ?v WHERE { GRAPH <${PROC}> { ?s a <${COGT}Skill> ; <${COGT}toolName> "${tool}" ; <${COGT}${pred}> ?v } }`,
    );
    return r.bindings?.[0]?.v.value;
  };

  beforeEach(async () => {
    store = await makeStore();
    pm = new ProceduralMemory(store, AGENT);
  });

  it('filters suggestions by success rate and sample count', async () => {
    const add = async (tool: string, ok: number, bad: number) => {
      for (let i = 0; i < ok; i++) await pm.recordTrace(trace({ toolName: tool, executedAt: new Date(BASE + i) }));
      for (let i = 0; i < bad; i++)
        await pm.recordTrace(trace({ toolName: tool, outcome: 'error', executedAt: new Date(BASE + 100 + i) }));
    };
    await add('good_tool', 10, 0);
    await add('edge_tool', 7, 3); // exactly 0.7: kept
    await add('low_tool', 2, 3); // 0.4: dropped
    await add('thin_tool', 2, 0); // 2 samples: dropped
    await pm.consolidate(WIDE);

    const all = (await pm.suggestSkills(GOAL, 10)).map((s) => s.toolName).sort();
    expect(all).toEqual(['edge_tool', 'good_tool', 'low_tool', 'thin_tool']);
    const kept = await pm.suggestSkills(GOAL, 10, { minSuccessRate: 0.7, minSamples: 3 });
    expect(kept.map((s) => s.toolName).sort()).toEqual(['edge_tool', 'good_tool']);
    expect(kept.find((s) => s.toolName === 'edge_tool')?.sampleCount).toBe(10);
  });

  it('computes the cumulative p95 over the windowed history, not over the last batch only', async () => {
    // Durations 1..100 in two consolidation windows: 1..50, then 51..100.
    for (let i = 1; i <= 50; i++) await pm.recordTrace(trace({ durationMs: i, executedAt: new Date(BASE + i * 1000) }));
    await pm.consolidate({ since: new Date(BASE), until: new Date(BASE + 50_500) });
    expect(Number(await skillValue('fs_read', 'p95DurationMs'))).toBe(48); // nearest rank of 1..50
    for (let i = 51; i <= 100; i++) await pm.recordTrace(trace({ durationMs: i, executedAt: new Date(BASE + i * 1000) }));
    await pm.consolidate({ since: new Date(BASE + 50_500), until: new Date(BASE + 200_000) });
    // The last batch alone would give 98; the cumulative sample 1..100 gives 95.
    expect(Number(await skillValue('fs_read', 'p95DurationMs'))).toBe(95);
    const [s] = await pm.suggestSkills(GOAL, 5);
    expect(s.p95DurationMs).toBe(95);
  });

  it('bounds the p95 sample to the latest durations', async () => {
    const n = DURATION_WINDOW + 50; // durations 1..250
    for (let i = 1; i <= n; i++) await pm.recordTrace(trace({ durationMs: i, executedAt: new Date(BASE + i * 1000) }));
    await pm.consolidate(WIDE);
    // Window = 51..250 (200 values); nearest-rank p95 is the 190th = 240.
    expect(Number(await skillValue('fs_read', 'p95DurationMs'))).toBe(240);
  });

  it('weights the follow-up signal low and lets dissatisfaction offset it', async () => {
    const a = await pm.recordTrace(trace({ executedAt: new Date(BASE + 1) }));
    const b = await pm.recordTrace(trace({ executedAt: new Date(BASE + 2) }));
    const c = await pm.recordTrace(trace({ executedAt: new Date(BASE + 3) }));
    const d = await pm.recordTrace(trace({ executedAt: new Date(BASE + 4) }));
    await pm.backfillSatisfaction(a, true, FOLLOWUP_SATISFACTION_WEIGHT);
    await pm.backfillSatisfaction(b, true, FOLLOWUP_SATISFACTION_WEIGHT);
    await pm.backfillSatisfaction(c, false, FOLLOWUP_SATISFACTION_WEIGHT);
    // d stays unjudged
    expect(d).toBeTruthy();
    await pm.consolidate(WIDE);
    // (0.3 + 0.3 - 0.3) / 4 successes
    const [s] = await pm.suggestSkills(GOAL, 5);
    expect(s.satisfactionRate).toBeCloseTo(0.075, 4);
  });

  it('keeps the earlier arithmetic for signals without a weight', async () => {
    const a = await pm.recordTrace(trace({ executedAt: new Date(BASE + 1) }));
    const b = await pm.recordTrace(trace({ executedAt: new Date(BASE + 2) }));
    await pm.backfillSatisfaction(a, true);
    await pm.backfillSatisfaction(b, false);
    await pm.consolidate(WIDE);
    const [s] = await pm.suggestSkills(GOAL, 5);
    expect(s.satisfactionRate).toBeCloseTo(0.5, 4);
  });

  it('stores forUser and only digests of masked args, each with its scheme', async () => {
    const digest = 'a'.repeat(64);
    const uri = await pm.recordTrace(
      trace({
        forUser: 'alice',
        maskedArgs: [
          { path: 'headers.authorization', digest, scheme: 'hmac-sha256' },
          { path: 'raw.value', digest: 'sk' + '-test-000000000000000000000000' }, // not a digest: refused
          { path: 'bad path/with spaces', digest: 'b'.repeat(64) }, // no scheme: the unkeyed sha256 of older callers
        ],
      }),
    );
    const r = await store.query(`SELECT ?p ?o WHERE { GRAPH <${PROC}> { <${uri}> ?p ?o } }`);
    const byPred = new Map<string, string[]>();
    for (const b of r.bindings ?? []) byPred.set(b.p.value, [...(byPred.get(b.p.value) ?? []), b.o.value]);
    expect(byPred.get(`${COGT}forUser`)).toEqual(['alice']);
    expect((byPred.get(`${COGT}maskedArg`) ?? []).sort()).toEqual(
      [`headers.authorization=hmac-sha256:${digest}`, `bad_path_with_spaces=sha256:${'b'.repeat(64)}`].sort(),
    );
    const dump = JSON.stringify(r.bindings);
    expect(dump).not.toContain('sk-test');
  });

  it('finds the prior cycle per user, unjudged only, within the gap', async () => {
    const now = new Date(BASE + 3_600_000);
    // Alice: cycle c1 (older), c2 (newer, with a trimmed fraction ".4Z"); Bob: c3 (newest).
    await pm.recordTrace(trace({ cycleId: 'c1', sessionId: 's', forUser: 'alice', executedAt: new Date(BASE + 1_000) }));
    const a2 = await pm.recordTrace(trace({ cycleId: 'c2', sessionId: 's', forUser: 'alice', executedAt: new Date(BASE + 2_400) }));
    await pm.recordTrace(trace({ cycleId: 'c3', sessionId: 's', forUser: 'bob', executedAt: new Date(BASE + 3_000) }));
    await pm.recordTrace(trace({ cycleId: 'c4', sessionId: 's', executedAt: new Date(BASE + 4_000) })); // no forUser (legacy)

    expect(await pm.findPriorCycleTraceUris('s', 'cX', { forUser: 'alice', now })).toEqual([a2]);
    expect((await pm.findPriorCycleTraceUris('s', 'cX', { forUser: 'carol', now }))).toEqual([]);
    // Without a user filter the newest cycle wins, as before.
    expect(await pm.findPriorCycleTraceUris('s', 'cX')).toHaveLength(1);
    // Excluding the current cycle moves on to the previous one.
    expect(await pm.findPriorCycleTraceUris('s', 'c2', { forUser: 'alice', now })).toHaveLength(1);
    // Judged traces are not offered again.
    await pm.backfillSatisfaction(a2, true, FOLLOWUP_SATISFACTION_WEIGHT);
    expect(await pm.findPriorCycleTraceUris('s', 'cX', { forUser: 'alice', onlyUnjudged: true, now })).toEqual([]);
    // Too old to be what the user reacts to.
    expect(
      await pm.findPriorCycleTraceUris('s', 'cX', { forUser: 'bob', maxGapMs: 1_000, now: new Date(BASE + 3_600_000) }),
    ).toEqual([]);
  });

  it('records a per-cycle adherence summary with forUser', async () => {
    const uri = await pm.recordAdherenceSummary({
      cycleId: 'cyc-1', sessionId: 's', forUser: 'alice', executedAt: new Date(BASE),
      suggestedTools: 2, tracedCalls: 3, adheredCalls: 1,
    });
    const r = await store.query(`SELECT ?p ?o WHERE { GRAPH <${PROC}> { <${uri}> ?p ?o } }`);
    const m = new Map((r.bindings ?? []).map((b) => [b.p.value.replace(COGT, ''), b.o.value]));
    expect(m.get('forUser')).toBe('alice');
    expect(m.get('tracedCalls')).toBe('3');
    expect(m.get('adheredCalls')).toBe('1');
    expect(Number(m.get('adherenceRate'))).toBeCloseTo(0.3333, 3);
  });

  it('purges traces and summaries older than 90 days and keeps the aggregates', async () => {
    const now = new Date('2026-10-15T12:00:00Z');
    const old = new Date(now.getTime() - 91 * 86_400_000);
    const edge = new Date(now.getTime() - 89 * 86_400_000);
    const fresh = new Date(now.getTime() - 1_000);
    const oldUris: string[] = [];
    for (let i = 0; i < 3; i++) oldUris.push(await pm.recordTrace(trace({ executedAt: new Date(old.getTime() + i * 1000) })));
    const edgeUri = await pm.recordTrace(trace({ executedAt: edge }));
    const freshUri = await pm.recordTrace(trace({ executedAt: fresh }));
    await pm.recordAdherenceSummary({ cycleId: 'old', forUser: 'u', executedAt: old, suggestedTools: 1, tracedCalls: 1, adheredCalls: 1 });
    await pm.recordAdherenceSummary({ cycleId: 'new', forUser: 'u', executedAt: fresh, suggestedTools: 1, tracedCalls: 1, adheredCalls: 0 });
    await pm.consolidate({ since: new Date(0), until: new Date(now.getTime() + 1000) });
    const before = await pm.suggestSkills(GOAL, 5);
    expect(before).toHaveLength(1);
    expect(before[0].successCount).toBe(5);

    const report = await pm.purgeOldTraces(now);
    expect(report.tracesDropped).toBe(3);
    expect(report.summariesDropped).toBe(1);

    const left = await store.query(
      `SELECT ?t WHERE { GRAPH <${PROC}> { ?t a <${COGT}SkillTrace> } }`,
    );
    expect((left.bindings ?? []).map((b) => b.t.value).sort()).toEqual([edgeUri, freshUri].sort());
    for (const u of oldUris) {
      const gone = await store.query(`SELECT ?p WHERE { GRAPH <${PROC}> { <${u}> ?p ?o } }`);
      expect(gone.bindings).toHaveLength(0);
      const link = await store.query(`SELECT ?s WHERE { GRAPH <${PROC}> { ?s <${COGT}hasTrace> <${u}> } }`);
      expect(link.bindings).toHaveLength(0);
    }
    const sums = await store.query(`SELECT ?s WHERE { GRAPH <${PROC}> { ?s a <${COGT}AdherenceSummary> } }`);
    expect(sums.bindings).toHaveLength(1);
    // The skill aggregate is untouched.
    const after = await pm.suggestSkills(GOAL, 5);
    expect(after).toEqual(before);

    // A second run is a no-op.
    const again = await pm.purgeOldTraces(now);
    expect(again.tracesDropped + again.summariesDropped).toBe(0);
  });
});
