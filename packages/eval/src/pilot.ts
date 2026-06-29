import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MemoryBackend } from './types.js';
import { AnswerLlm } from './answerLlm.js';
import { FakeProvider } from './fakeProvider.js';
import { OpenRouterProvider } from '@ontofelia/providers';
import { OfflineHashingEmbedder, OpenAICompatibleEmbedder, type Embedder } from './embedder.js';
import { NoMemoryBackend } from './backends/NoMemoryBackend.js';
import { VectorRagBackend } from './backends/VectorRagBackend.js';
import { SemanticBackend } from './backends/SemanticBackend.js';
import { loadScenarioDir } from './scenarioLoader.js';
import { runSweep, type ModelSpec } from './sweep.js';
import { renderMarkdown, OfflineLexicalJudge, type Judge } from './scorer.js';
import { renderAnalysisMarkdown } from './analysis.js';
import { LlmJudge, JudgeSampler } from './llmJudge.js';
import type { ProviderAdapter } from '@ontofelia/core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build an answer-LLM provider for a given model id.
 * Offline default = FakeProvider (no network). Set EVAL_PROVIDER=openrouter
 * (with OPENROUTER_API_KEY) for a real run; EVAL_MODELS (comma-separated) sweeps
 * several models, else EVAL_MODEL is the single model.
 */
async function makeProvider(model: string): Promise<ProviderAdapter> {
  if (process.env.EVAL_PROVIDER === 'openrouter') {
    const provider = new OpenRouterProvider();
    await provider.initialize({
      name: 'openrouter',
      apiKey: process.env.OPENROUTER_API_KEY,
      baseUrl: process.env.EVAL_BASE_URL ?? 'https://openrouter.ai/api/v1',
      defaultModel: model,
      aliases: {},
    });
    return provider;
  }
  // Offline default: the deterministic fake provider (one per model id).
  return new FakeProvider();
}

function resolveModels(): string[] {
  const multi = process.env.EVAL_MODELS;
  if (multi && multi.trim()) {
    return multi
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
  }
  return [process.env.EVAL_MODEL ?? 'fake-model'];
}

function resolveEmbedder(): Embedder {
  const baseUrl = process.env.EVAL_EMBEDDINGS_URL;
  if (baseUrl) {
    return new OpenAICompatibleEmbedder({
      baseUrl,
      apiKey: process.env.EVAL_EMBEDDINGS_KEY,
      model: process.env.EVAL_EMBEDDINGS_MODEL ?? 'text-embedding-3-small',
    });
  }
  return new OfflineHashingEmbedder();
}

/**
 * The judge for free-text (H0/H1) categories.
 *  - EVAL_JUDGE=lexical (or unset offline) → deterministic OfflineLexicalJudge
 *    (network-free; does NOT feed the κ sampler).
 *  - EVAL_JUDGE=llm OR EVAL_PROVIDER=openrouter → the real {@link LlmJudge} over
 *    the configured provider; feeds the κ sampler. With EVAL_JUDGE=llm offline,
 *    the provider is the FakeProvider, so the κ-export path is exercisable with
 *    no network (the smoke for §4).
 */
async function resolveJudge(sampler: JudgeSampler): Promise<Judge> {
  const useLlm =
    process.env.EVAL_JUDGE === 'llm' ||
    (process.env.EVAL_PROVIDER === 'openrouter' && process.env.EVAL_JUDGE !== 'lexical');
  if (useLlm) {
    const model = process.env.EVAL_JUDGE_MODEL ?? process.env.EVAL_MODEL ?? resolveModels()[0];
    const provider = await makeProvider(model);
    return new LlmJudge({ provider, model, temperature: 0, sampler });
  }
  return new OfflineLexicalJudge();
}

async function main(): Promise<void> {
  const scenarioDir = path.join(__dirname, 'scenarios');
  const scenarios = loadScenarioDir(scenarioDir);
  const embedder = resolveEmbedder();
  const models = resolveModels();
  const concurrency = Number(process.env.EVAL_CONCURRENCY ?? '1');
  // The SCORER now decides which free-text items get judged (all lexical
  // failures + a seeded ≥20% sample of lexical passes), so judge–human κ is
  // measured over a representative slice of ALL free-text items, not only the
  // failure subpopulation. The sampler therefore records EVERY item the judge
  // sees (rate=1); representativeness is enforced upstream by judgeSampleRate.
  const judgeSampleRate = Number(process.env.EVAL_JUDGE_SAMPLE_RATE ?? '0.2');
  const sampler = new JudgeSampler(1);
  const judge = await resolveJudge(sampler);

  const makeBackends = (): MemoryBackend[] => [
    new SemanticBackend(),
    new VectorRagBackend({ embedder }),
    new NoMemoryBackend(),
  ];

  const modelSpecs: ModelSpec[] = await Promise.all(
    models.map(async (model) => {
      const provider = await makeProvider(model);
      return {
        model,
        makeLlm: () => new AnswerLlm({ provider, model, temperature: 0 }),
        makeBackends,
      } satisfies ModelSpec;
    }),
  );

  const sweep = await runSweep(modelSpecs, scenarios, {
    judge,
    judgeSampleRate,
    analysis: {},
    concurrency,
  });

  const outDir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  // --- markdown report: per-model tables + pooled table + pooled stats ----
  const md: string[] = [];
  md.push(`# Eval pilot report (Phase 1)`);
  md.push('');
  md.push(`Generated: ${new Date().toISOString()}`);
  md.push(`Models: ${models.join(', ')}`);
  md.push('');
  for (const model of models) {
    md.push(`---`);
    md.push(`# Model: ${model}`);
    md.push('');
    md.push(renderMarkdown(sweep.perModel[model]));
  }
  md.push(`---`);
  md.push(`# Pooled across models (model = blocking factor)`);
  md.push('');
  md.push(renderMarkdown(sweep.pooled));

  const mdText = md.join('\n');

  const jsonPath = path.join(outDir, `pilot-${ts}.json`);
  const mdPath = path.join(outDir, `pilot-${ts}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(sweep, null, 2));
  fs.writeFileSync(mdPath, mdText);

  // --- κ export: judged free-text sample with a blank human slot ----------
  // Guarantee ≥20%: if the random sampler captured nothing (tiny offline run or
  // lexical judge that does not sample), it is fine — the file is just empty and
  // the message says so. With the LlmJudge the 0.2 rate yields ≥20% on average.
  const kappaPath = path.join(outDir, `judge-sample-${ts}.jsonl`);
  fs.writeFileSync(kappaPath, sampler.toJsonl());

  console.log(mdText);
  console.log(`\nWrote:\n  ${jsonPath}\n  ${mdPath}\n  ${kappaPath} (${sampler.sample.length} judged items)`);

  // Echo verdicts to stdout for quick scanning.
  console.log('\n=== VERDICTS (pooled) ===');
  for (const v of sweep.pooled.analysis.verdicts) console.log(v.line);
  void renderAnalysisMarkdown; // (exported for reuse/tests)
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
