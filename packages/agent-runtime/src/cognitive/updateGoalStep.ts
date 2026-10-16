/**
 * Update a goal's step, progress, plan or status (docs/initiative-architecture.md
 * §9). The `update_goal_step` tool calls this through a port. It is deliberately
 * narrow: it cannot touch a goal's mandate, wake or priority, cannot close a
 * goal as abandoned, cannot reopen a closed goal, and in an unattended
 * initiative cycle it is confined to the goal that cycle was woken for.
 */

import { GoalStack } from './GoalStack.js';
import { isOpenGoal } from './goalSummary.js';

const RESPOND_TO_USER = 'urn:shared:ontology#cog/RespondToUser';

/** Statuses the tool may set. `abandoned` and `proposed` are not among them. */
export const SETTABLE_STATUSES = ['active', 'blocked', 'resolved'] as const;
export type SettableStatus = (typeof SETTABLE_STATUSES)[number];

export interface UpdateGoalStepRequest {
  agentId?: string;
  /** Session whose goal list the caller sees (session graph + long-term graph). */
  sessionId: string;
  /** Existing open goal: its label or IRI. */
  goal: string;
  /**
   * Set for an unattended initiative cycle: the only goal it may change. Absent
   * means an owner conversation, where any open goal may be updated.
   */
  onlyGoalUri?: string;
  currentStep?: string;
  /** Progress marker such as "3/8". */
  stepProgress?: string;
  plannedSteps?: string;
  status?: string;
  blockedReason?: string;
}

export type UpdateGoalStepResult =
  | { ok: true; goalUri: string; label: string; changed: string[] }
  | { ok: false; message: string };

export interface UpdateGoalStepDeps {
  goalStack: GoalStack;
  now?: Date;
}

const refuse = (message: string): UpdateGoalStepResult => ({ ok: false, message });

const MAX_TEXT = 2000;

export async function updateGoalStep(
  deps: UpdateGoalStepDeps,
  req: UpdateGoalStepRequest,
): Promise<UpdateGoalStepResult> {
  const gs = deps.goalStack;
  const now = deps.now ?? new Date();

  const text = (v: string | undefined) => (v === undefined ? undefined : v.trim());
  const currentStep = text(req.currentStep);
  const stepProgress = text(req.stepProgress);
  const plannedSteps = text(req.plannedSteps);
  const status = text(req.status);
  const blockedReason = text(req.blockedReason);

  if (
    currentStep === undefined &&
    stepProgress === undefined &&
    plannedSteps === undefined &&
    status === undefined
  ) {
    return refuse('Give at least one of currentStep, stepProgress, plannedSteps or status. Nothing was changed.');
  }
  for (const [name, v] of [
    ['currentStep', currentStep],
    ['stepProgress', stepProgress],
    ['plannedSteps', plannedSteps],
    ['blockedReason', blockedReason],
  ] as const) {
    if (v !== undefined && v.length > MAX_TEXT) return refuse(`${name} is longer than ${MAX_TEXT} characters.`);
  }
  if (status !== undefined) {
    if (!(SETTABLE_STATUSES as readonly string[]).includes(status)) {
      return refuse(
        `status "${status}" is not allowed; use active, blocked (with blockedReason) or resolved. ` +
          'A goal can only be abandoned by the owner.',
      );
    }
    if (status === 'blocked' && !blockedReason) {
      return refuse('status "blocked" needs a blockedReason. Nothing was changed.');
    }
  }
  if (blockedReason !== undefined && status !== 'blocked') {
    return refuse('blockedReason is only used together with status "blocked".');
  }
  if (currentStep === '' || plannedSteps === '') {
    return refuse('currentStep and plannedSteps must not be empty.');
  }

  // Resolve the goal against the same list the owner sees (`/goals`, `list_goals`).
  const ref = req.goal.trim();
  const all = await gs.list();
  const byUri = all.filter((g) => g.uri === ref);
  const matches = byUri.length > 0 ? byUri : all.filter((g) => g.goalLabel.trim().toLowerCase() === ref.toLowerCase());
  if (matches.length === 0) return refuse(`No goal matches "${ref}". Use list_goals to see the open goals.`);
  const openMatches = matches.filter(isOpenGoal);
  if (openMatches.length === 0) {
    return refuse(`Goal "${matches[0].goalLabel}" is already ${matches[0].status}; a closed goal is not reopened.`);
  }
  if (openMatches.length > 1) {
    return refuse(
      `"${ref}" matches ${openMatches.length} open goals; give the goal's IRI: ` +
        openMatches.map((g) => `${g.goalLabel} (${g.uri})`).join('; '),
    );
  }
  const goal = openMatches[0];

  if (req.onlyGoalUri !== undefined && goal.uri !== req.onlyGoalUri) {
    return refuse(
      'In an unattended initiative cycle you may only update the goal this cycle was woken for. Nothing was changed.',
    );
  }
  if (goal.goalType === RESPOND_TO_USER) {
    return refuse('The implicit "Respond to the user" goal has no steps to update.');
  }

  const changed: string[] = [];
  if (currentStep !== undefined || stepProgress !== undefined) {
    if (currentStep !== undefined) {
      await gs.setStep(goal.uri, currentStep, stepProgress, now);
      changed.push('currentStep');
      if (stepProgress !== undefined) changed.push('stepProgress');
    } else {
      // Progress alone keeps the current step text.
      await gs.setStep(goal.uri, goal.currentStep ?? '', stepProgress, now);
      changed.push('stepProgress');
    }
  }
  if (plannedSteps !== undefined) {
    await gs.setPlannedSteps(goal.uri, plannedSteps, now);
    changed.push('plannedSteps');
  }
  if (status !== undefined) {
    await gs.setStatus(goal.uri, status as SettableStatus, blockedReason, now);
    changed.push('status');
  }
  return { ok: true, goalUri: goal.uri, label: goal.goalLabel, changed };
}
