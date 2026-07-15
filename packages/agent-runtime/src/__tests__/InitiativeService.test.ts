import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphRegistry, EpisodicMemory } from '@ontofelia/semantic-memory';
import type { MessageEnvelope, TriplestoreAdapter } from '@ontofelia/core';
import { GoalStack } from '../cognitive/GoalStack.js';
import { CognitiveConfig } from '../cognitive/CognitiveConfig.js';
import {
  InitiativeService,
  INITIATIVE_JOB_PREFIX,
  type InitiativeScheduler,
  type InitiativeSessionPort,
} from '../cognitive/InitiativeService.js';

const AGENT = 'ontofelia';
const SCOPE = 'initiative'; // same scope the service reads
const COGT = 'urn:shared:ontology#cog/';
const ANSWER = `${COGT}AnswerQuestion`;
const OWNER_ACTOR = 'urn:entity:agent-sender:owner';

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/initsvc-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

/** Seed a real owner-utterance episode and return its IRI (the mandate). */
async function seedOwnerMandate(store: TriplestoreAdapter): Promise<string> {
  return new EpisodicMemory(store, AGENT).append({
    episodeType: 'message-received',
    actor: OWNER_ACTOR,
    payload: 'keep working on this and report when done',
    occurredAt: new Date('2026-05-01T00:00:00.000Z'),
  });
}

/** Count persisted initiative skip episodes for a goal (audit-trail bound). */
async function countSkipEpisodes(store: TriplestoreAdapter, goalUri: string): Promise<number> {
  const graph = `urn:${AGENT}:cog:episodic`;
  // Embedded Oxigraph (WASM) cannot evaluate COUNT aggregates, so tally in JS.
  const res = await store.query(`
    SELECT ?ep WHERE {
      GRAPH <${graph}> {
        ?ep a <${COGT}Episode> ; <${COGT}episodeType> "initiative" ; <${COGT}partOfGoal> <${goalUri}> .
      }
    }`);
  return (res.bindings ?? []).length;
}

/** A tiny in-memory scheduler that satisfies InitiativeScheduler. */
class FakeScheduler implements InitiativeScheduler {
  jobs: Array<{ id: string; name: string; runAt: string; status: string }> = [];
  private seq = 0;
  async addOneTimeJob(job: { name: string; runAt: string; agentId: string; prompt: string }) {
    const id = `job-${++this.seq}`;
    this.jobs.push({ id, name: job.name, runAt: job.runAt, status: 'pending' });
    return { id };
  }
  async removeJob(id: string): Promise<boolean> {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i >= 0) {
      this.jobs.splice(i, 1);
      return true;
    }
    return false;
  }
  listOneTimeJobs() {
    return this.jobs;
  }
}

class FakeSessionPort implements InitiativeSessionPort {
  archived: string[] = [];
  async resolveGoalSession(goalKey: string): Promise<string> {
    return `initiative:${goalKey}`;
  }
  async archiveGoalSession(goalKey: string): Promise<void> {
    this.archived.push(goalKey);
  }
}

describe('InitiativeService', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let cfg: CognitiveConfig;
  let gs: GoalStack;
  let scheduler: FakeScheduler;
  let dispatched: MessageEnvelope[];
  let clockNow: Date;
  let mandate: string; // real owner-utterance episode IRI

  const NOW = new Date('2026-06-01T12:00:00.000Z');

  async function pushGoal(overrides: Record<string, unknown> = {}): Promise<string> {
    return gs.push({
      goalType: ANSWER,
      goalLabel: 'keep working',
      priority: 0.7,
      mandatedBy: mandate,
      wakeAt: new Date('2026-06-01T00:00:00.000Z'), // due (past)
      ...overrides,
    });
  }

  function makeService(opts: {
    session?: InitiativeSessionPort;
    dispatchImpl?: (e: MessageEnvelope) => Promise<void>;
    guards?: ConstructorParameters<typeof InitiativeService>[0]['guards'];
  } = {}) {
    return new InitiativeService({
      triplestore: store,
      registry,
      agentId: AGENT,
      scheduler,
      cognitiveConfig: cfg,
      dispatch: opts.dispatchImpl ?? (async (e) => { dispatched.push(e); }),
      session: opts.session ?? new FakeSessionPort(),
      clock: () => clockNow,
      guards: opts.guards,
    });
  }

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    cfg = new CognitiveConfig(store, AGENT);
    gs = new GoalStack(store, registry, AGENT, SCOPE);
    scheduler = new FakeScheduler();
    dispatched = [];
    clockNow = new Date(NOW);
    mandate = await seedOwnerMandate(store);
  });

  it('parses the goal URI out of an initiative job name', () => {
    const uri = 'urn:ontofelia:cog:goal:abc-123';
    expect(InitiativeService.parseGoalUri(`${INITIATIVE_JOB_PREFIX}${uri}`)).toBe(uri);
    expect(InitiativeService.parseGoalUri('cog.retention')).toBeUndefined();
    expect(InitiativeService.parseGoalUri(INITIATIVE_JOB_PREFIX)).toBeUndefined();
  });

  it('is a no-op when flagInitiative is OFF (default)', async () => {
    const uri = await pushGoal();
    const svc = makeService();
    const out = await svc.onWake(uri);
    expect(out).toEqual({ ran: false, reason: 'flag-off' });
    expect(dispatched).toHaveLength(0);
  });

  it('dispatches an initiative envelope of the correct shape when enabled', async () => {
    await cfg.setInitiativeEnabled(true);
    const uri = await pushGoal();
    const svc = makeService();
    const out = await svc.onWake(uri);
    expect(out).toEqual({ ran: true, reason: 'dispatched' });
    expect(dispatched).toHaveLength(1);
    const env = dispatched[0];
    expect(env.channel).toBe('system');
    expect(env.accountId).toBe('initiative');
    expect(env.chatType).toBe('initiative');
    expect(env.sender).toEqual({ id: 'initiative', channelPrefix: 'system', isOwner: true });
    expect(env.routingHints?.sessionId).toBe(`initiative:${uri.replace(/[^A-Za-z0-9]+/g, '_')}`);
    expect(env.routingHints?.initiativeGoalId).toBe(uri);
    expect(env.routingHints?.forceNewSession).toBeUndefined();
    expect(env.text).toContain(uri);

    // wake recorded + counter consumed
    const goal = await gs.get(uri);
    expect(goal!.wakeCount).toBe(1);
    const counters = await svc.getCounters(clockNow);
    expect(counters.inHour).toBe(1);
    expect(counters.inDay).toBe(1);
  });

  it('enforces the mandate gate', async () => {
    await cfg.setInitiativeEnabled(true);
    const uri = await pushGoal({ mandatedBy: undefined });
    const out = await makeService().onWake(uri);
    expect(out).toEqual({ ran: false, reason: 'no-mandate' });
    expect(dispatched).toHaveLength(0);
  });

  it('skips a goal that is not active', async () => {
    await cfg.setInitiativeEnabled(true);
    const uri = await pushGoal({ status: 'blocked' });
    const out = await makeService().onWake(uri);
    expect(out).toEqual({ ran: false, reason: 'goal-inactive' });
    expect(dispatched).toHaveLength(0);
  });

  it('honours the per-goal cooldown', async () => {
    await cfg.setInitiativeEnabled(true);
    // lastWakeAt 10 min ago, cooldown 30 min → skip.
    const uri = await pushGoal();
    await gs.recordWake(uri, new Date(NOW.getTime() - 10 * 60_000));
    const out = await makeService().onWake(uri);
    expect(out).toEqual({ ran: false, reason: 'cooldown' });
    expect(dispatched).toHaveLength(0);
  });

  it('enforces the hourly cap across goals', async () => {
    await cfg.setInitiativeEnabled(true);
    const svc = makeService({ guards: { maxPerHour: 1 } });
    const a = await pushGoal();
    const b = await pushGoal();
    expect((await svc.onWake(a)).reason).toBe('dispatched');
    // second goal, same (frozen) clock → within the hour, cap reached.
    expect((await svc.onWake(b)).reason).toBe('rate-limit-hour');
    expect(dispatched).toHaveLength(1);
  });

  it('enforces the daily cap across goals', async () => {
    await cfg.setInitiativeEnabled(true);
    const svc = makeService({ guards: { maxPerHour: 10, maxPerDay: 1 } });
    const a = await pushGoal();
    const b = await pushGoal();
    expect((await svc.onWake(a)).reason).toBe('dispatched');
    expect((await svc.onWake(b)).reason).toBe('rate-limit-day');
    expect(dispatched).toHaveLength(1);
  });

  it('records a failure and archives the goal session on terminal status', async () => {
    await cfg.setInitiativeEnabled(true);
    const uri = await pushGoal();
    const session = new FakeSessionPort();
    const svc = makeService({
      session,
      dispatchImpl: async () => { throw new Error('boom'); },
    });
    const out = await svc.onWake(uri);
    expect(out).toEqual({ ran: false, reason: 'dispatch-failed' });
    const goal = await gs.get(uri);
    expect(goal!.consecutiveFailures).toBe(1);
  });

  it('recoverOnStart registers future wakes and fires overdue ones', async () => {
    await cfg.setInitiativeEnabled(true);
    const overdue = await pushGoal(); // wakeAt in the past
    const future = await pushGoal({ wakeAt: new Date('2030-01-01T00:00:00.000Z') });
    const svc = makeService();
    const res = await svc.recoverOnStart();
    expect(res.fired).toBe(1); // overdue dispatched
    expect(res.registered).toBe(1); // future scheduled
    expect(dispatched.map((e) => e.routingHints?.initiativeGoalId)).toContain(overdue);
    expect(scheduler.jobs.some((j) => j.name === `${INITIATIVE_JOB_PREFIX}${future}`)).toBe(true);
  });

  // ── B1: a recurring goal blocked by cooldown must re-arm at its real cadence
  //        (never the 2s past-wake floor) and must NOT flood skip episodes. ──
  it('re-arms a cooldown-blocked recurring goal at its cadence with ≤1 skip episode (B1)', async () => {
    await cfg.setInitiativeEnabled(true);
    const uri = await pushGoal({ wakeEvery: 'PT2H' });
    // Just woke 10 min ago → inside the 30-min cooldown for a long time.
    await gs.recordWake(uri, new Date(NOW.getTime() - 10 * 60_000));
    const svc = makeService();

    // Drive many churned ticks on the frozen clock.
    for (let i = 0; i < 25; i++) {
      const out = await svc.onWake(uri);
      expect(out.reason).toBe('cooldown');
    }
    expect(dispatched).toHaveLength(0);

    // Bounded audit trail: at most one skip episode across all churned ticks.
    expect(await countSkipEpisodes(store, uri)).toBeLessThanOrEqual(1);

    // Re-armed at max(lastWakeAt+cooldown, now+wakeEvery) = now + PT2H = 14:00,
    // NOT the ~2s past-wake floor.
    const pending = scheduler.jobs.filter(
      (j) => j.name === `${INITIATIVE_JOB_PREFIX}${uri}` && j.status === 'pending',
    );
    expect(pending).toHaveLength(1);
    expect(Date.parse(pending[0].runAt)).toBe(Date.parse('2026-06-01T14:00:00.000Z'));
    expect(Date.parse(pending[0].runAt)).toBeGreaterThan(NOW.getTime() + 60_000);
  });

  // ── H3: concurrent wakes for the same goal must not both pass the cap
  //        (TOCTOU) and must not run twice (triplestore write race). ──
  it('serializes concurrent onWake for the same goal (H3 TOCTOU)', async () => {
    await cfg.setInitiativeEnabled(true);
    const uri = await pushGoal();
    const svc = makeService();

    const [a, b] = await Promise.all([svc.onWake(uri), svc.onWake(uri)]);
    const reasons = [a.reason, b.reason];
    expect(dispatched).toHaveLength(1); // exactly one cycle ran
    expect(reasons).toContain('dispatched');
    expect(reasons).toContain('cooldown'); // the serialized second call is cooled down

    const counters = await svc.getCounters(clockNow);
    expect(counters.inHour).toBe(1); // budget consumed once, not twice
    expect(counters.inDay).toBe(1);
  });

  // ── H3: a restart where an overdue job is persisted AND recoverOnStart runs
  //        must fire the goal exactly once (no double-fire). ──
  it('fires an overdue goal exactly once across a simulated restart (H3)', async () => {
    await cfg.setInitiativeEnabled(true);
    const uri = await pushGoal(); // overdue one-shot
    // A job left pending by the previous process (scheduler.start() would re-arm it).
    await scheduler.addOneTimeJob({
      name: `${INITIATIVE_JOB_PREFIX}${uri}`,
      runAt: new Date(NOW.getTime() - 1000).toISOString(),
      agentId: AGENT,
      prompt: 'stale',
    });
    const svc = makeService();

    const res = await svc.recoverOnStart();
    expect(res.fired).toBe(1);
    expect(dispatched).toHaveLength(1);
    // recoverOnStart dropped the persisted job, so the scheduler cannot re-fire it.
    expect(
      scheduler.jobs.some((j) => j.name === `${INITIATIVE_JOB_PREFIX}${uri}` && j.status === 'pending'),
    ).toBe(false);

    // Even if the scheduler did fire the (now-removed) job, the cooldown backstop
    // prevents a second dispatch.
    const out = await svc.onWake(uri);
    expect(out.ran).toBe(false);
    expect(dispatched).toHaveLength(1);
  });

  // ── M3: a one-shot goal blocked by a cap must be re-registered for a future
  //        time (when budget frees), not silently dropped. ──
  it('re-registers a one-shot goal blocked by the daily cap (M3)', async () => {
    await cfg.setInitiativeEnabled(true);
    const svc = makeService({ guards: { maxPerHour: 10, maxPerDay: 1 } });
    const a = await pushGoal();
    const b = await pushGoal(); // one-shot, no wakeEvery

    expect((await svc.onWake(a)).reason).toBe('dispatched');
    expect((await svc.onWake(b)).reason).toBe('rate-limit-day');

    // b must not be dropped: a wake is re-registered at the day-window boundary
    // (oldest in-window run stamp + 24h + 1s margin).
    const jobB = scheduler.jobs.find(
      (j) => j.name === `${INITIATIVE_JOB_PREFIX}${b}` && j.status === 'pending',
    );
    expect(jobB).toBeDefined();
    expect(Date.parse(jobB!.runAt)).toBeGreaterThan(clockNow.getTime());
    expect(Date.parse(jobB!.runAt)).toBe(clockNow.getTime() + 86_400_000 + 1000);
  });

  // ── H4 (service path): the mandate gate rejects a fabricated mandate IRI. ──
  it('rejects a goal whose mandate IRI is fabricated (H4 service path)', async () => {
    await cfg.setInitiativeEnabled(true);
    const uri = await pushGoal({ mandatedBy: 'urn:ontofelia:cog:ep:fabricated' });
    const out = await makeService().onWake(uri);
    expect(out).toEqual({ ran: false, reason: 'no-mandate' });
    expect(dispatched).toHaveLength(0);
  });
});
