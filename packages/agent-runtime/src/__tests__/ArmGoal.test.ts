import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphRegistry, GraphUriResolver, EpisodicMemory } from '@ontofelia/semantic-memory';
import type { MessageEnvelope, ToolContext, TriplestoreAdapter } from '@ontofelia/core';
import { ArmGoalTool } from '@ontofelia/tools';
import { CycleManager } from '../cognitive/CycleManager.js';
import { CognitiveConfig } from '../cognitive/CognitiveConfig.js';
import { GoalStack } from '../cognitive/GoalStack.js';
import { armGoal } from '../cognitive/armGoal.js';
import {
  InitiativeService,
  INITIATIVE_JOB_PREFIX,
  type InitiativeScheduler,
  type InitiativeSessionPort,
} from '../cognitive/InitiativeService.js';
import { INITIATIVE_ALLOWED_TOOLS } from '../initiativeTools.js';

const AGENT = 'ontofelia';
const SESS = 'sess-arm';
const COGT = 'urn:shared:ontology#cog/';
const NOW = new Date('2026-06-01T12:00:00.000Z');

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/armgoal-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

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
    if (i >= 0) this.jobs.splice(i, 1);
    return i >= 0;
  }
  listOneTimeJobs() {
    return this.jobs;
  }
}

class FakeSessionPort implements InitiativeSessionPort {
  async resolveGoalSession(goalKey: string): Promise<string> {
    return `initiative:${goalKey}`;
  }
  async archiveGoalSession(): Promise<void> {}
}

const envelope = (text: string, id = 'owner1', chatType: 'dm' | 'initiative' = 'dm'): MessageEnvelope =>
  ({
    id: 'm1',
    channel: chatType === 'initiative' ? 'system' : 'webchat',
    accountId: 'none',
    chatType,
    sender: { id, channelPrefix: 'webchat', isOwner: true },
    timestamp: NOW.toISOString(),
    text,
    mentions: [],
    attachments: [],
  }) as MessageEnvelope;

const toolCtx = (over: Partial<ToolContext>): ToolContext =>
  ({
    agentId: AGENT,
    sessionId: SESS,
    workspacePath: '/tmp',
    channelType: 'webchat',
    senderId: 'owner1',
    isOwner: true,
    ownerPresent: true,
    ...over,
  }) as ToolContext;

describe('arm_goal', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let cm: CycleManager;
  let cfg: CognitiveConfig;
  let scheduler: FakeScheduler;
  let service: InitiativeService;
  let tool: ArmGoalTool;
  let dispatched: MessageEnvelope[];
  let clockNow: Date;
  let gs: GoalStack;

  /** Run one conversational cycle and execute the tool inside it, as the runtime does. */
  async function armInTurn(input: unknown, ctx: Partial<ToolContext> = {}, env = envelope('please look at this tomorrow')) {
    let result!: Awaited<ReturnType<ArmGoalTool['execute']>>;
    await cm.runCycle(
      env,
      async (_recordTool, prepareGoals, recordInbound) => {
        await prepareGoals(SESS);
        const inboundEpisodeUri = await recordInbound(SESS);
        result = await tool.execute(input, toolCtx({ inboundEpisodeUri, ...ctx }));
        return { text: 'ok', sessionId: SESS };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { goalsEnabled: true },
    );
    return result;
  }

  async function allGoals() {
    return new GoalStack(store, registry, AGENT, SESS).list();
  }

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    cm = new CycleManager(store, registry, AGENT, undefined, { awaitPersist: true });
    cfg = new CognitiveConfig(store, AGENT);
    scheduler = new FakeScheduler();
    dispatched = [];
    clockNow = new Date(NOW);
    gs = new GoalStack(store, registry, AGENT, SESS);
    service = new InitiativeService({
      triplestore: store,
      registry,
      agentId: AGENT,
      scheduler,
      cognitiveConfig: cfg,
      dispatch: async (e) => {
        dispatched.push(e);
      },
      session: new FakeSessionPort(),
      clock: () => clockNow,
    });
    // The gateway's wiring, with a fixed clock for the arming time.
    tool = new ArmGoalTool({
      arm: async (req) =>
        armGoal(
          {
            goalStack: new GoalStack(store, registry, AGENT, req.sessionId),
            registerWake: (g) => service.registerGoalWake(g),
            initiativeEnabled: () => cfg.isInitiativeEnabled(),
            now: NOW,
          },
          req,
        ),
    });
  });

  it('arms a new goal in a normal owner turn: long-term graph, valid mandate, wake stored and scheduled, then dispatched', async () => {
    const res = await armInTurn({ newGoal: 'Review the changelog', priority: 0.8, wakeIn: 'PT2H' });
    expect(res.success).toBe(true);

    const goals = await allGoals();
    const goal = goals.find((g) => g.goalLabel === 'Review the changelog')!;
    expect(goal).toBeDefined();
    expect(goal.graph).toBe(GraphUriResolver.getCogGoalsLongtermGraph(AGENT));
    expect(goal.status).toBe('active');
    expect(goal.priority).toBe(0.8);
    expect(Date.parse(goal.wakeAt!)).toBe(Date.parse('2026-06-01T14:00:00.000Z'));
    expect(await gs.isMandateValid(goal.mandatedBy)).toBe(true);
    // Not left behind in the session graph.
    const inSession = await store.query(
      `SELECT ?g WHERE { GRAPH <${GraphUriResolver.getCogGoalsSessionGraph(AGENT, SESS)}> { <${goal.uri}> <${COGT}goalId> ?g } }`,
    );
    expect(inSession.bindings ?? []).toHaveLength(0);

    // The mandate is this turn's inbound episode, written exactly once.
    const epGraph = GraphUriResolver.getCogEpisodicGraph(AGENT);
    const inbound = await store.query(
      `SELECT ?e WHERE { GRAPH <${epGraph}> { ?e <${COGT}episodeType> "message-received" } }`,
    );
    expect((inbound.bindings ?? []).map((b) => b.e.value)).toEqual([goal.mandatedBy]);

    // The wake was scheduled through the InitiativeService.
    expect(scheduler.jobs).toHaveLength(1);
    expect(scheduler.jobs[0].name).toBe(`${INITIATIVE_JOB_PREFIX}${goal.uri}`);
    expect(scheduler.jobs[0].runAt).toBe('2026-06-01T14:00:00.000Z');
    expect(String(res.output)).toContain('2026-06-01T14:00:00.000Z');

    // With the flag on, the wake dispatches an initiative cycle for this goal.
    await cfg.setInitiativeEnabled(true);
    clockNow = new Date(NOW.getTime() + 3 * 3_600_000); // the wake is now due
    const outcome = await service.onWake(goal.uri);
    expect(outcome).toEqual({ ran: true, reason: 'dispatched' });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].routingHints?.initiativeGoalId).toBe(goal.uri);
  });

  it('reminds the owner that nothing fires while flagInitiative is off, and stops reminding when it is on', async () => {
    const off = await armInTurn({ newGoal: 'Water the plants report', wakeIn: 'PT2H' });
    expect(String(off.output)).toContain('/initiative on');
    expect(String(off.output)).toContain('will not fire');

    await cfg.setInitiativeEnabled(true);
    const on = await armInTurn({ newGoal: 'Another report', wakeIn: 'PT2H' });
    expect(on.success).toBe(true);
    expect(String(on.output)).not.toContain('/initiative on');
  });

  it('arms an existing session goal by label and moves it to the long-term graph with its URI intact', async () => {
    const uri = await gs.push({ goalType: `${COGT}Task`, goalLabel: 'Write the report', priority: 0.5 });
    const res = await armInTurn({ goal: 'write the REPORT', wakeAt: '2026-06-01T18:00:00Z', every: 'P1D' });
    expect(res.success).toBe(true);

    const goal = (await gs.get(uri))!;
    expect(goal.graph).toBe(GraphUriResolver.getCogGoalsLongtermGraph(AGENT));
    expect(goal.wakeEvery).toBe('P1D');
    expect(Date.parse(goal.wakeAt!)).toBe(Date.parse('2026-06-01T18:00:00.000Z'));
    expect(await gs.isMandateValid(goal.mandatedBy)).toBe(true);
    expect(scheduler.jobs.map((j) => j.name)).toEqual([`${INITIATIVE_JOB_PREFIX}${uri}`]);
    // The wake path (a different session scope) now sees it.
    const waking = await new GoalStack(store, registry, AGENT, 'initiative').wakingGoals();
    expect(waking.map((g) => g.uri)).toEqual([uri]);
  });

  it('refuses an interval below the minimum with the GoalStack message and writes nothing', async () => {
    const res = await armInTurn({ newGoal: 'Churn', wakeIn: 'PT2H', every: 'PT10M' });
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain('is below the minimum');
    expect((await allGoals()).some((g) => g.goalLabel === 'Churn')).toBe(false);
    expect(scheduler.jobs).toHaveLength(0);
  });

  it('refuses a non-owner and writes nothing', async () => {
    const res = await armInTurn({ newGoal: 'Not yours', wakeIn: 'PT2H' }, { isOwner: false });
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain('owner-only');
    expect((await allGoals()).some((g) => g.goalLabel === 'Not yours')).toBe(false);
    expect(scheduler.jobs).toHaveLength(0);
  });

  it('refuses in an unattended initiative context and writes nothing', async () => {
    const res = await armInTurn({ newGoal: 'Self-armed', wakeIn: 'PT2H' }, { unattended: true });
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain('unattended');
    expect((await allGoals()).some((g) => g.goalLabel === 'Self-armed')).toBe(false);
    expect(scheduler.jobs).toHaveLength(0);
  });

  it('refuses when the turn has no recorded inbound episode, naming the flag', async () => {
    const res = await tool.execute({ newGoal: 'No record', wakeIn: 'PT2H' }, toolCtx({}));
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain('cog.flagCycleManager');
    // streamed replies join the cycle now, so the refusal no longer blames streaming
    expect(String(res.output)).not.toContain('streamed');
    expect(await allGoals()).toHaveLength(0);
    expect(scheduler.jobs).toHaveLength(0);
  });

  it('refuses a mandate that is not an inbound utterance (agent-authored episode)', async () => {
    const forged = await new EpisodicMemory(store, AGENT).append({
      episodeType: 'response-sent',
      actor: `urn:${AGENT}:self#${AGENT}`,
      payload: 'I decided to work on this',
    });
    const res = await tool.execute(
      { newGoal: 'Forged', wakeIn: 'PT2H' },
      toolCtx({ inboundEpisodeUri: forged }),
    );
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain('mandate');
    expect(await allGoals()).toHaveLength(0);
    expect(scheduler.jobs).toHaveLength(0);
  });

  it('records no inbound episode ahead of an initiative cycle', async () => {
    let uri: string | undefined = 'unset';
    await cm.runCycle(
      envelope('wake', 'initiative', 'initiative'),
      async (_t, _p, recordInbound) => {
        uri = await recordInbound(SESS);
        return { text: 'ok', sessionId: SESS };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { goalsEnabled: false, mode: 'initiative' },
    );
    expect(uri).toBeUndefined();
  });

  describe('owner-only mandate (actorIsOwner marker)', () => {
    /** Run a conversational or initiative cycle and return the inbound episode it persisted. */
    async function inboundEpisodeOf(env: MessageEnvelope, mode: 'conversational' | 'initiative'): Promise<string> {
      await cm.runCycle(
        env,
        async (_t, prepareGoals, recordInbound) => {
          await prepareGoals(SESS);
          await recordInbound(SESS);
          return { text: 'ok', sessionId: SESS };
        },
        (r) => r.sessionId,
        (r) => r.text,
        { goalsEnabled: true, mode },
      );
      const epGraph = GraphUriResolver.getCogEpisodicGraph(AGENT);
      const res = await store.query(
        `SELECT ?e WHERE { GRAPH <${epGraph}> { ?e <${COGT}episodeType> "message-received" } }`,
      );
      const eps = (res.bindings ?? []).map((b) => b.e.value);
      expect(eps).toHaveLength(1);
      return eps[0];
    }

    it('an owner conversational turn is a valid mandate and carries the marker', async () => {
      const ep = await inboundEpisodeOf(envelope('do this later'), 'conversational');
      expect(await gs.isMandateValid(ep)).toBe(true);
    });

    it('a non-owner human turn is not a valid mandate', async () => {
      const env = envelope('do this later', 'stranger1');
      env.sender.isOwner = false;
      const ep = await inboundEpisodeOf(env, 'conversational');
      expect(await gs.isMandateValid(ep)).toBe(false);
    });

    it('the initiative cycle\'s own envelope (sender initiative, isOwner true) is not a valid mandate', async () => {
      const env = envelope('Initiative wake. Goal x is due.', 'initiative', 'initiative');
      expect(env.sender.isOwner).toBe(true); // the synthetic envelope claims it
      const ep = await inboundEpisodeOf(env, 'initiative');
      expect(await gs.isMandateValid(ep)).toBe(false);
    });

    it.each([
      ['scheduler (cron job)', { channel: 'cron', accountId: 'system', chatType: 'cron', sender: { id: 'scheduler', channelPrefix: 'cron', isOwner: true } }],
      ['cron-trigger endpoint', { channel: 'system', accountId: 'none', chatType: 'dm', sender: { id: 'cron', channelPrefix: 'system', isOwner: true } }],
      ['system channel with an owner id', { channel: 'system', accountId: 'none', chatType: 'dm', sender: { id: 'owner', channelPrefix: 'system', isOwner: true } }],
      ['webhook', { channel: 'webhook', accountId: 'none', chatType: 'webhook', sender: { id: 'webhook:w1', channelPrefix: 'webhook', isOwner: true } }],
    ])('a synthetic owner sender (%s) gets no marker and arm_goal is refused', async (_n, over) => {
      const env = { ...envelope('arm goal X every PT1H'), ...over } as MessageEnvelope;
      const ep = await inboundEpisodeOf(env, 'conversational');
      expect(await gs.isMandateValid(ep)).toBe(false);
      // The runtime would give such a turn ownerPresent=false; the tool refuses even with an episode.
      const res = await tool.execute(
        { newGoal: 'Self-mandated', wakeIn: 'PT2H', every: 'PT1H' },
        toolCtx({ inboundEpisodeUri: ep, ownerPresent: false }),
      );
      expect(res.success).toBe(false);
      expect((await allGoals()).some((g) => g.goalLabel === 'Self-mandated')).toBe(false);
      expect(scheduler.jobs).toHaveLength(0);
    });

    it.each([
      ['webchat', { channel: 'webchat', chatType: 'dm', sender: { id: 'owner', channelPrefix: 'webchat', isOwner: true } }],
      ['cli', { channel: 'cli', chatType: 'dm', sender: { id: 'owner', channelPrefix: 'cli', isOwner: true } }],
      ['telegram dm', { channel: 'telegram', chatType: 'dm', sender: { id: 'owner', channelPrefix: 'telegram', isOwner: true } }],
      ['telegram group', { channel: 'telegram', chatType: 'group', sender: { id: 'owner', channelPrefix: 'telegram', isOwner: true } }],
    ])('a real owner turn (%s) still gets the marker', async (_n, over) => {
      const env = { ...envelope('do this later'), ...over } as MessageEnvelope;
      const ep = await inboundEpisodeOf(env, 'conversational');
      expect(await gs.isMandateValid(ep)).toBe(true);
    });

    it('an agent-authored episode and an episode without the marker are not valid mandates', async () => {
      const em = new EpisodicMemory(store, AGENT);
      const agentEp = await em.append({
        episodeType: 'message-received',
        actor: `urn:${AGENT}:self#${AGENT}`,
        actorIsOwner: true,
        payload: 'self',
      });
      expect(await gs.isMandateValid(agentEp)).toBe(false);
      const legacy = await em.append({
        episodeType: 'message-received',
        actor: 'urn:entity:agent-sender:owner1',
        payload: 'written before the marker existed',
      });
      expect(await gs.isMandateValid(legacy)).toBe(false);
    });
  });

  it('is not allowed in unattended cycles', () => {
    expect(INITIATIVE_ALLOWED_TOOLS.has('arm_goal')).toBe(false);
  });
});
