import type {
  Scenario,
  MemoryBackend,
  ScoredRow,
  GoldSpec,
  PilotReport,
  ProbeTurn,
} from './types.js';
import { AnswerLlm } from './answerLlm.js';
import { runScenario, type RunnerOptions } from './runner.js';
import { scoreRow, aggregate, type ScorerOptions } from './scorer.js';
import { analyze, type AnalysisResult, type AnalysisOptions } from './analysis.js';

/** Build a probeId → gold lookup for a scenario. */
function goldMap(scenario: Scenario): Map<string, GoldSpec> {
  const m = new Map<string, GoldSpec>();
  for (const t of scenario.turns) {
    if (t.kind === 'probe') m.set((t as ProbeTurn).id, (t as ProbeTurn).gold);
  }
  return m;
}

export interface HarnessOptions extends RunnerOptions, ScorerOptions {
  /** Statistical-analysis options (Phase 1). */
  analysis?: AnalysisOptions;
}

/** A pilot report extended with the Phase-1 statistical analysis. */
export interface AnalyzedReport extends PilotReport {
  analysis: AnalysisResult;
}

/**
 * Run A/B/C over all scenarios, score, aggregate into a {@link PilotReport}, and
 * attach the Phase-1 statistical {@link AnalysisResult}. The same
 * {@link AnswerLlm} (provider + model) is held fixed across backends (fairness
 * rule). This is the reusable base for #979 / #977.
 */
export async function runPilot(
  backends: MemoryBackend[],
  scenarios: Scenario[],
  llm: AnswerLlm,
  opts: HarnessOptions = {},
): Promise<AnalyzedReport> {
  const allScored = await scoreAll(backends, scenarios, llm, opts);
  const report = aggregate(allScored, backends.map((b) => b.name));
  const analysis = analyze(allScored, opts.analysis);
  return { ...report, analysis };
}

/** Run + score every (backend × scenario × probe × paraphrase) row. */
export async function scoreAll(
  backends: MemoryBackend[],
  scenarios: Scenario[],
  llm: AnswerLlm,
  opts: HarnessOptions = {},
): Promise<ScoredRow[]> {
  const allScored: ScoredRow[] = [];
  for (const backend of backends) {
    for (const scenario of scenarios) {
      const golds = goldMap(scenario);
      const rows = await runScenario(backend, scenario, llm, opts);
      for (const row of rows) {
        const gold = golds.get(row.probeId);
        if (!gold) continue;
        allScored.push(await scoreRow(row, gold, opts));
      }
    }
  }
  return allScored;
}
