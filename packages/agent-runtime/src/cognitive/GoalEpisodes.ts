/**
 * Goal transition episodes (docs/cognitive-architecture/05 §3, 07 §3): every
 * goal pushed, resolved, abandoned or blocked is an episode, so the history is
 * queryable. Each carries `partOfGoal` and `forUser` (the goal's owner key).
 *
 * The cycle collects the transitions of its turn and writes them from its
 * queued persist; tool-driven transitions (update_goal_step, arm_goal, an
 * initiative failure) go through {@link directGoalEpisodeSink}, which writes
 * straight away because they already write the goal.
 */

import { EpisodicMemory, type EpisodeInput } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter } from '@ontofelia/core';
import type { GoalTransition, GoalTransitionKind, GoalTransitionSink } from './GoalStack.js';
import { looksLikeSecret } from './privacyClass.js';

export const GOAL_EPISODE_TYPE: Readonly<Record<GoalTransitionKind, string>> = {
  pushed: 'goal-pushed',
  resolved: 'goal-resolved',
  abandoned: 'goal-abandoned',
  blocked: 'goal-blocked',
};

/** The episode of one transition, ready to append. */
export function goalEpisodeInput(
  t: GoalTransition,
  where: { sessionId?: string; cycleId?: string } = {},
): EpisodeInput {
  const payload = t.reason ? `${t.goalLabel} (${t.reason})` : t.goalLabel;
  return {
    episodeType: GOAL_EPISODE_TYPE[t.kind],
    occurredAt: t.at,
    ...(where.sessionId ? { sessionId: where.sessionId } : {}),
    ...(where.cycleId ? { cycleId: where.cycleId } : {}),
    forUser: t.forUser,
    partOfGoal: t.goalUri,
    payload,
    ...(looksLikeSecret(payload) ? { privacyClass: 'secret' as const } : {}),
    tags: [t.goalType.split('/').pop() ?? t.goalType],
  };
}

/** Append the episode of one transition. Returns its IRI. */
export async function writeGoalEpisode(
  episodes: EpisodicMemory,
  t: GoalTransition,
  where: { sessionId?: string; cycleId?: string } = {},
): Promise<string> {
  return episodes.append(goalEpisodeInput(t, where));
}

/**
 * A sink that writes each transition at once, for transitions outside a cycle.
 * `enabled` is read for every transition (the goal stack and episodic memory
 * flags); a failure goes to `onError` and never reaches the caller.
 */
export function directGoalEpisodeSink(deps: {
  triplestore: TriplestoreAdapter;
  agentId: string;
  sessionId?: string;
  enabled: () => Promise<boolean>;
  onError?: (e: unknown) => void;
}): GoalTransitionSink {
  const episodes = new EpisodicMemory(deps.triplestore, deps.agentId);
  return async (t) => {
    try {
      if (!(await deps.enabled())) return;
      await writeGoalEpisode(episodes, t, { sessionId: deps.sessionId });
    } catch (e) {
      deps.onError?.(e);
    }
  };
}
