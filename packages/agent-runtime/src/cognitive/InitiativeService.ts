/**
 * InitiativeService — the trigger + governance layer for self-initiated
 * (unattended) cognitive cycles (docs/initiative-architecture.md §5–§6).
 *
 * It does NOT contain a second mind: an initiative cycle runs through the same
 * {@link CycleManager} as a conversational one. This service is the alarm clock
 * and the governor around it:
 *
 *  - {@link registerGoalWake} schedules a one-time JobScheduler job for a goal's
 *    next wake (job name `initiative-<goalUri>`; the `initiative-` prefix is
 *    reserved and protected by the self-protection layer, so the agent cannot
 *    tamper with its own wake schedule via cron_manage).
 *  - {@link onWake} is the handler the gateway routes those jobs to. It enforces,
 *    in order: the `flagInitiative` kill switch → persisted runaway guards
 *    (cycles/hour and /day) → per-goal cooldown → mandate gate, and only then
 *    dispatches an initiative envelope through the agent.
 *  - {@link recoverOnStart} replaces any periodic sweep: one scan on boot
 *    re-registers future wakes and fires overdue ones (subject to the guards).
 *
 * Everything that would reach the owner (a notification) goes through a
 * {@link NotificationSink}; the default is a no-op logger. Actual delivery
 * (Telegram) is a separate task that drops a real sink in here — see §7.
 *
 * Determinism: the service reads "now" only through an injected {@link Clock},
 * so tests drive the hourly/daily caps and cooldown with a fake clock.
 */

import { createLogger, type MessageEnvelope, type TriplestoreAdapter } from '@ontofelia/core';
import { EpisodicMemory, GraphRegistry, GraphUriResolver } from '@ontofelia/semantic-memory';
import { CognitiveConfig } from './CognitiveConfig.js';
import { GoalStack, addIso8601Duration, type Goal } from './GoalStack.js';

const COGT = 'urn:shared:ontology#cog/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** Reserved one-time-job name prefix for initiative wakes. */
export const INITIATIVE_JOB_PREFIX = 'initiative-';

/** Fixed GoalStack session scope used to read longterm initiative goals. */
const INITIATIVE_GOAL_SCOPE = 'initiative';

/**
 * The subset of JobScheduler this service needs. Structural, so agent-runtime
 * does not take a hard dependency on @ontofelia/scheduler and tests can pass a
 * tiny fake.
 */
export interface InitiativeScheduler {
  addOneTimeJob(job: {
    name: string;
    runAt: string;
    agentId: string;
    prompt: string;
  }): Promise<{ id: string }>;
  removeJob(id: string): Promise<boolean>;
  listOneTimeJobs(): Array<{ id: string; name: string; runAt: string; status: string }>;
}

/**
 * Sink for anything an initiative cycle wants to send to the owner. The default
 * {@link LoggingNotificationSink} only logs — real outbound delivery (Telegram)
 * is a separate task that provides a concrete sink (docs §7).
 */
export interface NotificationSink {
  notify(n: { message: string; priority: 'low' | 'normal' | 'high'; goalId?: string }): Promise<void>;
}

/** Default no-op sink: records the intent to the log; delivers nothing. */
export class LoggingNotificationSink implements NotificationSink {
  private readonly logger = createLogger('initiative-notify');
  async notify(n: { message: string; priority: 'low' | 'normal' | 'high'; goalId?: string }): Promise<void> {
    this.logger.info(
      { priority: n.priority, goalId: n.goalId },
      `notify_owner (no-op sink): ${n.message}`,
    );
  }
}

/**
 * Goal-scoped session continuity (docs §6). The gateway backs this with the
 * SessionStore so consecutive wakes on a goal share one session; the default is
 * a no-op that yields a stable synthetic id without persistence (for tests).
 */
export interface InitiativeSessionPort {
  /**
   * Resolve the id of the goal's current active initiative session, creating it
   * if absent. When its transcript exceeds `cap`, the port archives it (with a
   * summarizing note) and returns a fresh id, so continuity is preserved within
   * a bounded transcript.
   */
  resolveGoalSession(goalKey: string, cap: number): Promise<string>;
  /** Archive the goal's active initiative session (on resolve/abandon). */
  archiveGoalSession(goalKey: string): Promise<void>;
}

/** No-op session port: stable id, no persistence, no archival. */
export class NoopInitiativeSessionPort implements InitiativeSessionPort {
  async resolveGoalSession(goalKey: string): Promise<string> {
    return `initiative:${goalKey}`;
  }
  async archiveGoalSession(): Promise<void> {
    /* nothing to archive without a store */
  }
}

/** Dispatch an initiative envelope through the agent (reuses handleMessage). */
export type InitiativeDispatch = (envelope: MessageEnvelope) => Promise<void>;

/** Injected clock for deterministic guard evaluation. */
export type Clock = () => Date;

/** Hard runaway guards + budgets (design §5). All have documented defaults. */
export interface InitiativeGuardConfig {
  /** Max initiative cycles per rolling hour. Default 4. */
  maxPerHour?: number;
  /** Max initiative cycles per rolling day. Default 24. */
  maxPerDay?: number;
  /** Per-goal cooldown in minutes since its last wake. Default 30. */
  cooldownMinutes?: number;
  /** Lower tool-round budget for initiative cycles (design §5). Default 25. */
  toolRoundBudget?: number;
  /** Goal-session transcript cap that triggers early archival. Default 500. */
  transcriptCap?: number;
  /** When a wake is already past, schedule it this many ms out. Default 2000. */
  pastWakeDelayMs?: number;
}

const DEFAULTS: Required<InitiativeGuardConfig> = {
  maxPerHour: 4,
  maxPerDay: 24,
  cooldownMinutes: 30,
  toolRoundBudget: 25,
  transcriptCap: 500,
  pastWakeDelayMs: 2000,
};

/** Rolling counters over the persisted run-timestamp buckets. */
export interface InitiativeCounters {
  inHour: number;
  inDay: number;
  /** Distinct run timestamps retained (last 24h), oldest-first. */
  stamps: string[];
}

/** Outcome of an {@link InitiativeService.onWake} call. */
export interface WakeOutcome {
  ran: boolean;
  reason:
    | 'dispatched'
    | 'flag-off'
    | 'goal-missing'
    | 'goal-inactive'
    | 'no-mandate'
    | 'rate-limit-hour'
    | 'rate-limit-day'
    | 'cooldown'
    | 'dispatch-failed';
}

export interface InitiativeServiceOptions {
  triplestore: TriplestoreAdapter;
  registry: GraphRegistry;
  agentId: string;
  scheduler: InitiativeScheduler;
  dispatch: InitiativeDispatch;
  cognitiveConfig?: CognitiveConfig;
  notificationSink?: NotificationSink;
  session?: InitiativeSessionPort;
  clock?: Clock;
  guards?: InitiativeGuardConfig;
}

export class InitiativeService {
  private readonly triplestore: TriplestoreAdapter;
  private readonly registry: GraphRegistry;
  private readonly agentId: string;
  private readonly scheduler: InitiativeScheduler;
  private readonly dispatch: InitiativeDispatch;
  private readonly cognitiveConfig: CognitiveConfig;
  private readonly sink: NotificationSink;
  private readonly session: InitiativeSessionPort;
  private readonly clock: Clock;
  private readonly guards: Required<InitiativeGuardConfig>;
  private readonly logger = createLogger('initiative');
  /**
   * Per-agent serialization chain (design H3). Every {@link onWake} runs
   * exclusively, so no two initiative cycles for this agent overlap. This closes
   * the getCounters→cap-check→recordRun TOCTOU (concurrent wakes can no longer
   * both pass the cap) and the concurrent embedded-triplestore write race
   * (overlapping `dataset.nq` rename → ENOENT) that a restart double-fire caused.
   */
  private wakeChain: Promise<unknown> = Promise.resolve();

  constructor(opts: InitiativeServiceOptions) {
    this.triplestore = opts.triplestore;
    this.registry = opts.registry;
    this.agentId = opts.agentId;
    this.scheduler = opts.scheduler;
    this.dispatch = opts.dispatch;
    this.cognitiveConfig =
      opts.cognitiveConfig ?? new CognitiveConfig(opts.triplestore, opts.agentId);
    this.sink = opts.notificationSink ?? new LoggingNotificationSink();
    this.session = opts.session ?? new NoopInitiativeSessionPort();
    this.clock = opts.clock ?? (() => new Date());
    this.guards = { ...DEFAULTS, ...(opts.guards ?? {}) };
  }

  /** The lower tool-round budget initiative cycles should run with (design §5). */
  get toolRoundBudget(): number {
    return this.guards.toolRoundBudget;
  }

  /** The notification sink, for the notify_owner tool wiring (design §7). */
  get notificationSink(): NotificationSink {
    return this.sink;
  }

  /** Run `fn` after any in-flight wake for this agent completes (design H3). */
  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.wakeChain.then(fn, fn);
    // Keep the chain alive regardless of individual success/failure.
    this.wakeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** One-time-job name for a goal's wake. */
  jobName(goalUri: string): string {
    return `${INITIATIVE_JOB_PREFIX}${goalUri}`;
  }

  /** Parse the goal URI back out of an `initiative-<goalUri>` job name. */
  static parseGoalUri(jobName: string): string | undefined {
    if (!jobName.startsWith(INITIATIVE_JOB_PREFIX)) return undefined;
    const uri = jobName.slice(INITIATIVE_JOB_PREFIX.length);
    return uri.length > 0 ? uri : undefined;
  }

  /** Stable per-goal session key (goal-scoped continuity across wakes). */
  private goalKey(goalUri: string): string {
    return goalUri.replace(/[^A-Za-z0-9]+/g, '_');
  }

  private goalStack(sessionScope = INITIATIVE_GOAL_SCOPE): GoalStack {
    // Pin the recurring-wake floor to the actual per-goal cooldown so a wakeEvery
    // faster than the cooldown is rejected at write time (design B1), even if the
    // cooldown is configured away from its 30-min default.
    return new GoalStack(
      this.triplestore,
      this.registry,
      this.agentId,
      sessionScope,
      this.guards.cooldownMinutes * 60_000,
    );
  }

  /**
   * Schedule (or reschedule) a one-time job for `goal.wakeAt`. A past or missing
   * wake is scheduled a small delay out so the JobScheduler accepts it. Any
   * existing pending job for the same goal is removed first, so repeated calls
   * never accumulate duplicate wakes.
   */
  async registerGoalWake(goal: Goal): Promise<void> {
    if (!goal.wakeAt) return;
    const name = this.jobName(goal.uri);
    // Remove any pending duplicate so repeated calls never accumulate wakes and
    // the scheduler's own boot re-arm cannot fire alongside us (design H3).
    await this.removePendingWakeJob(goal.uri);
    const nowMs = this.clock().getTime();
    const runAtMs = Math.max(Date.parse(goal.wakeAt), nowMs + this.guards.pastWakeDelayMs);
    await this.scheduler.addOneTimeJob({
      name,
      runAt: new Date(runAtMs).toISOString(),
      agentId: this.agentId,
      prompt: `Initiative wake for goal ${goal.uri}`,
    });
    this.logger.info(
      { goal: goal.uri, wakeAt: new Date(runAtMs).toISOString() },
      `registered initiative wake for goal ${goal.uri}`,
    );
  }

  /**
   * Handle a due goal wake. Serialized per agent (design H3) so two cycles never
   * overlap. Guard order (all enforced here, not in the LLM):
   *   flag → hourly cap → daily cap → cooldown → mandate gate → dispatch.
   * Returns a machine-readable outcome for observability/tests.
   */
  async onWake(goalUri: string): Promise<WakeOutcome> {
    return this.runExclusive(() => this.onWakeLocked(goalUri));
  }

  private async onWakeLocked(goalUri: string): Promise<WakeOutcome> {
    // 1. Kill switch. Off = silent no-op (design §5, flag default OFF).
    if (!(await this.cognitiveConfig.isInitiativeEnabled())) {
      this.logger.debug({ goal: goalUri }, 'initiative disabled; wake ignored');
      return { ran: false, reason: 'flag-off' };
    }

    const gs = this.goalStack();
    const goal = await gs.get(goalUri);
    if (!goal) {
      this.logger.warn({ goal: goalUri }, 'wake for unknown goal; ignoring');
      return { ran: false, reason: 'goal-missing' };
    }
    if (goal.status !== 'active') {
      await this.recordSkip(goal, `goal is ${goal.status}, not active`);
      return { ran: false, reason: 'goal-inactive' };
    }
    // Mandate gate (design §5): only goals with a structurally valid owner
    // mandate may wake. The same predicate gates wakingGoals/dueWakes, so a
    // fabricated or self-authored mandate IRI is rejected on every path.
    if (!(await gs.isMandateValid(goal.mandatedBy))) {
      await this.recordSkip(goal, 'no valid owner mandate (mandate gate)');
      return { ran: false, reason: 'no-mandate' };
    }

    const now = this.clock();

    // 2. Runaway guards BEFORE running (persisted counters). A cap skip must
    //    re-arm at the cap-window boundary so the wake fires when budget frees
    //    rather than being dropped — including one-shot goals (design M3).
    const counters = await this.getCounters(now);
    if (counters.inHour >= this.guards.maxPerHour) {
      await this.recordSkip(goal, `hourly initiative cap reached (${this.guards.maxPerHour}/h)`);
      await this.rescheduleAfterCap(gs, goal, now, counters, 'hour');
      return { ran: false, reason: 'rate-limit-hour' };
    }
    if (counters.inDay >= this.guards.maxPerDay) {
      await this.recordSkip(goal, `daily initiative cap reached (${this.guards.maxPerDay}/day)`);
      await this.rescheduleAfterCap(gs, goal, now, counters, 'day');
      return { ran: false, reason: 'rate-limit-day' };
    }

    // 3. Per-goal cooldown. Re-arm at the true cadence, never the 2s past-wake
    //    floor, so a blocked recurring goal cannot churn (design B1).
    if (goal.lastWakeAt) {
      const elapsedMs = now.getTime() - Date.parse(goal.lastWakeAt);
      if (elapsedMs < this.guards.cooldownMinutes * 60_000) {
        await this.recordSkip(goal, `within per-goal cooldown (${this.guards.cooldownMinutes} min)`);
        await this.rescheduleAfterCooldown(gs, goal, now);
        return { ran: false, reason: 'cooldown' };
      }
    }

    // Passed all guards — consume the budget, mark the wake, dispatch. The run
    // is counted here (at the dispatch attempt): the hourly/daily budget bounds
    // attempts, so even a cycle that later fails or is auto-denied still counts
    // against runaway limits and cannot be retried in a tight loop.
    await this.recordRun(now);
    await gs.recordWake(goalUri, now);

    const key = this.goalKey(goalUri);
    const sessionId = await this.session.resolveGoalSession(key, this.guards.transcriptCap);
    const envelope = this.buildEnvelope(goal, sessionId, now);

    try {
      await this.dispatch(envelope);
      await gs.clearWakeFailures(goalUri, now);
    } catch (e) {
      const failures = await gs.recordWakeFailure(goalUri, now);
      await this.recordSkip(goal, `initiative dispatch failed (${(e as Error).message}); failures=${failures}`);
      return { ran: false, reason: 'dispatch-failed' };
    }

    // Post-run bookkeeping: archive on terminal status; else re-register the
    // next wake (recordWake rolled wakeAt forward for recurring goals).
    const after = await gs.get(goalUri);
    if (after && (after.status === 'resolved' || after.status === 'abandoned')) {
      await this.session.archiveGoalSession(key).catch(() => undefined);
    } else if (after && after.status === 'active' && after.wakeAt) {
      await this.registerGoalWake(after);
    }

    return { ran: true, reason: 'dispatched' };
  }

  /**
   * Downtime recovery (design §5.2 — replaces the rejected periodic sweep). One
   * scan re-registers every future wake and fires overdue ones (each subject to
   * the same guards via {@link onWake}). No recurring tick is installed.
   */
  async recoverOnStart(): Promise<{ registered: number; fired: number }> {
    const gs = this.goalStack();
    const waking = await gs.wakingGoals();
    const now = this.clock();
    let registered = 0;
    let fired = 0;
    for (const goal of waking) {
      if (!goal.wakeAt) continue;
      if (Date.parse(goal.wakeAt) <= now.getTime()) {
        // Fire overdue wakes through exactly one path. Drop any persisted job so
        // the scheduler's own boot re-arm does not ALSO fire this goal (design
        // H3 restart double-fire); the onWake mutex is the backstop.
        await this.removePendingWakeJob(goal.uri);
        try {
          const outcome = await this.onWake(goal.uri);
          if (outcome.ran) fired++;
        } catch (e) {
          this.logger.error({ goal: goal.uri }, `overdue wake failed: ${(e as Error).message}`);
        }
      } else {
        await this.registerGoalWake(goal).catch(() => undefined);
        registered++;
      }
    }
    this.logger.info({ registered, fired }, 'initiative downtime recovery complete');
    return { registered, fired };
  }

  /**
   * Rolling initiative-cycle counters over the persisted run-timestamp bucket
   * in the setup graph. Exposed for the observability command (design §9).
   */
  async getCounters(now: Date = this.clock()): Promise<InitiativeCounters> {
    const stamps = await this.readRunStamps();
    const hourAgo = now.getTime() - 3_600_000;
    const dayAgo = now.getTime() - 86_400_000;
    const inHour = stamps.filter((s) => Date.parse(s) >= hourAgo).length;
    const inDay = stamps.filter((s) => Date.parse(s) >= dayAgo).length;
    return { inHour, inDay, stamps };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private counterSubject(): string {
    return `urn:${this.agentId}:setup:initiative`;
  }

  private setupGraph(): string {
    return GraphUriResolver.getSetupGraph(this.agentId);
  }

  private async readRunStamps(): Promise<string[]> {
    const res = await this.triplestore.query(`
      SELECT ?t WHERE {
        GRAPH <${this.setupGraph()}> { <${this.counterSubject()}> <${COGT}initiativeRunAt> ?t }
      }`);
    return (res.bindings ?? []).map((b) => b.t.value);
  }

  /** Append a run timestamp and prune anything older than 24h (bounded bucket). */
  private async recordRun(now: Date): Promise<void> {
    const graph = this.setupGraph();
    this.registry.assertWritable(graph);
    const cutoff = new Date(now.getTime() - 86_400_000).toISOString();
    await this.triplestore.update(`
      DELETE { GRAPH <${graph}> { <${this.counterSubject()}> <${COGT}initiativeRunAt> ?t } }
      WHERE  { GRAPH <${graph}> { <${this.counterSubject()}> <${COGT}initiativeRunAt> ?t .
               FILTER (?t < "${cutoff}"^^<${XSD}dateTime>) } }`);
    await this.triplestore.update(`
      INSERT DATA { GRAPH <${graph}> {
        <${this.counterSubject()}> <${COGT}initiativeRunAt> "${now.toISOString()}"^^<${XSD}dateTime> .
      } }`);
  }

  /** Remove any pending `initiative-<goalUri>` job from the scheduler. */
  private async removePendingWakeJob(goalUri: string): Promise<void> {
    const name = this.jobName(goalUri);
    for (const j of this.scheduler.listOneTimeJobs()) {
      if (j.name === name && j.status === 'pending') {
        await this.scheduler.removeJob(j.id).catch(() => undefined);
      }
    }
  }

  /** Persist a new `wakeAt` for a skipped goal and re-register its job. */
  private async rescheduleAt(gs: GoalStack, goal: Goal, next: Date, now: Date): Promise<void> {
    try {
      await gs.setWake(goal.uri, { wakeAt: next }, now);
      const updated = await gs.get(goal.uri);
      if (updated) await this.registerGoalWake(updated);
    } catch (e) {
      this.logger.error({ goal: goal.uri }, `reschedule failed: ${(e as Error).message}`);
    }
  }

  /**
   * Re-arm a goal skipped by the per-goal cooldown at
   * `max(lastWakeAt + cooldown, now + wakeEvery)` — never the 2s past-wake floor,
   * so a blocked recurring goal cannot churn at its wakeEvery cadence (design B1).
   * A one-shot goal (no wakeEvery) re-arms at the cooldown boundary.
   */
  private async rescheduleAfterCooldown(gs: GoalStack, goal: Goal, now: Date): Promise<void> {
    const cooldownEndMs =
      (goal.lastWakeAt ? Date.parse(goal.lastWakeAt) : now.getTime()) +
      this.guards.cooldownMinutes * 60_000;
    let nextMs = cooldownEndMs;
    if (goal.wakeEvery) {
      nextMs = Math.max(cooldownEndMs, addIso8601Duration(now, goal.wakeEvery).getTime());
    }
    await this.rescheduleAt(gs, goal, new Date(nextMs), now);
  }

  /**
   * Re-arm a goal skipped by an hourly/daily cap at the moment budget frees (the
   * oldest in-window run stamp ages out), so a one-shot mandated wake is not
   * silently dropped (design M3). A recurring goal re-arms at
   * `max(cap-window boundary, now + wakeEvery)`.
   */
  private async rescheduleAfterCap(
    gs: GoalStack,
    goal: Goal,
    now: Date,
    counters: InitiativeCounters,
    which: 'hour' | 'day',
  ): Promise<void> {
    const windowMs = which === 'hour' ? 3_600_000 : 86_400_000;
    const cutoff = now.getTime() - windowMs;
    const inWindow = counters.stamps
      .map((s) => Date.parse(s))
      .filter((t) => !Number.isNaN(t) && t >= cutoff)
      .sort((a, b) => a - b);
    const oldest = inWindow.length > 0 ? inWindow[0] : now.getTime();
    // A slot frees ~when the oldest stamp leaves the rolling window (+1s margin).
    const boundaryMs = oldest + windowMs + 1_000;
    let nextMs = boundaryMs;
    if (goal.wakeEvery) {
      nextMs = Math.max(boundaryMs, addIso8601Duration(now, goal.wakeEvery).getTime());
    }
    await this.rescheduleAt(gs, goal, new Date(nextMs), now);
  }

  /**
   * Most recent initiative skip-episode timestamp (ms) for a goal, or undefined.
   * Used to rate-limit skip episodes (design B1 fix #3).
   */
  private async lastSkipEpisodeMs(goalUri: string): Promise<number | undefined> {
    const graph = GraphUriResolver.getCogEpisodicGraph(this.agentId);
    const res = await this.triplestore.query(`
      SELECT ?t WHERE {
        GRAPH <${graph}> {
          ?ep a <${COGT}Episode> ;
              <${COGT}episodeType> "initiative" ;
              <${COGT}partOfGoal> <${goalUri}> ;
              <${COGT}occurredAt> ?t .
        }
      }`);
    const times = (res.bindings ?? [])
      .map((b) => Date.parse(b.t.value))
      .filter((n) => !Number.isNaN(n));
    return times.length > 0 ? Math.max(...times) : undefined;
  }

  private buildEnvelope(goal: Goal, sessionId: string, now: Date): MessageEnvelope {
    const why =
      goal.deadline && Date.parse(goal.deadline) - now.getTime() <= 86_400_000
        ? 'deadline approaching'
        : 'scheduled wake due';
    const text =
      `Initiative wake. Goal "${goal.goalLabel}" (${goal.uri}) is due for autonomous work: ${why}. ` +
      `You are running unattended and your output is not shown to anyone. Make progress on this goal, ` +
      `update its status/next step, and only reach the owner if the matter is urgent.`;
    return {
      id: this.newId(),
      channel: 'system',
      accountId: 'initiative',
      chatType: 'initiative',
      sender: { id: 'initiative', channelPrefix: 'system', isOwner: true },
      timestamp: now.toISOString(),
      text,
      mentions: [],
      attachments: [],
      routingHints: { sessionId, initiativeGoalId: goal.uri },
    };
  }

  /**
   * Record a governed no-op/skip (audit trail, §6/§9). At most one skip *episode*
   * is written per goal per cooldown window: a churning wake/skip loop must never
   * flood the episodic graph with tens of thousands of rows a day (design B1 fix
   * #3). Beyond that window the skip is only logged, not persisted.
   */
  private async recordSkip(goal: Goal, reason: string): Promise<void> {
    const now = this.clock();
    try {
      const windowMs = this.guards.cooldownMinutes * 60_000;
      const lastMs = await this.lastSkipEpisodeMs(goal.uri);
      if (lastMs !== undefined && now.getTime() - lastMs < windowMs) {
        this.logger.info(
          { goal: goal.uri },
          `initiative skip (episode rate-limited within cooldown window): ${reason}`,
        );
        return;
      }
      const em = new EpisodicMemory(this.triplestore, this.agentId);
      await em.append({
        episodeType: 'initiative',
        occurredAt: now,
        actor: `urn:${this.agentId}:self#${this.agentId}`,
        payload: `initiative skipped for goal "${goal.goalLabel}" (${goal.uri}): ${reason}`,
        outcome: 'success',
        partOfGoal: goal.uri,
        salience: 0.6,
      });
    } catch (e) {
      this.logger.error({ goal: goal.uri }, `could not record skip episode: ${(e as Error).message}`);
    }
    this.logger.info({ goal: goal.uri }, `initiative skip: ${reason}`);
  }

  private newId(): string {
    return typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}
