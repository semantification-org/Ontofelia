/**
 * Environment resolution + validation for the behavior pilot.
 *
 * Guards against self-judging and misconfigured paid runs BEFORE any paid
 * call is made:
 *  - Real mode (EVAL_PROVIDER=openrouter) with judge mode `llm` requires
 *    EVAL_JUDGE_MODEL to be explicitly set AND distinct from every swept
 *    model (a model must not judge its own text split).
 *  - Judge mode `llm` without a real provider is a hard error: an offline
 *    scripted provider cannot meaningfully judge.
 */

export interface BehaviorEnv {
  EVAL_PROVIDER?: string;
  EVAL_MODEL?: string;
  EVAL_MODELS?: string;
  EVAL_JUDGE_MODEL?: string;
  EVAL_BEHAVIOR_JUDGE?: string;
}

export interface ResolvedJudgeSettings {
  judgeMode: 'llm' | 'heuristic';
  /** Set only in judge mode `llm`. */
  judgeModel?: string;
}

/** Models under test: EVAL_MODELS (comma-separated) or single EVAL_MODEL. */
export function resolveModels(env: BehaviorEnv): string[] {
  const multi = env.EVAL_MODELS;
  if (multi && multi.trim()) {
    return multi
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean);
  }
  return [env.EVAL_MODEL ?? 'scripted-model'];
}

/**
 * Resolve and validate the judge configuration. Throws (with an actionable
 * message) before any paid call when the configuration is unsafe.
 */
export function resolveJudgeSettings(env: BehaviorEnv): ResolvedJudgeSettings {
  const realProvider = env.EVAL_PROVIDER === 'openrouter';
  const requested = env.EVAL_BEHAVIOR_JUDGE?.trim();
  if (requested && requested !== 'llm' && requested !== 'heuristic') {
    throw new Error(
      `EVAL_BEHAVIOR_JUDGE must be "llm" or "heuristic", got "${requested}".`,
    );
  }
  const judgeMode: 'llm' | 'heuristic' =
    (requested as 'llm' | 'heuristic' | undefined) ?? (realProvider ? 'llm' : 'heuristic');

  if (judgeMode === 'llm' && !realProvider) {
    throw new Error(
      'EVAL_BEHAVIOR_JUDGE=llm requires a real provider (EVAL_PROVIDER=openrouter): ' +
        'an offline scripted judge makes no sense. Use EVAL_BEHAVIOR_JUDGE=heuristic offline.',
    );
  }

  if (judgeMode === 'llm') {
    const judgeModel = env.EVAL_JUDGE_MODEL?.trim();
    if (!judgeModel) {
      throw new Error(
        'Judge mode "llm" with EVAL_PROVIDER=openrouter requires EVAL_JUDGE_MODEL to be ' +
          'set explicitly (no implicit fallback to a swept model — that would be self-judging).',
      );
    }
    const models = resolveModels(env);
    if (models.includes(judgeModel)) {
      throw new Error(
        `EVAL_JUDGE_MODEL "${judgeModel}" is also in the swept model list (${models.join(', ')}): ` +
          'a model must not judge itself. Pick a judge model outside EVAL_MODELS.',
      );
    }
    return { judgeMode, judgeModel };
  }

  return { judgeMode };
}
