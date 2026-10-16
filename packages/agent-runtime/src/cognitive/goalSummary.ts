/**
 * Pure, grounded per-goal summary shared by the `/goals` command and the
 * `list_goals` tool, so the two can never disagree. Everything is derived from
 * the goal's stored fields — no LLM involved.
 */
import { compareIsoDesc } from '@ontofelia/core';
import type { GoalSummary } from '@ontofelia/tools';
import type { Goal } from './GoalStack.js';

export type { GoalSummary };

/** A goal is open while it is neither resolved nor abandoned. */
export function isOpenGoal(g: Pick<Goal, 'status'>): boolean {
  return g.status !== 'resolved' && g.status !== 'abandoned';
}

const STATUS_RANK: Record<Goal['status'], number> = {
  active: 0,
  proposed: 1,
  blocked: 2,
  resolved: 3,
  abandoned: 4,
};

/** Display order: active, proposed, blocked, then closed; priority desc, newest first. */
export function orderGoals<T extends Pick<Goal, 'status' | 'priority' | 'createdAt'>>(goals: readonly T[]): T[] {
  return [...goals].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      b.priority - a.priority ||
      compareIsoDesc(a.createdAt, b.createdAt),
  );
}

/** Split a free-form plan ("a → b → c", or one step per line) into steps. */
export function parsePlannedSteps(planned: string | undefined): string[] {
  if (!planned) return [];
  return planned
    .split(/\s*(?:→|->|\r?\n)\s*/)
    .map((s) => s.replace(/^\s*(?:\d+[.)]|[-*•])\s+/, '').trim())
    .filter((s) => s.length > 0);
}

/**
 * Number of planned steps already done, from `stepProgress` ("3/8", "3 of 8",
 * or a bare "3"); undefined when the marker is absent or not understood.
 */
export function stepsDone(progress: string | undefined): number | undefined {
  if (!progress) return undefined;
  const m = /^\s*(\d+)\s*(?:\/|of\b|$)/i.exec(progress);
  return m ? Number(m[1]) : undefined;
}

/**
 * The next action: the first planned step not yet done (from `plannedSteps` +
 * `stepProgress`), else the current step, else the first planned step. Null when
 * the plan is exhausted and there is no current step.
 */
export function nextAction(g: Pick<Goal, 'plannedSteps' | 'stepProgress' | 'currentStep'>): string | null {
  const steps = parsePlannedSteps(g.plannedSteps);
  const done = stepsDone(g.stepProgress);
  if (steps.length > 0 && done !== undefined && done < steps.length) return steps[done];
  if (g.currentStep) return g.currentStep;
  if (steps.length > 0 && done === undefined) return steps[0];
  return null;
}

/** The single per-goal summary used by `/goals` and `list_goals`. */
export function summarizeGoal(g: Goal, now: Date): GoalSummary {
  const wakeMs = g.wakeAt ? Date.parse(g.wakeAt) : NaN;
  const waiting = g.status === 'active' && !Number.isNaN(wakeMs) && wakeMs > now.getTime();
  return {
    label: g.goalLabel,
    status: g.status,
    priority: g.priority,
    nextAction: nextAction(g),
    nextWake: g.wakeAt ?? null,
    waitingUntil: waiting ? g.wakeAt! : null,
    blockedReason: g.status === 'blocked' && g.blockedReason ? g.blockedReason : null,
    deadline: g.deadline ?? null,
  };
}
