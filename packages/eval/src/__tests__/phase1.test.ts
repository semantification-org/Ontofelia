import { describe, it, expect } from 'vitest';
import type { ScoredRow, MemoryBackend, Scenario } from '../types.js';
import { analyze, renderAnalysisMarkdown } from '../analysis.js';
import { runSweep, type ModelSpec } from '../sweep.js';
import { AnswerLlm } from '../answerLlm.js';
import { FakeProvider } from '../fakeProvider.js';
import { OfflineHashingEmbedder } from '../embedder.js';
import { OfflineLexicalJudge, aggregate } from '../scorer.js';
import { NoMemoryBackend } from '../backends/NoMemoryBackend.js';
import { VectorRagBackend } from '../backends/VectorRagBackend.js';
import { SemanticBackend } from '../backends/SemanticBackend.js';
import { LlmJudge, JudgeSampler, cohensKappa, parseJudgeResponse, type JudgedItem } from '../llmJudge.js';
import type { ChatRequest, ChatResponse, ProviderAdapter } from '@ontofelia/core';

// --- synthetic scored rows: A clearly beats B on H2..H6, ties on H0 ---------
function synthRows(): ScoredRow[] {
  const rows: ScoredRow[] = [];
  const push = (
    category: ScoredRow['category'],
    backend: MemoryBackend['name'],
    n: number,
    scoreFn: (i: number) => number,
  ) => {
    for (let i = 0; i < n; i++) {
      rows.push({
        scenarioId: 's',
        probeId: `${category}-${i}`,
        category,
        backend,
        model: 'm1',
        paraphrase: 'q',
        answer: '',
        tokens: 0,
        latencyMs: 0,
        score: scoreFn(i),
      });
    }
  };
  // H0 control: both perfect (no A-advantage).
  push('H0', 'semantic', 12, () => 1);
  push('H0', 'vector-rag', 12, () => 1);
  // H2..H6: semantic all-correct, vector-rag all-wrong → strong A-advantage.
  for (const cat of ['H2', 'H3', 'H4', 'H5', 'H6'] as const) {
    push(cat, 'semantic', 12, () => 1);
    push(cat, 'vector-rag', 12, () => 0);
  }
  // H1: a graded near-tie.
  push('H1', 'semantic', 12, (i) => (i % 2 === 0 ? 0.6 : 0.5));
  push('H1', 'vector-rag', 12, (i) => (i % 2 === 0 ? 0.5 : 0.6));
  return rows;
}

describe('phase1: report table ↔ stats consistency (#987)', () => {
  it('cell.meanDecision equals the stats meanA/meanB for every category (value×secondary + paraphrase aggregation)', () => {
    const rows: ScoredRow[] = [];
    const mk = (
      cat: ScoredRow['category'],
      backend: MemoryBackend['name'],
      model: string,
      probe: number,
      para: string,
      score: number,
      secondary?: number,
    ): ScoredRow => ({
      scenarioId: 's', probeId: `${cat}-${probe}`, category: cat, backend, model,
      paraphrase: para, answer: '', tokens: 0, latencyMs: 0, score, secondary,
    });
    // A value+flag category (has secondary → decision = score×secondary) with
    // 2 models, 3 probes, 2 paraphrases each — exercises both aggregation axes.
    for (const model of ['m1', 'm2']) {
      for (let p = 0; p < 3; p++) {
        // semantic: value always right, flag mostly right
        rows.push(mk('H3', 'semantic', model, p, 'a', 1, p === 0 ? 0 : 1));
        rows.push(mk('H3', 'semantic', model, p, 'b', 1, 1));
        // vector-rag: value right, flag often wrong
        rows.push(mk('H3', 'vector-rag', model, p, 'a', 1, 0.5));
        rows.push(mk('H3', 'vector-rag', model, p, 'b', 1, 0));
        // a graded category (no secondary → decision = score)
        rows.push(mk('H2', 'semantic', model, p, 'a', 0.9));
        rows.push(mk('H2', 'semantic', model, p, 'b', 0.7));
        rows.push(mk('H2', 'vector-rag', model, p, 'a', 0.4));
        rows.push(mk('H2', 'vector-rag', model, p, 'b', 0.6));
      }
    }
    const report = aggregate(rows, ['semantic', 'vector-rag']);
    const res = analyze(rows, { bootstrapResamples: 200, seed: 1, bBackends: ['vector-rag'] });
    for (const cat of ['H2', 'H3'] as const) {
      const st = res.stats.find((s) => s.comparison === 'semantic-vs-vector-rag' && s.category === cat)!;
      const cellA = report.cells.find((c) => c.category === cat && c.backend === 'semantic')!;
      const cellB = report.cells.find((c) => c.category === cat && c.backend === 'vector-rag')!;
      expect(cellA.meanDecision).toBeCloseTo(st.meanA, 9);
      expect(cellB.meanDecision).toBeCloseTo(st.meanB, 9);
    }
  });
});

describe('phase1: analysis + verdict', () => {
  it('produces per-category paired stats, Holm-adjusted, with a SUPPORTED verdict', () => {
    const res = analyze(synthRows(), { bootstrapResamples: 1000, seed: 1, bBackends: ['vector-rag'] });
    const ab = res.stats.filter((s) => s.comparison === 'semantic-vs-vector-rag');
    expect(ab.length).toBe(7); // H0..H6

    // H0 is the control: no Holm adjustment (pAdjusted undefined).
    const h0 = ab.find((s) => s.category === 'H0')!;
    expect(h0.pAdjusted).toBeUndefined();
    expect(h0.meaningfulAAdvantage).toBe(false);

    // H2 should be a strong, rejected A-advantage.
    const h2 = ab.find((s) => s.category === 'H2')!;
    expect(h2.meanA).toBe(1);
    expect(h2.meanB).toBe(0);
    expect(h2.pAdjusted).toBeDefined();
    expect(h2.rejected).toBe(true);
    expect(h2.meaningfulAAdvantage).toBe(true);

    const v = res.verdicts.find((x) => x.comparison === 'semantic-vs-vector-rag')!;
    expect(v.archWins.length).toBeGreaterThanOrEqual(3);
    expect(v.h0NoAAdvantage).toBe(true);
    expect(v.supported).toBe(true);
    expect(v.line).toContain('SUPPORTED');

    const md = renderAnalysisMarkdown(res);
    expect(md).toContain('Statistical analysis');
    expect(md).toContain('p (Holm)');
    expect(md).toContain('VERDICT');
  });

  it('verdict is EFFECT-SIZE based, NOT significance-gated (large effect, tiny N)', () => {
    // 3 probes per arch category, A all-correct vs B all-wrong: a maximal effect
    // size (OR=∞, mean gap 1.0) but, at N=3, Holm does NOT reject (pAdj→1). The
    // pre-registered rule is effect-size based, so the verdict MUST be SUPPORTED
    // even though nothing is Holm-significant. (Old significance-gated code would
    // have reported NOT SUPPORTED here — the protocol-deviation bug.)
    const rows: ScoredRow[] = [];
    const push = (cat: ScoredRow['category'], backend: MemoryBackend['name'], fn: (i: number) => number) => {
      for (let i = 0; i < 3; i++) {
        rows.push({
          scenarioId: 's', probeId: `${cat}-${i}`, category: cat, backend, model: 'm1',
          paraphrase: 'q', answer: '', tokens: 0, latencyMs: 0, score: fn(i),
        });
      }
    };
    push('H0', 'semantic', () => 1);
    push('H0', 'vector-rag', () => 1);
    for (const cat of ['H2', 'H3', 'H4'] as const) {
      push(cat, 'semantic', () => 1);
      push(cat, 'vector-rag', () => 0);
    }
    const res = analyze(rows, { bootstrapResamples: 200, seed: 1, bBackends: ['vector-rag'] });
    const v = res.verdicts.find((x) => x.comparison === 'semantic-vs-vector-rag')!;
    // Effect-size wins on 3 categories despite no Holm rejection.
    expect(v.archWins.sort()).toEqual(['H2', 'H3', 'H4']);
    expect(v.supported).toBe(true);
    for (const cat of ['H2', 'H3', 'H4'] as const) {
      const st = res.stats.find((s) => s.comparison === 'semantic-vs-vector-rag' && s.category === cat)!;
      expect(st.meaningfulAAdvantage).toBe(true);
      expect(st.rejected).toBe(false); // significance NOT reached, yet still a win
      expect(st.pAdjusted).toBeDefined(); // significance still computed + reported
    }
  });

  it('aggregates paraphrases to ONE per-probe score before pairing (no pseudo-replication)', () => {
    // One probe with 3 paraphrases: A right on all 3, B right on 1 of 3. The
    // probe must contribute ONE paired item (A=1.0, B=0.333), NOT three.
    const rows: ScoredRow[] = [];
    const mk = (backend: MemoryBackend['name'], para: string, score: number): ScoredRow => ({
      scenarioId: 's', probeId: 'H2-0', category: 'H2', backend, model: 'm1',
      paraphrase: para, answer: '', tokens: 0, latencyMs: 0, score,
    });
    rows.push(mk('semantic', 'q1', 1), mk('semantic', 'q2', 1), mk('semantic', 'q3', 1));
    rows.push(mk('vector-rag', 'q1', 1), mk('vector-rag', 'q2', 0), mk('vector-rag', 'q3', 0));
    const res = analyze(rows, { bootstrapResamples: 100, seed: 1, bBackends: ['vector-rag'] });
    const h2 = res.stats.find((s) => s.comparison === 'semantic-vs-vector-rag' && s.category === 'H2')!;
    expect(h2.n).toBe(1); // ONE probe, not three paraphrase rows
    expect(h2.meanA).toBeCloseTo(1, 6);
    expect(h2.meanB).toBeCloseTo(1 / 3, 6); // mean over paraphrases
  });

  it('emits a NOT SUPPORTED verdict when A does not beat B', () => {
    const rows: ScoredRow[] = [];
    for (const backend of ['semantic', 'vector-rag'] as const) {
      for (const cat of ['H0', 'H2', 'H3', 'H4', 'H5', 'H6'] as const) {
        for (let i = 0; i < 12; i++) {
          rows.push({
            scenarioId: 's', probeId: `${cat}-${i}`, category: cat, backend, model: 'm1',
            paraphrase: 'q', answer: '', tokens: 0, latencyMs: 0, score: 1, // everyone perfect
          });
        }
      }
    }
    const res = analyze(rows, { bootstrapResamples: 500, seed: 2, bBackends: ['vector-rag'] });
    const v = res.verdicts[0];
    expect(v.supported).toBe(false);
    expect(v.line).toContain('NOT SUPPORTED');
  });
});

// --- multi-model sweep, offline ---------------------------------------------
const tinyScenario: Scenario = {
  id: 'tiny',
  agentId: 'ontofelia',
  userId: 'alice',
  turns: [
    {
      kind: 'assert', id: 't1', text: 'I work on the Helios project.',
      fact: { s: 'Alice', p: 'worksOn', o: 'Helios', sType: 'Person', oType: 'Concept' }, entities: ['Alice'],
    },
    { kind: 'pad', count: 30 },
    {
      kind: 'probe', id: 'p1', category: 'H1',
      query: 'What project do I work on?', entities: ['Alice'],
      gold: { type: 'exact', value: 'Helios' },
    },
  ],
};

describe('phase1: multi-model sweep (offline, fake provider)', () => {
  it('runs the benchmark per model and pools with model as a blocking factor', async () => {
    const makeBackends = (): MemoryBackend[] => [
      new SemanticBackend(),
      new VectorRagBackend({ embedder: new OfflineHashingEmbedder() }),
      new NoMemoryBackend(),
    ];
    const models: ModelSpec[] = ['fake-a', 'fake-b'].map((model) => ({
      model,
      makeLlm: () => new AnswerLlm({ provider: new FakeProvider(), model, temperature: 0 }),
      makeBackends,
    }));

    const sweep = await runSweep(models, [tinyScenario], {
      judge: new OfflineLexicalJudge(),
      analysis: { bootstrapResamples: 200, seed: 3 },
      concurrency: 2,
    });

    expect(sweep.models).toEqual(['fake-a', 'fake-b']);
    expect(Object.keys(sweep.perModel).sort()).toEqual(['fake-a', 'fake-b']);
    // Each per-model report carries its own analysis + verdicts.
    for (const m of sweep.models) {
      expect(sweep.perModel[m].analysis.verdicts.length).toBeGreaterThan(0);
    }
    // Pooled report has 2x the rows of one model (model kept distinct in pairing).
    expect(sweep.pooled.rows.length).toBe(sweep.perModel['fake-a'].rows.length * 2);
    expect(sweep.pooled.analysis.verdicts.length).toBeGreaterThan(0);
    // Semantic recovers the past-window fact; no-memory does not (sanity).
    const sem = sweep.pooled.cells.find((c) => c.category === 'H1' && c.backend === 'semantic')!;
    const nomem = sweep.pooled.cells.find((c) => c.category === 'H1' && c.backend === 'no-memory')!;
    expect(sem.meanScore).toBe(1);
    expect(nomem.meanScore).toBe(0);
  });
});

// --- LlmJudge (mockable) + κ -------------------------------------------------
class MockJudgeProvider implements ProviderAdapter {
  readonly name = 'mock-judge';
  constructor(private reply: (req: ChatRequest) => string) {}
  async initialize(): Promise<void> {}
  async healthCheck() {
    return { healthy: true, component: 'mock', checkedAt: new Date().toISOString() };
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const content = this.reply(req);
    return { id: 'm', content, toolCalls: [], finishReason: 'stop', usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
  async *chatStream() {
    yield { type: 'done', response: await this.chat({} as ChatRequest) } as never;
  }
}

describe('phase1: LlmJudge + κ export', () => {
  it('LlmJudge parses a strict-JSON rubric reply and feeds the sampler', async () => {
    const sampler = new JudgeSampler(1, 1); // rate=1 → always record
    const provider = new MockJudgeProvider((req) => {
      const u = req.messages.find((m) => m.role === 'user')!.content as string;
      // Correct iff the gold token appears in the answer.
      const gold = /GOLD: (.*)/.exec(u)?.[1] ?? '';
      const ans = /ANSWER: (.*)/.exec(u)?.[1] ?? '';
      const score = ans.includes(gold) ? 1 : 0;
      return JSON.stringify({ score, rationale: 'mock' });
    });
    const judge = new LlmJudge({ provider, model: 'mock', sampler });

    const ok = await judge.judge({ question: 'name?', gold: 'Alice', answer: 'It is Alice.' });
    const bad = await judge.judge({ question: 'name?', gold: 'Bob', answer: 'I do not know.' });
    expect(ok.score).toBe(1);
    expect(bad.score).toBe(0);
    expect(sampler.sample.length).toBe(2);
    expect(sampler.sample.every((s) => s.humanScore === null)).toBe(true);
    // JSONL export round-trips.
    const lines = sampler.toJsonl().trim().split('\n');
    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0])).toHaveProperty('judgeScore');
  });

  it('parseJudgeResponse tolerates prose around the JSON and bare digits', () => {
    expect(parseJudgeResponse('blah {"score":1,"rationale":"x"} done').score).toBe(1);
    expect(parseJudgeResponse('the score is 0').score).toBe(0);
  });

  it("Cohen's κ: perfect agreement = 1, hand-checked partial value, warns < 0.7", () => {
    const perfect: JudgedItem[] = Array.from({ length: 10 }, (_, i) => ({
      question: 'q', gold: 'g', answer: 'a', rationale: '', judgeScore: i % 2, humanScore: i % 2,
    }));
    const kp = cohensKappa(perfect);
    expect(kp.kappa).toBeCloseTo(1, 6);
    expect(kp.warn).toBe(false);

    // Hand-checked: n=10, both1=4, both0=3, j1h0=2, j0h1=1
    //   po=(4+3)/10=0.7; j1=(4+2)/10=0.6, h1=(4+1)/10=0.5
    //   pe=0.6*0.5 + 0.4*0.5 = 0.5 ; κ=(0.7-0.5)/(1-0.5)=0.4
    const mixed: JudgedItem[] = [
      ...mk(4, 1, 1), ...mk(3, 0, 0), ...mk(2, 1, 0), ...mk(1, 0, 1),
    ];
    const km = cohensKappa(mixed);
    expect(km.kappa).toBeCloseTo(0.4, 6);
    expect(km.warn).toBe(true); // 0.4 < 0.7
  });
});

describe('phase1: κ sample is representative (judges lexical PASSES too)', () => {
  it('runs the judge on a seeded sample of lexically-correct free-text items', async () => {
    const { scoreRow } = await import('../scorer.js');
    let calls = 0;
    const countingJudge = {
      async judge() {
        calls++;
        return { score: 1, rationale: 'mock' };
      },
    };
    const base = {
      scenarioId: 's', category: 'H1' as const, backend: 'semantic' as const, model: 'm1',
      answer: 'Helios', tokens: 0, latencyMs: 0,
    };
    // Many lexically-CORRECT H1 items (answer contains gold). With rate=1 the
    // judge must be called on EVERY one (κ sees passes, not only failures), and
    // the lexical score stays authoritative (1).
    let sampled = 0;
    for (let i = 0; i < 20; i++) {
      const row = { ...base, probeId: `H1-${i}`, paraphrase: `q${i}` };
      const r = await scoreRow(row, { type: 'exact', value: 'Helios' }, { judge: countingJudge, judgeSampleRate: 1 });
      expect(r.score).toBe(1); // lexical pass stays authoritative
      if ((r.detail as Record<string, unknown>)?.kappaSampled) sampled++;
    }
    expect(calls).toBe(20); // judge ran on ALL passes at rate=1
    expect(sampled).toBe(20);

    // With rate=0 the judge is NOT called on passes (old failure-only behaviour).
    calls = 0;
    const r0 = await scoreRow(
      { ...base, probeId: 'H1-x', paraphrase: 'qx' },
      { type: 'exact', value: 'Helios' },
      { judge: countingJudge, judgeSampleRate: 0 },
    );
    expect(r0.score).toBe(1);
    expect(calls).toBe(0);
  });

  it('a seeded ~20% rate samples a representative middle fraction of passes', async () => {
    const { scoreRow } = await import('../scorer.js');
    let calls = 0;
    const judge = { async judge() { calls++; return { score: 1, rationale: '' }; } };
    const N = 200;
    for (let i = 0; i < N; i++) {
      await scoreRow(
        { scenarioId: 's', probeId: `H0-${i}`, category: 'H0', backend: 'semantic', model: 'm1', paraphrase: `q${i}`, answer: 'yes', tokens: 0, latencyMs: 0 },
        { type: 'exact', value: 'yes' },
        { judge, judgeSampleRate: 0.2, judgeSampleSeed: 7 },
      );
    }
    // Deterministic hash-sampling should land near 20% (not 0%, not 100%).
    expect(calls).toBeGreaterThan(N * 0.1);
    expect(calls).toBeLessThan(N * 0.32);
  });
});

function mk(count: number, j: number, h: number): JudgedItem[] {
  return Array.from({ length: count }, () => ({
    question: 'q', gold: 'g', answer: 'a', rationale: '', judgeScore: j, humanScore: h,
  }));
}
