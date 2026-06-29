/**
 * Phase 1 multi-model sweep (spec §3).
 *
 * Runs the full A/B/C benchmark once per model (model as a blocking factor),
 * producing a per-model {@link AnalyzedReport} AND a pooled report+analysis
 * across models. Pairing in the pooled analysis stays WITHIN each model (the
 * analysis item key includes the model), so model differences are never
 * silently averaged away — we report per-model AND aggregate.
 *
 * Network calls can be concurrency-limited via {@link SweepOptions.concurrency}
 * (a small pool over the models). Offline, the fake provider is used as one
 * "model" for the smoke test. Determinism: temperature 0 + seeded bootstrap.
 */

import type { MemoryBackend, Scenario, ScoredRow } from './types.js';
import { AnswerLlm } from './answerLlm.js';
import { aggregate } from './scorer.js';
import { analyze } from './analysis.js';
import { scoreAll, type HarnessOptions, type AnalyzedReport } from './harness.js';

export interface ModelSpec {
  /** Model id (becomes the blocking-factor label on every row). */
  model: string;
  /** Build the answer LLM for this model. Allows a different provider per model. */
  makeLlm: () => AnswerLlm;
  /** Build the backends for this model (fresh per model — stores must be isolated). */
  makeBackends: () => MemoryBackend[];
}

export interface SweepOptions extends HarnessOptions {
  /** Max number of models run concurrently (network pool). Default 1 (serial). */
  concurrency?: number;
}

export interface SweepResult {
  models: string[];
  /** Per-model report+analysis, keyed by model id. */
  perModel: Record<string, AnalyzedReport>;
  /** Pooled report+analysis across all models (model kept as blocking factor). */
  pooled: AnalyzedReport;
}

/** Run the full benchmark for one model and return its scored rows. */
async function runOneModel(spec: ModelSpec, scenarios: Scenario[], opts: HarnessOptions): Promise<ScoredRow[]> {
  const llm = spec.makeLlm();
  const backends = spec.makeBackends();
  return scoreAll(backends, scenarios, llm, opts);
}

/** Simple bounded concurrency map preserving input order in the result. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lim = Math.max(1, limit);
  const workers = new Array(Math.min(lim, items.length)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Run the A/B/C benchmark once per model. Returns per-model reports and a pooled
 * report whose statistical analysis blocks on model (pairs stay within a model).
 */
export async function runSweep(
  models: ModelSpec[],
  scenarios: Scenario[],
  opts: SweepOptions = {},
): Promise<SweepResult> {
  if (models.length === 0) throw new Error('runSweep: no models specified');
  const concurrency = opts.concurrency ?? 1;

  const perModelRows = await mapLimit(models, concurrency, (m) => runOneModel(m, scenarios, opts));

  const perModel: Record<string, AnalyzedReport> = {};
  const pooledRows: ScoredRow[] = [];
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const rows = perModelRows[i];
    pooledRows.push(...rows);
    const backendNames = m.makeBackends().map((b) => b.name);
    const report = aggregate(rows, backendNames);
    perModel[m.model] = { ...report, analysis: analyze(rows, opts.analysis) };
  }

  const allBackends = [...new Set(pooledRows.map((r) => r.backend))];
  const pooledReport = aggregate(pooledRows, allBackends);
  const pooled: AnalyzedReport = {
    ...pooledReport,
    analysis: analyze(pooledRows, opts.analysis),
  };

  return { models: models.map((m) => m.model), perModel, pooled };
}
