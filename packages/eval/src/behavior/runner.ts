/**
 * Behavior conformance runner.
 *
 * License scenarios are SINGLE-TURN: assemble the (variant-selected) system
 * prompt, present the fake tool set via the provider's native tool-calling
 * API, send the scenario user message, classify the FIRST assistant turn.
 * Any first-turn tool call is `acted`.
 *
 * Control scenarios are MULTI-TURN: the prompt under test mandates read-only
 * investigation, so a turn containing ONLY read-only tool calls (fs_list,
 * exec df/ls/git status, …) is answered with the scenario's canned tool
 * results and the conversation continues (cap: 3 assistant turns). The
 * classification is the first turn that is NOT pure read-only investigation:
 * destructive tool call → `acted`, user-directed question → `asked`, still
 * investigating at the cap or anything else → `other`.
 *
 * Tools are never executed — tool calls are recorded, and read-only ones are
 * answered from the scenario's canned results.
 */

import type { ChatMessage, ProviderAdapter } from '@ontofelia/core';
import type {
  BehaviorScenario,
  BehaviorRow,
  BehaviorReport,
  BehaviorModelSummary,
  BehaviorRunConfig,
  FirstTurnLabel,
  LabelSource,
} from './types.js';
import { BEHAVIOR_TOOLS } from './tools.js';
import { resolvePromptVariant, type PromptParams } from './promptFixture.js';
import { classifyTextDetailed, scoreLabel } from './classifier.js';
import { classifyToolCall } from './destructiveness.js';
import type { BehaviorTextJudge } from './behaviorJudge.js';

/** Maximum assistant turns for a control scenario (investigation cap). */
export const MAX_CONTROL_TURNS = 3;

export interface BehaviorRunnerOptions {
  /** System-prompt variant name (first-class A/B parameter). Default "current". */
  promptVariant?: string;
  /** Optional LLM-judge refinement of the text-only split. */
  judge?: BehaviorTextJudge;
  /** Extra prompt parameters (provider/agent id/cwd shown in the fixture). */
  promptParams?: Omit<PromptParams, 'model'>;
  temperature?: number;
  maxTokens?: number;
  /** Per-row retry policy for transient provider errors (default 2 retries). */
  retries?: number;
  /** Base delay in ms for exponential backoff between retries (default 500). */
  retryBaseDelayMs?: number;
  /** Run metadata recorded into the report (judge mode/model, provider). */
  runConfig?: Pick<BehaviorRunConfig, 'provider' | 'judgeMode' | 'judgeModel'>;
}

/** A model under test: id + the provider it is reachable through. */
export interface BehaviorModelSpec {
  model: string;
  provider: ProviderAdapter;
}

const DEFAULT_TEMPERATURE = 0;
const DEFAULT_MAX_TOKENS = 512;

/** Run ONE scenario against ONE model and classify the decisive turn. */
export async function runBehaviorScenario(
  spec: BehaviorModelSpec,
  scenario: BehaviorScenario,
  opts: BehaviorRunnerOptions = {},
): Promise<BehaviorRow> {
  const variant = resolvePromptVariant(opts.promptVariant);
  const systemPrompt = variant.build({ ...opts.promptParams, model: spec.model });

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: scenario.userMessage },
  ];
  const maxTurns = scenario.class === 'control' ? MAX_CONTROL_TURNS : 1;

  const allToolCalls: Array<{ name: string; arguments: string }> = [];
  const unclassifiedCommands: string[] = [];
  let investigationRounds = 0;
  let totalTokens = 0;
  let latencyMs = 0;

  let label: FirstTurnLabel = 'other';
  let source: LabelSource = 'structural';
  let responseText = '';
  let undirectedQuestion = false;
  let finishReason: BehaviorRow['finishReason'];
  let truncated = false;
  let judgeRationale: string | undefined;

  for (let turn = 1; turn <= maxTurns; turn++) {
    const start = Date.now();
    const res = await spec.provider.chat({
      model: spec.model,
      messages,
      tools: BEHAVIOR_TOOLS,
      temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
      maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    });
    latencyMs += Date.now() - start;
    totalTokens += res.usage?.totalTokens ?? 0;
    finishReason = res.finishReason;
    responseText = res.content ?? '';
    const calls = res.toolCalls ?? [];
    for (const tc of calls) allToolCalls.push({ name: tc.name, arguments: tc.arguments });

    // M4: a truncated turn is not classifiable — flag and exclude the row.
    if (res.finishReason === 'length') {
      truncated = true;
      label = 'other';
      source = 'structural';
      break;
    }

    if (calls.length > 0) {
      const classifications = calls.map((tc) => classifyToolCall(tc.name, tc.arguments));
      for (const c of classifications) {
        if (c.unclassifiedCommand !== undefined) unclassifiedCommands.push(c.unclassifiedCommand);
      }
      const pureReadOnly = classifications.every((c) => c.kind === 'read-only');
      if (scenario.class === 'control' && pureReadOnly) {
        investigationRounds++;
        if (turn === maxTurns) {
          // Still investigating at the cap → `other` (never rewarded).
          label = 'other';
          source = 'structural';
          break;
        }
        // Feed canned results back and continue the conversation.
        messages.push({ role: 'assistant', content: responseText, toolCalls: calls });
        for (const tc of calls) {
          messages.push({
            role: 'tool',
            content: scenario.cannedToolResults?.[tc.name] ?? '(no output)',
            toolCallId: tc.id,
            name: tc.name,
          });
        }
        continue;
      }
      // License: ANY tool call. Control: a destructive tool call.
      label = 'acted';
      source = 'structural';
      break;
    }

    // Text-only turn: heuristic split, optionally refined by the LLM judge.
    const detailed = classifyTextDetailed(responseText);
    label = detailed.label;
    source = 'heuristic';
    undirectedQuestion = detailed.undirectedQuestion;
    // Judge refinement applies to every text-only decisive turn; in
    // particular a label resting solely on a bare undirected "?" is always
    // refined when a judge is configured. The structural `acted` decision is
    // never delegated to an LLM.
    if (opts.judge) {
      const verdict = await opts.judge.classify({
        userMessage: scenario.userMessage,
        assistantText: responseText,
      });
      if (verdict.label !== null) {
        label = verdict.label;
        source = 'judge';
        judgeRationale = verdict.rationale;
      }
    }
    break;
  }

  return {
    scenarioId: scenario.id,
    scenarioClass: scenario.class,
    language: scenario.language,
    model: spec.model,
    promptVariant: variant.name,
    label,
    labelSource: source,
    toolCalls: allToolCalls,
    responseText,
    score: truncated ? 0 : scoreLabel(scenario.class, label),
    tokens: totalTokens,
    latencyMs,
    investigationRounds,
    ...(unclassifiedCommands.length > 0 ? { unclassifiedCommands } : {}),
    finishReason,
    ...(truncated ? { truncated: true } : {}),
    ...(undirectedQuestion ? { undirectedQuestion: true } : {}),
    judgeRationale,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run one scenario with retries (M5): up to `retries` retries with
 * exponential backoff for transient errors; on final failure return an
 * error row (excluded from rates) instead of aborting the sweep.
 */
async function runScenarioWithRetry(
  spec: BehaviorModelSpec,
  scenario: BehaviorScenario,
  opts: BehaviorRunnerOptions,
): Promise<BehaviorRow> {
  const retries = opts.retries ?? 2;
  const baseDelay = opts.retryBaseDelayMs ?? 500;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(baseDelay * 2 ** (attempt - 1));
    try {
      return await runBehaviorScenario(spec, scenario, opts);
    } catch (err) {
      lastError = err;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  return {
    scenarioId: scenario.id,
    scenarioClass: scenario.class,
    language: scenario.language,
    model: spec.model,
    promptVariant: resolvePromptVariant(opts.promptVariant).name,
    label: 'other',
    labelSource: 'structural',
    toolCalls: [],
    responseText: '',
    score: 0,
    tokens: 0,
    latencyMs: 0,
    error: message,
  };
}

/** Run all scenarios for every model (serial per model, models in order). */
export async function runBehaviorSet(
  specs: BehaviorModelSpec[],
  scenarios: BehaviorScenario[],
  opts: BehaviorRunnerOptions = {},
): Promise<BehaviorReport> {
  if (specs.length === 0) throw new Error('runBehaviorSet: no models specified');
  const rows: BehaviorRow[] = [];
  for (const spec of specs) {
    for (const scenario of scenarios) {
      rows.push(await runScenarioWithRetry(spec, scenario, opts));
    }
  }
  const variant = resolvePromptVariant(opts.promptVariant).name;
  const runConfig: BehaviorRunConfig = {
    provider: opts.runConfig?.provider ?? 'scripted',
    models: specs.map((s) => s.model),
    judgeMode: opts.runConfig?.judgeMode ?? (opts.judge ? 'llm' : 'heuristic'),
    judgeModel: opts.runConfig?.judgeModel,
    temperature: opts.temperature ?? DEFAULT_TEMPERATURE,
    maxTokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    promptVariant: variant,
    scenarioCounts: {
      license: scenarios.filter((s) => s.class === 'license').length,
      control: scenarios.filter((s) => s.class === 'control').length,
    },
  };
  return {
    generatedAt: new Date().toISOString(),
    models: specs.map((s) => s.model),
    promptVariants: [...new Set(rows.map((r) => r.promptVariant))],
    runConfig,
    summaries: summarizeBehavior(rows),
    rows,
  };
}

/** A row is excluded from rate computation when truncated or errored. */
export function isExcludedRow(row: BehaviorRow): boolean {
  return Boolean(row.truncated || row.error);
}

/** Aggregate rows into per-(model × prompt variant) summaries. */
export function summarizeBehavior(rows: BehaviorRow[]): BehaviorModelSummary[] {
  const groups = new Map<string, { model: string; promptVariant: string }>();
  for (const r of rows) {
    groups.set(JSON.stringify([r.model, r.promptVariant]), {
      model: r.model,
      promptVariant: r.promptVariant,
    });
  }
  return [...groups.values()].map(({ model, promptVariant }) => {
    const subset = rows.filter((r) => r.model === model && r.promptVariant === promptVariant);
    const included = subset.filter((r) => !isExcludedRow(r));
    const license = included.filter((r) => r.scenarioClass === 'license');
    const control = included.filter((r) => r.scenarioClass === 'control');
    const actRate = rate(license, (r) => r.label === 'acted');
    const askRate = rate(control, (r) => r.label === 'asked');
    const labelCounts: Record<FirstTurnLabel, number> = {
      acted: 0,
      asked: 0,
      announced: 0,
      'claimed-acted': 0,
      other: 0,
    };
    for (const r of included) labelCounts[r.label]++;
    return {
      model,
      promptVariant,
      nLicense: license.length,
      nControl: control.length,
      nTruncated: subset.filter((r) => r.truncated).length,
      nErrors: subset.filter((r) => r.error).length,
      actRate,
      askRate,
      // M6: never a 0-padded mean — null when either class is empty.
      conformance: actRate !== null && askRate !== null ? (actRate + askRate) / 2 : null,
      labelCounts,
      totalTokens: subset.reduce((s, r) => s + r.tokens, 0),
      meanLatencyMs: subset.length
        ? subset.reduce((s, r) => s + r.latencyMs, 0) / subset.length
        : 0,
    };
  });
}

function rate(rows: BehaviorRow[], pred: (r: BehaviorRow) => boolean): number | null {
  return rows.length ? rows.filter(pred).length / rows.length : null;
}
