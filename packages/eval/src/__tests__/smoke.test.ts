import { describe, it, expect } from 'vitest';
import type { MemoryBackend, Scenario } from '../types.js';
import { AnswerLlm } from '../answerLlm.js';
import { FakeProvider } from '../fakeProvider.js';
import { OfflineHashingEmbedder } from '../embedder.js';
import { OfflineLexicalJudge, renderMarkdown } from '../scorer.js';
import { NoMemoryBackend } from '../backends/NoMemoryBackend.js';
import { VectorRagBackend } from '../backends/VectorRagBackend.js';
import { SemanticBackend } from '../backends/SemanticBackend.js';
import { runPilot } from '../harness.js';

function makeLlm() {
  return new AnswerLlm({ provider: new FakeProvider(), model: 'fake', temperature: 0 });
}
function makeBackends(): MemoryBackend[] {
  return [
    new SemanticBackend(),
    new VectorRagBackend({ embedder: new OfflineHashingEmbedder() }),
    new NoMemoryBackend(),
  ];
}
const cell = (report: Awaited<ReturnType<typeof runPilot>>, cat: string, backend: string) =>
  report.cells.find((c) => c.category === cat && c.backend === backend)!;

/** A tiny scenario touching several gold types, kept small for speed. */
const tinyScenario: Scenario = {
  id: 'tiny',
  agentId: 'ontofelia',
  userId: 'alice',
  turns: [
    {
      kind: 'assert',
      id: 't1',
      text: 'I work on the Helios project.',
      fact: { s: 'Alice', p: 'worksOn', o: 'Helios', sType: 'Person', oType: 'Concept' },
      entities: ['Alice'],
    },
    { kind: 'pad', count: 5 },
    {
      kind: 'probe',
      id: 'p1',
      category: 'H1',
      query: 'What project do I work on?',
      paraphrases: ['Which project am I on?'],
      entities: ['Alice'],
      gold: { type: 'exact', value: 'Helios' },
    },
    {
      kind: 'mutate',
      id: 't2',
      text: 'Actually I live in Berlin now.',
      fact: { s: 'User', p: 'livesIn', o: 'Berlin', sType: 'Person', oType: 'Place' },
      supersedes: 'livesIn',
      entities: ['alice'],
    },
    {
      kind: 'probe',
      id: 'p2',
      category: 'H3',
      query: 'Where do I live?',
      entities: ['alice'],
      gold: { type: 'value+flag', value: 'Berlin', expectConflictFlag: true },
    },
  ],
};

describe('offline smoke: runner → scorer over all three backends', () => {
  it('produces a per-category × backend table with no network', async () => {
    const report = await runPilot(makeBackends(), [tinyScenario], makeLlm(), {
      judge: new OfflineLexicalJudge(),
    });

    expect(report.backends).toEqual(['semantic', 'vector-rag', 'no-memory']);
    expect(report.categories.sort()).toEqual(['H1', 'H3']);
    expect(report.cells.length).toBe(report.categories.length * report.backends.length);
    for (const c of report.cells) {
      expect(c.n).toBeGreaterThan(0);
      expect(c.meanScore).toBeGreaterThanOrEqual(0);
      expect(c.meanScore).toBeLessThanOrEqual(1);
    }

    const md = renderMarkdown(report);
    expect(md).toContain('| Category |');
    expect(md).toContain('semantic');
    expect(md).toContain('Cost & latency');
  });

  it('no-memory loses a past-window fact (recall/multi-hop), semantic recovers it', async () => {
    // Pad far beyond the rolling window so the fact AND its join inputs are
    // evicted: with no persistence the answer LLM cannot recover them, but the
    // semantic store can — including a genuine multi-hop join.
    const overflow: Scenario = {
      id: 'overflow',
      agentId: 'ontofelia',
      userId: 'alice',
      turns: [
        {
          kind: 'assert', id: 't1', text: 'I work on the Helios project.',
          fact: { s: 'Alice', p: 'worksOn', o: 'Helios', sType: 'Person', oType: 'Concept' },
          entities: ['Alice'],
        },
        {
          kind: 'assert', id: 't1b', text: 'Helios uses Python.',
          fact: { s: 'Helios', p: 'usesTool', o: 'Python', sType: 'Concept', oType: 'Concept' },
          entities: ['Helios'],
        },
        { kind: 'pad', count: 60 },
        {
          kind: 'probe', id: 'p1', category: 'H1',
          query: 'What project do I work on?', entities: ['Alice'],
          gold: { type: 'exact', value: 'Helios' },
        },
        {
          kind: 'probe', id: 'p2', category: 'H2',
          query: 'Which tools do the projects I work on use?',
          entities: ['Alice'], hops: ['worksOn', 'usesTool'],
          gold: { type: 'set', value: ['Python'], candidates: ['Python', 'Rust', 'Go'] },
        },
      ],
    };
    const report = await runPilot([new NoMemoryBackend(), new SemanticBackend()], [overflow], makeLlm(), {});

    // Past-window recall: no-memory cannot recover, semantic can.
    expect(cell(report, 'H1', 'no-memory').meanScore).toBe(0);
    expect(cell(report, 'H1', 'semantic').meanScore).toBe(1);
    // Multi-hop join: only the semantic store can compose worksOn ∘ usesTool.
    expect(cell(report, 'H2', 'no-memory').meanScore).toBe(0);
    expect(cell(report, 'H2', 'semantic').meanScore).toBeGreaterThan(0);
  });

  it('semantic surfaces a conflict flag on a superseded fact; vector-rag does NOT', async () => {
    // After a functional-property supersession, only the semantic backend
    // detects the conflict (belief revision). The fake flags a conflict ONLY
    // from a backend-emitted [CONFLICT] marker — never from "Actually …" words
    // sitting in the rolling window — so vector-rag must score the flag at 0.
    const conflictScenario: Scenario = {
      id: 'conflict',
      agentId: 'ontofelia',
      userId: 'alice',
      turns: [
        {
          kind: 'assert', id: 't1', text: 'I live in Munich.',
          fact: { s: 'User', p: 'livesIn', o: 'Munich', sType: 'Person', oType: 'Place' },
          entities: ['alice'],
        },
        {
          kind: 'mutate', id: 't2', text: 'Actually I live in Berlin now.',
          fact: { s: 'User', p: 'livesIn', o: 'Berlin', sType: 'Person', oType: 'Place' },
          supersedes: 'livesIn', entities: ['alice'],
        },
        { kind: 'pad', count: 30 },
        {
          kind: 'probe', id: 'p1', category: 'H3',
          query: 'Where do I live now?', entities: ['alice'],
          gold: { type: 'value+flag', value: 'Berlin', expectConflictFlag: true },
        },
      ],
    };
    const report = await runPilot(makeBackends(), [conflictScenario], makeLlm(), {});

    // Conflict-flag (secondary) is the differentiator: semantic flags, the
    // chunk-retrieval backends do not (the rolling "Actually …" turn must not
    // leak a flag).
    expect(cell(report, 'H3', 'semantic').meanSecondary).toBe(1);
    expect(cell(report, 'H3', 'vector-rag').meanSecondary).toBe(0);
    expect(cell(report, 'H3', 'no-memory').meanSecondary).toBe(0);
  });

  it('H5 constraint is scored on real backend detection, not lexical match', async () => {
    // Two values for a functional property → the semantic backend surfaces a
    // constraint violation at ingest. no-memory surfaces nothing, so it must
    // NOT score 1.00 on H5 (the old artifact).
    const constraintScenario: Scenario = {
      id: 'constraint',
      agentId: 'ontofelia',
      userId: 'bob',
      turns: [
        {
          kind: 'assert', id: 't1', text: 'I am 17 years old.',
          fact: { s: 'Bob', p: 'hasAge', o: '17', sType: 'Person', oType: 'literal' }, entities: ['Bob'],
        },
        {
          kind: 'assert', id: 't2', text: 'I am 42 years old.',
          fact: { s: 'Bob', p: 'hasAge', o: '42', sType: 'Person', oType: 'literal' }, entities: ['Bob'],
        },
        { kind: 'pad', count: 30 },
        {
          kind: 'probe', id: 'p1', category: 'H5',
          query: 'I said I am both 17 and 42. One age only. Is that consistent?',
          entities: ['Bob'], gold: { type: 'constraint', expectRejectOrFlag: true },
        },
      ],
    };
    const report = await runPilot(makeBackends(), [constraintScenario], makeLlm(), {});
    expect(cell(report, 'H5', 'semantic').meanScore).toBe(1);
    expect(cell(report, 'H5', 'no-memory').meanScore).toBe(0);
    expect(cell(report, 'H5', 'vector-rag').meanScore).toBe(0);
  });

  it("the 'memory' adapter (no-op stub) is rejected, not silently scored 0", () => {
    expect(() => new SemanticBackend({ adapter: 'memory' })).toThrow(/non-functional stub/);
  });
});
