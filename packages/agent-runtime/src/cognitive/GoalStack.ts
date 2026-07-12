/**
 * GoalStack — the explicit goal forest (docs/cognitive-architecture/07, Phase D).
 *
 * Goals are first-class `cogt:Goal` resources living in the session goal graph
 * `urn:<agent>:cog:goals:<sess>`; durable goals are promoted to the fixed
 * `urn:<agent>:cog:goals:longterm` graph at session close. The "stack" is really
 * a forest (every goal may have a `cogt:parentGoal`); the runtime selects the
 * *top active goal* by priority then recency.
 *
 * Implementation notes mirror {@link WorkingMemory}:
 *  - Writes are typed SPARQL `INSERT DATA` (not adapter.insertTriples) because
 *    adapters drop literal datatypes and `cogt:priority` must be a real
 *    `xsd:decimal` for SPARQL ordering.
 *  - Every mutating call routes through {@link GraphRegistry.assertWritable}, so
 *    a buggy cycle can never write outside the two registered goal graphs.
 *  - Ordering (`top`) is done in TypeScript: the embedded Oxigraph (WASM) build
 *    throws "unreachable" on some query shapes, and we already read the full
 *    active set, so sorting in-process is both safe and cheap.
 */

import type { TriplestoreAdapter } from '@ontofelia/core';
import { GraphRegistry, GraphUriResolver } from '@ontofelia/semantic-memory';

const COGT = 'urn:shared:ontology#cog/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const MS_PER_DAY = 86_400_000;

/**
 * Minimum recurring-wake interval (design §5). A `wakeEvery` faster than the
 * per-goal cooldown can only ever churn (fire → cooldown-skip → re-arm → …), so
 * it is rejected at write time. The default equals the 30-minute per-goal
 * cooldown; callers may inject a different floor via the GoalStack constructor.
 */
export const DEFAULT_MIN_WAKE_INTERVAL_MS = 30 * 60_000;

/**
 * Sanity ceiling for a wake interval (design §5). A duration that would push the
 * next wake more than ~10 years out (or overflow the Date range) is almost
 * certainly a mistake and is rejected rather than silently producing an
 * Invalid Date that mis-schedules a wake far in the future.
 */
export const MAX_WAKE_INTERVAL_MS = 10 * 365 * MS_PER_DAY;

/** Goal lifecycle states (doc 07 §3). */
export type GoalStatus = 'proposed' | 'active' | 'blocked' | 'resolved' | 'abandoned';

/** The always-present safety-net goal type and its default priority (doc 07 §5.1). */
export const RESPOND_TO_USER = `${COGT}RespondToUser`;
const RESPOND_TO_USER_PRIORITY = 0.5;

/** Opaque identifier (an IRI) of a goal. */
export type GoalId = string;

/**
 * Consecutive initiative-cycle failures after which a goal is auto-blocked so
 * it stops waking until a human or a conversation unblocks it (design §5).
 */
export const INITIATIVE_FAILURE_THRESHOLD = 3;

/** Reason stamped on the goal when {@link GoalStack.recordWakeFailure} blocks it. */
export const INITIATIVE_FAILURES_EXCEEDED = 'initiative-failures-exceeded';

/**
 * Add a *supported* ISO-8601 duration to a date. Grammar (a deliberate subset
 * of ISO-8601 durations, documented in docs/initiative-architecture.md §5):
 *
 *   P[nD][T[nH][nM][nS]]   with at least one component present, e.g.
 *     PT30M, PT2H, P1D, P1DT12H, PT90M, PT45S
 *
 * Weeks (`P1W`), months and years (`P1M`/`P1Y` — the date-part `M`/`Y`) are
 * intentionally rejected: their length is not fixed, so a wake interval built
 * from them would be ambiguous. Any string outside the grammar throws with a
 * clear message rather than silently mis-scheduling a wake.
 */
export function iso8601DurationToMs(duration: string): number {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration.trim());
  if (!m || (m[1] === undefined && m[2] === undefined && m[3] === undefined && m[4] === undefined)) {
    throw new Error(
      `Unsupported wake interval "${duration}". Supported ISO-8601 durations are ` +
        `P[nD][T[nH][nM][nS]] with at least one component (e.g. PT30M, PT2H, P1D, P1DT12H). ` +
        `Weeks, months and years are not supported because their length is not fixed.`,
    );
  }
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const minutes = Number(m[3] ?? 0);
  const seconds = Number(m[4] ?? 0);
  return ((days * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1_000;
}

/**
 * Add a supported ISO-8601 duration to a date. Throws for anything outside the
 * grammar (see {@link iso8601DurationToMs}) AND for durations so large the
 * result would overflow the Date range or land more than
 * {@link MAX_WAKE_INTERVAL_MS} out — a huge in-grammar value like `P999999999D`
 * previously produced a silent `Invalid Date` (design M1).
 */
export function addIso8601Duration(from: Date, duration: string): Date {
  const ms = iso8601DurationToMs(duration);
  const result = new Date(from.getTime() + ms);
  if (Number.isNaN(result.getTime()) || ms > MAX_WAKE_INTERVAL_MS) {
    throw new Error(
      `Wake interval "${duration}" is out of range: a wake may be scheduled at ` +
        `most ~10 years out. Use a shorter interval.`,
    );
  }
  return result;
}

export interface GoalInput {
  goalType: string; // URI
  goalLabel: string;
  priority: number; // [0,1]
  status?: GoalStatus; // defaults to 'active'
  successCriterion?: string;
  deadline?: Date;
  parentGoal?: GoalId;
  triggeredByEpisode?: string; // URI
  triggeredByUser?: string; // URI
  plannedSteps?: string;
  currentStep?: string;
  tags?: string[];
  /** Force promotion to the longterm graph at session close regardless of deadline. */
  longTerm?: boolean;
  // ── Initiative wake policy (docs/initiative-architecture.md §5) ──
  /** Absolute next wake (xsd:dateTime → cogt:wakeAt). */
  wakeAt?: Date;
  /** Recurring review interval, ISO-8601 duration (plain literal → cogt:wakeEvery). */
  wakeEvery?: string;
  /** IRI of the owner-utterance episode that mandates this goal (→ cogt:mandatedBy). */
  mandatedBy?: string;
  /** IRI of a drive this goal serves (→ cogt:servesDrive); optional anchoring. */
  servesDrive?: string;
}

export interface Goal {
  uri: GoalId;
  goalId: string;
  goalType: string;
  goalLabel: string;
  status: GoalStatus;
  priority: number;
  createdAt: string;
  updatedAt: string;
  graph: string;
  successCriterion?: string;
  deadline?: string;
  resolvedAt?: string;
  abandonedAt?: string;
  blockedReason?: string;
  parentGoal?: string;
  triggeredByEpisode?: string;
  triggeredByUser?: string;
  plannedSteps?: string;
  currentStep?: string;
  stepProgress?: string;
  longTerm?: boolean;
  // ── Initiative wake policy / tracking (docs/initiative-architecture.md §5) ──
  wakeAt?: string;
  wakeEvery?: string;
  mandatedBy?: string;
  servesDrive?: string;
  lastWakeAt?: string;
  wakeCount?: number;
  consecutiveFailures?: number;
  tags: string[];
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function escapeLiteral(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

export class GoalStack {
  private readonly minWakeIntervalMs: number;

  constructor(
    private readonly triplestore: TriplestoreAdapter,
    private readonly registry: GraphRegistry,
    private readonly agentId: string,
    private readonly sessionId: string,
    /** Injectable floor for recurring wakes (design §5). Defaults to the cooldown. */
    minWakeIntervalMs: number = DEFAULT_MIN_WAKE_INTERVAL_MS,
  ) {
    this.minWakeIntervalMs = minWakeIntervalMs;
  }

  /**
   * Reject a `wakeEvery` that is malformed, below the minimum interval (would
   * churn), or beyond the sanity ceiling (design B1/M1). Throws a clear error so
   * a bad interval is refused at write time, never at the next wake.
   */
  private validateWakeEvery(wakeEvery: string): void {
    const ms = iso8601DurationToMs(wakeEvery); // throws on bad grammar
    if (ms < this.minWakeIntervalMs) {
      throw new Error(
        `Wake interval "${wakeEvery}" (${ms} ms) is below the minimum ` +
          `${this.minWakeIntervalMs} ms (the per-goal cooldown). A recurring wake ` +
          `faster than the cooldown can only churn (wake → cooldown-skip → re-arm).`,
      );
    }
    if (ms > MAX_WAKE_INTERVAL_MS) {
      throw new Error(
        `Wake interval "${wakeEvery}" (${ms} ms) exceeds the maximum ` +
          `${MAX_WAKE_INTERVAL_MS} ms (~10 years).`,
      );
    }
  }

  sessionGraphUri(): string {
    return GraphUriResolver.getCogGoalsSessionGraph(this.agentId, this.sessionId);
  }

  longtermGraphUri(): string {
    return GraphUriResolver.getCogGoalsLongtermGraph(this.agentId);
  }

  /** Both graphs the runtime treats as the goal forest (doc 07 §4). */
  private goalGraphs(): string[] {
    return [this.sessionGraphUri(), this.longtermGraphUri()];
  }

  private newGoalUri(): GoalId {
    const rand =
      typeof globalThis.crypto?.randomUUID === 'function'
        ? globalThis.crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `urn:${this.agentId}:cog:goal:${rand}`;
  }

  /** A sortable, human-legible goal id: `goal_<iso>_<rand4>`. */
  private newGoalId(now: Date): string {
    const iso = now.toISOString().replace(/[:.]/g, '-');
    const tail = Math.floor(Math.random() * 1e4)
      .toString()
      .padStart(4, '0');
    return `goal_${iso}_${tail}`;
  }

  /**
   * Push a new goal onto the session graph. Returns its IRI. Status defaults to
   * `active`; priority is clamped to [0,1].
   */
  async push(input: GoalInput, now: Date = new Date()): Promise<GoalId> {
    const graph = this.sessionGraphUri();
    this.registry.assertWritable(graph);

    // Reject an un-schedulable recurring interval before it is ever persisted
    // (design B1/M1) — a goal created with wakeEvery below the floor would churn.
    if (input.wakeEvery !== undefined) this.validateWakeEvery(input.wakeEvery);

    const uri = this.newGoalUri();
    const goalId = this.newGoalId(now);
    const status: GoalStatus = input.status ?? 'active';
    const priority = clamp01(input.priority);
    const ts = now.toISOString();
    const dt = (s: string) => `"${s}"^^<${XSD}dateTime>`;

    const lines: string[] = [
      `<${uri}> <${RDF_TYPE}> <${COGT}Goal> .`,
      `<${uri}> <${COGT}goalId> "${escapeLiteral(goalId)}" .`,
      `<${uri}> <${COGT}goalType> <${input.goalType}> .`,
      `<${uri}> <${COGT}goalLabel> "${escapeLiteral(input.goalLabel)}" .`,
      `<${uri}> <${COGT}goalStatus> "${status}" .`,
      `<${uri}> <${COGT}priority> "${priority}"^^<${XSD}decimal> .`,
      `<${uri}> <${COGT}createdAt> ${dt(ts)} .`,
      `<${uri}> <${COGT}updatedAt> ${dt(ts)} .`,
    ];
    if (input.successCriterion)
      lines.push(`<${uri}> <${COGT}successCriterion> "${escapeLiteral(input.successCriterion)}" .`);
    if (input.deadline) lines.push(`<${uri}> <${COGT}dueAt> ${dt(input.deadline.toISOString())} .`);
    if (input.parentGoal) lines.push(`<${uri}> <${COGT}parentGoal> <${input.parentGoal}> .`);
    if (input.triggeredByEpisode)
      lines.push(`<${uri}> <${COGT}triggeredByEpisode> <${input.triggeredByEpisode}> .`);
    if (input.triggeredByUser)
      lines.push(`<${uri}> <${COGT}triggeredByUser> <${input.triggeredByUser}> .`);
    if (input.plannedSteps)
      lines.push(`<${uri}> <${COGT}plannedSteps> "${escapeLiteral(input.plannedSteps)}" .`);
    if (input.currentStep)
      lines.push(`<${uri}> <${COGT}currentStep> "${escapeLiteral(input.currentStep)}" .`);
    if (input.longTerm !== undefined)
      lines.push(`<${uri}> <${COGT}longTerm> "${input.longTerm}"^^<${XSD}boolean> .`);
    if (input.wakeAt) lines.push(`<${uri}> <${COGT}wakeAt> ${dt(input.wakeAt.toISOString())} .`);
    if (input.wakeEvery)
      lines.push(`<${uri}> <${COGT}wakeEvery> "${escapeLiteral(input.wakeEvery)}" .`);
    if (input.mandatedBy) lines.push(`<${uri}> <${COGT}mandatedBy> <${input.mandatedBy}> .`);
    if (input.servesDrive) lines.push(`<${uri}> <${COGT}servesDrive> <${input.servesDrive}> .`);
    for (const t of input.tags ?? [])
      lines.push(`<${uri}> <${COGT}tags> "${escapeLiteral(t)}" .`);

    await this.triplestore.update(`INSERT DATA { GRAPH <${graph}> {\n${lines.join('\n')}\n} }`);
    return uri;
  }

  /**
   * Ensure the implicit `RespondToUser` safety-net goal exists and is active
   * (doc 07 §5.1). If any goal is already active this is a no-op; otherwise the
   * implicit goal is pushed at priority 0.5. Returns the top active goal.
   */
  async ensureImplicit(now: Date = new Date()): Promise<Goal> {
    const active = await this.active();
    if (active.length > 0) return active[0];
    const uri = await this.push(
      { goalType: RESPOND_TO_USER, goalLabel: 'Respond to the user', priority: RESPOND_TO_USER_PRIORITY },
      now,
    );
    const goal = await this.get(uri);
    // get() can't return undefined here (we just wrote it), but keep the type honest.
    return goal ?? (await this.active())[0];
  }

  /** Transition a goal's status, stamping the matching timestamp / reason. */
  async setStatus(goalId: GoalId, status: GoalStatus, reason?: string, now: Date = new Date()): Promise<void> {
    const graph = await this.graphOf(goalId);
    if (!graph) return;
    this.registry.assertWritable(graph);
    const ts = now.toISOString();
    const dt = (s: string) => `"${s}"^^<${XSD}dateTime>`;

    await this.replaceOne(graph, goalId, `${COGT}goalStatus`, `"${status}"`);
    await this.replaceOne(graph, goalId, `${COGT}updatedAt`, dt(ts));
    if (status === 'resolved') await this.replaceOne(graph, goalId, `${COGT}resolvedAt`, dt(ts));
    if (status === 'abandoned') await this.replaceOne(graph, goalId, `${COGT}abandonedAt`, dt(ts));
    if (status === 'blocked' && reason)
      await this.replaceOne(graph, goalId, `${COGT}blockedReason`, `"${escapeLiteral(reason)}"`);
  }

  /** Update the goal's current step (and optional progress marker). */
  async setStep(goalId: GoalId, currentStep: string, progress?: string, now: Date = new Date()): Promise<void> {
    const graph = await this.graphOf(goalId);
    if (!graph) return;
    this.registry.assertWritable(graph);
    await this.replaceOne(graph, goalId, `${COGT}currentStep`, `"${escapeLiteral(currentStep)}"`);
    await this.replaceOne(
      graph,
      goalId,
      `${COGT}updatedAt`,
      `"${now.toISOString()}"^^<${XSD}dateTime>`,
    );
    if (progress !== undefined)
      await this.replaceOne(graph, goalId, `${COGT}stepProgress`, `"${escapeLiteral(progress)}"`);
  }

  // ──────────────────────────────────────────────────────────────────────
  // Initiative wake policy (docs/initiative-architecture.md §5). All writes
  // route through replaceOne (single-valued) and assertWritable, exactly like
  // the status/step mutators above.
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Set (or update) a goal's wake policy. When only `wakeEvery` is given and
   * the goal has no `wakeAt` yet, the first wake is computed as `now + wakeEvery`
   * so a recurring goal starts waking without a separate absolute seed.
   */
  async setWake(
    goalId: GoalId,
    policy: { wakeAt?: Date; wakeEvery?: string },
    now: Date = new Date(),
  ): Promise<void> {
    const graph = await this.graphOf(goalId);
    if (!graph) return;
    this.registry.assertWritable(graph);
    const dt = (s: string) => `"${s}"^^<${XSD}dateTime>`;
    if (policy.wakeEvery !== undefined) {
      // Validate grammar, floor and ceiling up front so a bad interval is
      // rejected at write time, not at the next wake (design B1/M1).
      this.validateWakeEvery(policy.wakeEvery);
      await this.replaceOne(graph, goalId, `${COGT}wakeEvery`, `"${escapeLiteral(policy.wakeEvery)}"`);
    }
    let wakeAt = policy.wakeAt;
    if (!wakeAt && policy.wakeEvery !== undefined) {
      const existing = await this.get(goalId);
      if (!existing?.wakeAt) wakeAt = addIso8601Duration(now, policy.wakeEvery);
    }
    if (wakeAt) await this.replaceOne(graph, goalId, `${COGT}wakeAt`, dt(wakeAt.toISOString()));
    await this.replaceOne(graph, goalId, `${COGT}updatedAt`, dt(now.toISOString()));
  }

  /**
   * Record that a goal just woke: stamp `lastWakeAt`, bump `wakeCount`, and
   * roll the next `wakeAt` forward by `wakeEvery`. A one-shot wake (no
   * `wakeEvery`) has its `wakeAt` cleared so it does not fire again.
   */
  async recordWake(goalId: GoalId, now: Date = new Date()): Promise<void> {
    const graph = await this.graphOf(goalId);
    if (!graph) return;
    this.registry.assertWritable(graph);
    const goal = await this.get(goalId);
    if (!goal) return;
    const dt = (s: string) => `"${s}"^^<${XSD}dateTime>`;
    await this.replaceOne(graph, goalId, `${COGT}lastWakeAt`, dt(now.toISOString()));
    const count = (goal.wakeCount ?? 0) + 1;
    await this.replaceOne(graph, goalId, `${COGT}wakeCount`, `"${count}"^^<${XSD}integer>`);
    if (goal.wakeEvery) {
      const next = addIso8601Duration(now, goal.wakeEvery);
      await this.replaceOne(graph, goalId, `${COGT}wakeAt`, dt(next.toISOString()));
    } else {
      await this.deleteOne(graph, goalId, `${COGT}wakeAt`);
    }
    await this.replaceOne(graph, goalId, `${COGT}updatedAt`, dt(now.toISOString()));
  }

  /**
   * Record a failed initiative cycle for a goal. Increments
   * `consecutiveFailures`; on reaching {@link INITIATIVE_FAILURE_THRESHOLD} the
   * goal transitions to `blocked` with reason
   * {@link INITIATIVE_FAILURES_EXCEEDED} so it stops waking until unblocked.
   * Returns the new failure count.
   */
  async recordWakeFailure(goalId: GoalId, now: Date = new Date()): Promise<number> {
    const graph = await this.graphOf(goalId);
    if (!graph) return 0;
    this.registry.assertWritable(graph);
    const goal = await this.get(goalId);
    if (!goal) return 0;
    const failures = (goal.consecutiveFailures ?? 0) + 1;
    await this.replaceOne(graph, goalId, `${COGT}consecutiveFailures`, `"${failures}"^^<${XSD}integer>`);
    await this.replaceOne(
      graph,
      goalId,
      `${COGT}updatedAt`,
      `"${now.toISOString()}"^^<${XSD}dateTime>`,
    );
    if (failures >= INITIATIVE_FAILURE_THRESHOLD) {
      await this.setStatus(goalId, 'blocked', INITIATIVE_FAILURES_EXCEEDED, now);
    }
    return failures;
  }

  /** Reset the consecutive-failure counter after a successful initiative cycle. */
  async clearWakeFailures(goalId: GoalId, now: Date = new Date()): Promise<void> {
    const graph = await this.graphOf(goalId);
    if (!graph) return;
    this.registry.assertWritable(graph);
    await this.deleteOne(graph, goalId, `${COGT}consecutiveFailures`);
    await this.replaceOne(
      graph,
      goalId,
      `${COGT}updatedAt`,
      `"${now.toISOString()}"^^<${XSD}dateTime>`,
    );
  }

  /**
   * Initiative-eligible goals whose wake is due at `now` (design §5, §12): the
   * single source of truth for eligibility. A goal wakes only when it is
   * `active`, carries a *structurally valid* owner mandate ({@link isMandateValid}
   * — the mandate gate), and its `cogt:wakeAt` is at or before `now`. Built by
   * filtering {@link wakingGoals} so there is exactly one eligibility path.
   */
  async dueWakes(now: Date = new Date()): Promise<Goal[]> {
    const nowMs = now.getTime();
    return (await this.wakingGoals()).filter(
      (g) => g.wakeAt !== undefined && Date.parse(g.wakeAt) <= nowMs,
    );
  }

  /**
   * All initiative-eligible goals that carry a wake policy (active + a valid
   * owner mandate + `cogt:wakeAt` present), regardless of whether the wake is
   * yet due. This is the one eligibility gate: {@link dueWakes} filters it by
   * time and {@link onWake} re-checks the same {@link isMandateValid} predicate.
   * Ordered earliest-first.
   */
  async wakingGoals(): Promise<Goal[]> {
    const goals = await this.readWhere(`
      ?goal <${COGT}goalStatus> "active" ;
            <${COGT}mandatedBy> ?mandate ;
            <${COGT}wakeAt> ?wake .`);
    const candidates = goals.filter((g) => g.wakeAt !== undefined && g.mandatedBy !== undefined);
    const eligible: Goal[] = [];
    for (const g of candidates) {
      if (await this.isMandateValid(g.mandatedBy)) eligible.push(g);
    }
    return eligible.sort((a, b) => Date.parse(a.wakeAt!) - Date.parse(b.wakeAt!));
  }

  /**
   * Mandate gate (design §5, decision §12.3). A goal is initiative-eligible only
   * if its `cogt:mandatedBy` resolves to a *real owner utterance episode*: a
   * subject in the episodic graph that (a) is typed `cogt:Episode`, (b) is a
   * `message-received` episode (an inbound utterance, not agent-authored output),
   * and (c) is attributed to a sender other than the agent's own self entity. A
   * fabricated/non-existent IRI, a non-episode subject (e.g. a drive or goal),
   * or an initiative-/agent-authored episode therefore all fail — closing the
   * self-mandate escape where a self-inferred goal invents its own mandate.
   *
   * Residual gap (flagged per design §5): the episodic model records the sender
   * entity (`urn:entity:agent-sender:<id>`) but does NOT persist the
   * `isOwner` bit, so this validates "inbound human utterance, not self-authored"
   * rather than strictly "the OWNER". Distinguishing owner from any other
   * inbound sender needs an owner marker on the episode (or an allowlist check)
   * and is left as a follow-up; the primary v1 threat (self-mandate) is closed.
   */
  async isMandateValid(mandatedBy: string | undefined): Promise<boolean> {
    if (!mandatedBy) return false;
    const graph = GraphUriResolver.getCogEpisodicGraph(this.agentId);
    const selfActor = `urn:${this.agentId}:self#${this.agentId}`;
    const res = await this.triplestore.query(`
      SELECT ?type ?actor WHERE {
        GRAPH <${graph}> {
          <${mandatedBy}> a <${COGT}Episode> ;
                          <${COGT}episodeType> ?type .
          OPTIONAL { <${mandatedBy}> <${COGT}actor> ?actor . }
        }
      } LIMIT 1`);
    const b = res.bindings?.[0];
    if (!b) return false; // (a) non-existent IRI or (b) not a cogt:Episode
    if (b.type?.value !== 'message-received') return false; // not an inbound utterance
    const actor = b.actor?.value;
    if (!actor || actor === selfActor) return false; // (c) agent/initiative-authored
    return true;
  }

  /** The single top active goal across both goal graphs, or null if none. */
  async top(): Promise<Goal | null> {
    const active = await this.active();
    return active[0] ?? null;
  }

  /** All active goals, ordered by descending priority then descending recency. */
  async active(): Promise<Goal[]> {
    const goals = await this.readWhere(`?goal <${COGT}goalStatus> "active" .`);
    return goals.sort(
      (a, b) =>
        b.priority - a.priority ||
        (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0),
    );
  }

  /** Every goal in both graphs, any status (read-only; for inspection/UI). */
  async list(): Promise<Goal[]> {
    const goals = await this.readWhere('');
    return goals.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  /** Fetch a single goal by IRI (searches both graphs). */
  async get(uri: GoalId): Promise<Goal | undefined> {
    const goals = await this.readWhere(`VALUES ?goal { <${uri}> }`);
    return goals[0];
  }

  /**
   * Session-end migration (doc 07 §4.1): move every goal that is `resolved`,
   * marked `cogt:longTerm true`, or whose deadline exceeds `now` from the
   * session graph to the longterm graph, preserving URI and provenance. Returns
   * the count migrated.
   */
  async migrateLongterm(now: Date = new Date()): Promise<number> {
    const session = this.sessionGraphUri();
    const longterm = this.longtermGraphUri();
    this.registry.assertWritable(session);
    this.registry.assertWritable(longterm);

    const all = await this.readGraph(session);
    const eligible = all.filter(
      (g) =>
        g.status === 'resolved' ||
        g.longTerm === true ||
        (g.deadline !== undefined && Date.parse(g.deadline) > now.getTime()),
    );
    if (eligible.length === 0) return 0;

    for (const g of eligible) {
      // A graph move: copy every triple of the goal, then delete the originals.
      await this.triplestore.update(`
        INSERT { GRAPH <${longterm}> { <${g.uri}> ?p ?o } }
        WHERE  { GRAPH <${session}> { <${g.uri}> ?p ?o } }`);
      await this.triplestore.update(`
        DELETE { GRAPH <${session}> { <${g.uri}> ?p ?o } }
        WHERE  { GRAPH <${session}> { <${g.uri}> ?p ?o } }`);
    }
    return eligible.length;
  }

  /** Replace (delete-then-insert) a single-valued predicate on a goal. */
  private async replaceOne(
    graph: string,
    uri: GoalId,
    predicate: string,
    objectTerm: string,
  ): Promise<void> {
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { <${uri}> <${predicate}> ?old } }
      WHERE  { GRAPH <${graph}> { <${uri}> <${predicate}> ?old } }`);
    await this.triplestore.update(`
      INSERT DATA { GRAPH <${graph}> { <${uri}> <${predicate}> ${objectTerm} . } }`);
  }

  /** Delete every value of a single-valued predicate on a goal (clears it). */
  private async deleteOne(graph: string, uri: GoalId, predicate: string): Promise<void> {
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { <${uri}> <${predicate}> ?old } }
      WHERE  { GRAPH <${graph}> { <${uri}> <${predicate}> ?old } }`);
  }

  /** Which goal graph holds `uri` (session preferred), or undefined if neither. */
  private async graphOf(uri: GoalId): Promise<string | undefined> {
    for (const graph of this.goalGraphs()) {
      const res = await this.triplestore.query(`
        SELECT ?p WHERE { GRAPH <${graph}> { <${uri}> <${COGT}goalId> ?p } } LIMIT 1`);
      if ((res.bindings?.length ?? 0) > 0) return graph;
    }
    return undefined;
  }

  private async readWhere(constraint: string): Promise<Goal[]> {
    const out: Goal[] = [];
    for (const graph of this.goalGraphs()) {
      out.push(...(await this.readGraph(graph, constraint)));
    }
    return out;
  }

  private async readGraph(graph: string, constraint = ''): Promise<Goal[]> {
    const sparql = `
      SELECT ?goal ?goalId ?goalType ?goalLabel ?status ?priority ?createdAt ?updatedAt
             ?successCriterion ?deadline ?resolvedAt ?abandonedAt ?blockedReason
             ?parentGoal ?triggeredByEpisode ?triggeredByUser ?plannedSteps
             ?currentStep ?stepProgress ?longTerm
             ?wakeAt ?wakeEvery ?mandatedBy ?servesDrive ?lastWakeAt ?wakeCount
             ?consecutiveFailures
      WHERE {
        GRAPH <${graph}> {
          ?goal a <${COGT}Goal> ;
                <${COGT}goalId>    ?goalId ;
                <${COGT}goalType>  ?goalType ;
                <${COGT}goalLabel> ?goalLabel ;
                <${COGT}goalStatus> ?status ;
                <${COGT}priority>  ?priority ;
                <${COGT}createdAt> ?createdAt ;
                <${COGT}updatedAt> ?updatedAt .
          ${constraint}
          OPTIONAL { ?goal <${COGT}successCriterion>   ?successCriterion . }
          OPTIONAL { ?goal <${COGT}dueAt>              ?deadline . }
          OPTIONAL { ?goal <${COGT}resolvedAt>         ?resolvedAt . }
          OPTIONAL { ?goal <${COGT}abandonedAt>        ?abandonedAt . }
          OPTIONAL { ?goal <${COGT}blockedReason>      ?blockedReason . }
          OPTIONAL { ?goal <${COGT}parentGoal>         ?parentGoal . }
          OPTIONAL { ?goal <${COGT}triggeredByEpisode> ?triggeredByEpisode . }
          OPTIONAL { ?goal <${COGT}triggeredByUser>    ?triggeredByUser . }
          OPTIONAL { ?goal <${COGT}plannedSteps>       ?plannedSteps . }
          OPTIONAL { ?goal <${COGT}currentStep>        ?currentStep . }
          OPTIONAL { ?goal <${COGT}stepProgress>       ?stepProgress . }
          OPTIONAL { ?goal <${COGT}longTerm>           ?longTerm . }
          OPTIONAL { ?goal <${COGT}wakeAt>             ?wakeAt . }
          OPTIONAL { ?goal <${COGT}wakeEvery>          ?wakeEvery . }
          OPTIONAL { ?goal <${COGT}mandatedBy>         ?mandatedBy . }
          OPTIONAL { ?goal <${COGT}servesDrive>        ?servesDrive . }
          OPTIONAL { ?goal <${COGT}lastWakeAt>         ?lastWakeAt . }
          OPTIONAL { ?goal <${COGT}wakeCount>          ?wakeCount . }
          OPTIONAL { ?goal <${COGT}consecutiveFailures> ?consecutiveFailures . }
        }
      }`;
    const res = await this.triplestore.query(sparql);
    const tags = await this.tagsFor(graph);
    return (res.bindings ?? []).map((r) => {
      const uri = r.goal.value;
      const goal: Goal = {
        uri,
        goalId: r.goalId.value,
        goalType: r.goalType.value,
        goalLabel: r.goalLabel.value,
        status: r.status.value as GoalStatus,
        priority: Number(r.priority.value),
        createdAt: r.createdAt.value,
        updatedAt: r.updatedAt.value,
        graph,
        tags: tags.get(uri) ?? [],
      };
      if (r.successCriterion) goal.successCriterion = r.successCriterion.value;
      if (r.deadline) goal.deadline = r.deadline.value;
      if (r.resolvedAt) goal.resolvedAt = r.resolvedAt.value;
      if (r.abandonedAt) goal.abandonedAt = r.abandonedAt.value;
      if (r.blockedReason) goal.blockedReason = r.blockedReason.value;
      if (r.parentGoal) goal.parentGoal = r.parentGoal.value;
      if (r.triggeredByEpisode) goal.triggeredByEpisode = r.triggeredByEpisode.value;
      if (r.triggeredByUser) goal.triggeredByUser = r.triggeredByUser.value;
      if (r.plannedSteps) goal.plannedSteps = r.plannedSteps.value;
      if (r.currentStep) goal.currentStep = r.currentStep.value;
      if (r.stepProgress) goal.stepProgress = r.stepProgress.value;
      if (r.longTerm) goal.longTerm = r.longTerm.value === 'true';
      if (r.wakeAt) goal.wakeAt = r.wakeAt.value;
      if (r.wakeEvery) goal.wakeEvery = r.wakeEvery.value;
      if (r.mandatedBy) goal.mandatedBy = r.mandatedBy.value;
      if (r.servesDrive) goal.servesDrive = r.servesDrive.value;
      if (r.lastWakeAt) goal.lastWakeAt = r.lastWakeAt.value;
      if (r.wakeCount) goal.wakeCount = Number(r.wakeCount.value);
      if (r.consecutiveFailures) goal.consecutiveFailures = Number(r.consecutiveFailures.value);
      return goal;
    });
  }

  /** Multi-valued `cogt:tags`, grouped by goal IRI. */
  private async tagsFor(graph: string): Promise<Map<string, string[]>> {
    const res = await this.triplestore.query(`
      SELECT ?goal ?t WHERE {
        GRAPH <${graph}> { ?goal a <${COGT}Goal> ; <${COGT}tags> ?t }
      }`);
    const map = new Map<string, string[]>();
    for (const r of res.bindings ?? []) {
      const arr = map.get(r.goal.value) ?? [];
      arr.push(r.t.value);
      map.set(r.goal.value, arr);
    }
    return map;
  }
}
