/**
 * Arm a goal for initiative (docs/initiative-architecture.md §5.1, §9): give it
 * the owner's mandate and a wake, put it in the long-term goal graph where the
 * wake path looks, and schedule the wake. The `arm_goal` tool calls this through
 * a port; every write goes through the existing GoalStack API.
 */

import { OWNER_USER_KEY } from '@ontofelia/core';
import { GoalStack, MAX_WAKE_INTERVAL_MS, addIso8601Duration, type Goal } from './GoalStack.js';
import { isOpenGoal } from './goalSummary.js';

const COGT = 'urn:shared:ontology#cog/';

/** Goal type given to a goal the owner asks for in a conversation. */
export const OWNER_REQUESTED_WORK = `${COGT}OwnerRequestedWork`;
const RESPOND_TO_USER = `${COGT}RespondToUser`;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

export interface ArmGoalRequest {
  /** Session whose goal list the owner sees (session graph + long-term graph). */
  sessionId: string;
  /** The `message-received` episode of the current inbound owner message. */
  mandateEpisodeUri: string;
  /** Existing open goal: its label or IRI. Exclusive with `newGoal`. */
  goal?: string;
  /** Label of a new goal. Exclusive with `goal`. */
  newGoal?: string;
  /** Priority in [0,1] for a new goal (default 0.6). */
  priority?: number;
  /** Absolute wake, ISO-8601 with a time zone. Exclusive with `wakeIn`. */
  wakeAt?: string;
  /** Wake after this ISO-8601 duration (for example PT2H). Exclusive with `wakeAt`. */
  wakeIn?: string;
  /** Recurring interval, ISO-8601 duration. An existing goal keeps its own interval when omitted. */
  every?: string;
}

export type ArmGoalResult =
  | {
      ok: true;
      created: boolean;
      label: string;
      goalUri: string;
      /** Next wake, ISO-8601. */
      wakeAt: string;
      every?: string;
      /** Whether the wake job was scheduled (false: it is picked up at the next gateway start). */
      scheduled: boolean;
      scheduleError?: string;
      /** A proposed goal was activated so that it can wake. */
      activated: boolean;
      initiativeEnabled: boolean;
    }
  | { ok: false; message: string };

export interface ArmGoalDeps {
  goalStack: GoalStack;
  /** Schedules the wake job (InitiativeService.registerGoalWake). */
  registerWake(goal: Goal): Promise<void>;
  initiativeEnabled(): Promise<boolean>;
  now?: Date;
}

const refuse = (message: string): ArmGoalResult => ({ ok: false, message });

export async function armGoal(deps: ArmGoalDeps, req: ArmGoalRequest): Promise<ArmGoalResult> {
  const gs = deps.goalStack;
  const now = deps.now ?? new Date();

  if ((req.goal === undefined) === (req.newGoal === undefined)) {
    return refuse('Give exactly one of "goal" (an existing open goal) or "newGoal" (a label for a new goal).');
  }
  if ((req.wakeAt === undefined) === (req.wakeIn === undefined)) {
    return refuse('Give exactly one of "wakeAt" (ISO-8601 timestamp) or "wakeIn" (ISO-8601 duration such as PT2H).');
  }

  // Mandate: only a real inbound utterance of this conversation counts (§5.1).
  if (!(await gs.isMandateValid(req.mandateEpisodeUri))) {
    return refuse(
      'The current message has no valid mandate episode (it must be a recorded inbound message ' +
        'from a user, not from the agent). Nothing was changed.',
    );
  }

  // Wake time.
  let wakeAt: Date;
  try {
    if (req.wakeAt !== undefined) {
      if (!ISO_INSTANT.test(req.wakeAt.trim())) {
        return refuse(`wakeAt "${req.wakeAt}" must be an ISO-8601 timestamp with a time zone, e.g. 2026-10-06T09:00:00+02:00.`);
      }
      wakeAt = new Date(req.wakeAt.trim());
    } else {
      wakeAt = addIso8601Duration(now, req.wakeIn!.trim());
    }
  } catch (e) {
    return refuse((e as Error).message);
  }
  if (Number.isNaN(wakeAt.getTime())) return refuse(`wakeAt "${req.wakeAt}" is not a valid timestamp.`);
  if (wakeAt.getTime() <= now.getTime()) return refuse('The wake time must lie in the future.');
  if (wakeAt.getTime() - now.getTime() > MAX_WAKE_INTERVAL_MS) {
    return refuse('The wake time is more than about 10 years away; use a nearer time.');
  }
  const every = req.every?.trim() || undefined;
  if (every !== undefined) {
    try {
      gs.validateWakeEvery(every); // grammar, minimum interval, ceiling: same rules as GoalStack
    } catch (e) {
      return refuse((e as Error).message);
    }
  }

  // Goal: resolved against the same list the owner sees (`/goals`, `list_goals`).
  const all = await gs.list();
  const open = all.filter(isOpenGoal);
  let uri: string;
  let created = false;
  let activated = false;
  if (req.goal !== undefined) {
    const ref = req.goal.trim();
    const byUri = open.filter((g) => g.uri === ref);
    const matches = byUri.length > 0 ? byUri : open.filter((g) => g.goalLabel.trim().toLowerCase() === ref.toLowerCase());
    if (matches.length === 0) return refuse(`No open goal matches "${ref}". Use list_goals to see the open goals, or give "newGoal".`);
    if (matches.length > 1) {
      return refuse(
        `"${ref}" matches ${matches.length} open goals; give the goal's IRI: ` +
          matches.map((g) => `${g.goalLabel} (${g.uri})`).join('; '),
      );
    }
    const g = matches[0];
    if (g.goalType === RESPOND_TO_USER) return refuse('The implicit "Respond to the user" goal cannot be armed.');
    if (g.status === 'blocked') {
      return refuse(`Goal "${g.goalLabel}" is blocked${g.blockedReason ? ` (${g.blockedReason})` : ''}; a blocked goal cannot wake.`);
    }
    uri = g.uri;
    await gs.setMandate(uri, req.mandateEpisodeUri, now);
    // An armed goal is the owner's agenda: other users must not see it.
    await gs.setOwner(uri, OWNER_USER_KEY);
    await gs.setWake(uri, { wakeAt, wakeEvery: every }, now);
    if (g.status === 'proposed') {
      await gs.setStatus(uri, 'active', undefined, now);
      activated = true;
    }
  } else {
    const label = req.newGoal!.trim();
    if (!label) return refuse('"newGoal" must be a non-empty label.');
    if (open.some((g) => g.goalLabel.trim().toLowerCase() === label.toLowerCase())) {
      return refuse(`An open goal "${label}" already exists; pass it as "goal" to arm it.`);
    }
    uri = await gs.push(
      {
        goalType: OWNER_REQUESTED_WORK,
        goalLabel: label,
        priority: req.priority ?? 0.6,
        longTerm: true,
        forUser: OWNER_USER_KEY,
        mandatedBy: req.mandateEpisodeUri,
        wakeAt,
        wakeEvery: every,
      },
      now,
    );
    created = true;
  }

  // The wake path reads the long-term graph only (§5.1).
  await gs.promoteToLongterm(uri);

  const armed = await gs.get(uri);
  if (!armed || armed.graph !== gs.longtermGraphUri()) {
    return refuse('The goal could not be placed in the long-term goal graph; no wake was scheduled.');
  }
  let scheduled = true;
  let scheduleError: string | undefined;
  try {
    await deps.registerWake(armed);
  } catch (e) {
    scheduled = false;
    scheduleError = (e as Error).message;
  }
  return {
    ok: true,
    created,
    label: armed.goalLabel,
    goalUri: uri,
    wakeAt: new Date(armed.wakeAt ?? wakeAt).toISOString(),
    ...(armed.wakeEvery ? { every: armed.wakeEvery } : {}),
    scheduled,
    ...(scheduleError ? { scheduleError } : {}),
    activated,
    initiativeEnabled: await deps.initiativeEnabled(),
  };
}
