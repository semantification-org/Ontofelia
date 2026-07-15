import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderAdapter } from '@ontofelia/core';
import { OpenRouterProvider } from '@ontofelia/providers';
import { loadBehaviorScenarioDir } from './behavior/scenarioLoader.js';
import { runBehaviorSet, type BehaviorModelSpec } from './behavior/runner.js';
import { renderBehaviorMarkdown } from './behavior/report.js';
import { ScriptedToolProvider, wellBehavedResponder } from './behavior/scriptedProvider.js';
import { LlmBehaviorJudge, type BehaviorTextJudge } from './behavior/behaviorJudge.js';
import { resolveModels, resolveJudgeSettings } from './behavior/runConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Behavior conformance pilot — "act vs ask" (CLI entry, mirrors pilot.ts).
 *
 * Offline default = ScriptedToolProvider with a well-behaved test double (no
 * network; exercises the full pipeline including multi-turn control
 * scenarios). Set EVAL_PROVIDER=openrouter (with OPENROUTER_API_KEY) for a
 * real run; EVAL_MODELS (comma-separated) sweeps several models, else
 * EVAL_MODEL is the single model.
 * EVAL_PROMPT_VARIANT selects the system-prompt variant (default "current").
 * EVAL_BEHAVIOR_JUDGE=llm|heuristic controls the text-split refinement
 * (default: llm when EVAL_PROVIDER=openrouter, heuristic otherwise). Judge
 * mode llm requires EVAL_JUDGE_MODEL, set to a model OUTSIDE the swept list
 * (no self-judging) — validated BEFORE any paid call.
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
  // Offline default: deterministic scripted provider (no network).
  return new ScriptedToolProvider(wellBehavedResponder());
}

async function main(): Promise<void> {
  const scenarioDir = path.join(__dirname, 'behavior', 'scenarios');
  const scenarios = loadBehaviorScenarioDir(scenarioDir);
  const models = resolveModels(process.env);
  const promptVariant = process.env.EVAL_PROMPT_VARIANT ?? 'current';
  const providerName = process.env.EVAL_PROVIDER === 'openrouter' ? 'openrouter' : 'scripted';

  // Validate judge configuration BEFORE any provider call (H3/L1 guards).
  const judgeSettings = resolveJudgeSettings(process.env);
  let judge: BehaviorTextJudge | undefined;
  if (judgeSettings.judgeMode === 'llm' && judgeSettings.judgeModel) {
    const judgeProvider = await makeProvider(judgeSettings.judgeModel);
    judge = new LlmBehaviorJudge({
      provider: judgeProvider,
      model: judgeSettings.judgeModel,
      temperature: 0,
    });
  }

  const specs: BehaviorModelSpec[] = await Promise.all(
    models.map(async (model) => ({ model, provider: await makeProvider(model) })),
  );

  const report = await runBehaviorSet(specs, scenarios, {
    promptVariant,
    judge,
    promptParams: { providerName },
    runConfig: {
      provider: providerName,
      judgeMode: judge ? 'llm' : 'heuristic',
      judgeModel: judgeSettings.judgeModel,
    },
  });

  const outDir = path.join(__dirname, '..', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const mdText = renderBehaviorMarkdown(report);

  const jsonPath = path.join(outDir, `behavior-${ts}.json`);
  const mdPath = path.join(outDir, `behavior-${ts}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(mdPath, mdText);

  console.log(mdText);

  // Console warnings for exclusions and undefined rates (M4/M5/M6).
  const truncated = report.rows.filter((r) => r.truncated).length;
  const errored = report.rows.filter((r) => r.error).length;
  if (truncated > 0) {
    console.warn(`WARNING: ${truncated} row(s) truncated (finishReason=length) — excluded from rates.`);
  }
  if (errored > 0) {
    console.warn(`WARNING: ${errored} row(s) failed after retries — excluded from rates.`);
  }
  for (const s of report.summaries) {
    if (s.conformance === null) {
      console.warn(
        `WARNING: ${s.model} (${s.promptVariant}) has an empty scenario class after exclusions ` +
          `(license n=${s.nLicense}, control n=${s.nControl}) — conformance undefined, not 0.`,
      );
    }
  }

  console.log(`\nWrote:\n  ${jsonPath}\n  ${mdPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
