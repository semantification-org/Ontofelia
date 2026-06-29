import { describe, it, expect, beforeEach } from 'vitest';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { ProceduralMemory, type TraceInput } from '../cognitive/ProceduralMemory.js';

// Procedural memory is a SPARQL projection, so these run against the embedded
// Oxigraph store rather than the SPARQL-less InMemoryAdapter.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const WRITE_DOC = `${COGT}WriteConceptDoc`;
const ANSWER = `${COGT}AnswerQuestion`;

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/proc-test-${Math.random().toString(16).slice(2)}`,
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
    executedAt: new Date('2026-05-20T10:00:00Z'),
    durationMs: 100,
    outcome: 'success',
    forGoalType: WRITE_DOC,
    sequencePos: 1,
    ...over,
  };
}

const WIDE = { since: new Date('2000-01-01T00:00:00Z'), until: new Date('2100-01-01T00:00:00Z') };

describe('ProceduralMemory', () => {
  let store: TriplestoreAdapter;
  let pm: ProceduralMemory;

  beforeEach(async () => {
    store = await makeStore();
    pm = new ProceduralMemory(store, AGENT);
  });

  it('targets the procedural graph', () => {
    expect(pm.graphUri()).toBe(`urn:${AGENT}:cog:procedural`);
  });

  it('records a trace and consolidation produces a Skill summary', async () => {
    await pm.recordTrace(trace({ outcome: 'success', durationMs: 100 }));
    await pm.recordTrace(trace({ outcome: 'success', durationMs: 200 }));
    await pm.recordTrace(trace({ outcome: 'error', durationMs: 50, errorClass: 'NotFound' }));

    const report = await pm.consolidate(WIDE);
    expect(report.tracesScanned).toBe(3);
    expect(report.skillsUpserted).toBe(1);

    const skills = await pm.suggestSkills(WRITE_DOC);
    expect(skills).toHaveLength(1);
    const s = skills[0];
    expect(s.toolName).toBe('fs_read');
    expect(s.successCount).toBe(2);
    expect(s.successRate).toBeCloseTo(2 / 3, 3);
    expect(s.meanDurationMs).toBeCloseTo((100 + 200 + 50) / 3, 1);
  });

  it('backfillSatisfaction feeds satisfactionRate through consolidation', async () => {
    const a = await pm.recordTrace(trace({ outcome: 'success' }));
    const b = await pm.recordTrace(trace({ outcome: 'success' }));
    await pm.backfillSatisfaction(a, true);
    await pm.backfillSatisfaction(b, false);

    await pm.consolidate(WIDE);
    const [s] = await pm.suggestSkills(WRITE_DOC);
    expect(s.successCount).toBe(2);
    expect(s.satisfactionRate).toBeCloseTo(0.5, 3); // 1 satisfied of 2 successes
  });

  it('ranks skills by satisfactionRate * successRate', async () => {
    // fs_read: perfect success + satisfied
    const r1 = await pm.recordTrace(trace({ toolName: 'fs_read', outcome: 'success' }));
    await pm.backfillSatisfaction(r1, true);
    // fs_write: success but never satisfied -> lower score
    await pm.recordTrace(trace({ toolName: 'fs_write', outcome: 'success' }));

    await pm.consolidate(WIDE);
    const ranked = await pm.suggestSkills(WRITE_DOC, 5);
    expect(ranked[0].toolName).toBe('fs_read');
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('mints a SequenceSkill only after the pattern recurs >= 3 cycles', async () => {
    const mkCycle = async (cycleId: string) => {
      await pm.recordTrace(trace({ toolName: 'fs_list', cycleId, sequencePos: 1 }));
      await pm.recordTrace(trace({ toolName: 'fs_read', cycleId, sequencePos: 2 }));
      await pm.recordTrace(trace({ toolName: 'fs_write', cycleId, sequencePos: 3 }));
    };

    // Two cycles: below threshold, nothing minted.
    await mkCycle('c1');
    await mkCycle('c2');
    let report = await pm.consolidate(WIDE);
    expect(report.sequenceSkillsCreated).toBe(0);
    expect(await pm.suggestSequenceSkills(WRITE_DOC)).toHaveLength(0);

    // A fresh window with three occurrences crosses the threshold.
    await mkCycle('c3');
    await mkCycle('c4');
    await mkCycle('c5');
    report = await pm.consolidate(WIDE);
    expect(report.sequenceSkillsCreated).toBe(1);

    const seqs = await pm.suggestSequenceSkills(WRITE_DOC);
    expect(seqs).toHaveLength(1);
    expect(seqs[0].steps.map((s) => s.toolName)).toEqual(['fs_list', 'fs_read', 'fs_write']);
  });

  it('isolates skills by goal type', async () => {
    await pm.recordTrace(trace({ toolName: 'fs_read', forGoalType: WRITE_DOC }));
    await pm.recordTrace(trace({ toolName: 'sparql_query', forGoalType: ANSWER }));
    await pm.consolidate(WIDE);

    const writeSkills = await pm.suggestSkills(WRITE_DOC);
    const answerSkills = await pm.suggestSkills(ANSWER);
    expect(writeSkills.map((s) => s.toolName)).toEqual(['fs_read']);
    expect(answerSkills.map((s) => s.toolName)).toEqual(['sparql_query']);
  });
});
