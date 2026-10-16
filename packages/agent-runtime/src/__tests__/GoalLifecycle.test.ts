import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphRegistry, GraphUriResolver, EpisodicMemory } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter, MessageEnvelope } from '@ontofelia/core';
import { CycleManager, type RunCycleOptions } from '../cognitive/CycleManager.js';
import { GoalStack, GOAL_TYPES, type Goal } from '../cognitive/GoalStack.js';
import { directGoalEpisodeSink } from '../cognitive/GoalEpisodes.js';
import { updateGoalStep } from '../cognitive/updateGoalStep.js';
import { armGoal } from '../cognitive/armGoal.js';
import {
  detectGoalSignal,
  goalFromIntent,
  goalSalience,
  INTENT_GOAL_TYPE,
} from '../cognitive/GoalLifecycle.js';
import type { PerceptionSource } from '../cognitive/Perception.js';

// Goal lifecycle (doc 07 §3, §5): transition episodes, the decision tree steps
// 1-2, the goal type mapping, goalBuffer salience, the tie-break, implicit
// goal hygiene and privacy. Runs on embedded Oxigraph like the other cycle suites.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const EPISODIC = `urn:${AGENT}:cog:episodic`;
const OWNER = { id: 'owner', channelPrefix: 'webchat', isOwner: true };
const ALICE = { id: 'alice', channelPrefix: 'webchat', isOwner: false };
const BOB = { id: 'bob', channelPrefix: 'webchat', isOwner: false };
type Sender = typeof OWNER;

const ZOE = 'urn:ontofelia:entity:zoe';
const ROME = 'urn:ontofelia:entity:rome';

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/goal-lifecycle-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

const envelope = (text: string, sender: Sender = ALICE): MessageEnvelope =>
  ({
    id: 'm1',
    channel: 'webchat',
    accountId: 'acc1',
    chatType: 'web',
    sender,
    timestamp: new Date().toISOString(),
    text,
    mentions: [],
    attachments: [],
  }) as MessageEnvelope;

/** Perception source in which the message is about the given entity IRIs. */
const aboutSource = (iris: string[]): PerceptionSource => ({
  entities: iris.map((iri, i) => ({ name: `E${i}${iri.slice(-3)}`, source: 'known' as const })),
  storedClaims: iris.map((iri, i) => ({
    subject: `E${i}${iri.slice(-3)}`,
    predicate: 'p',
    object: 'o',
    claimUri: `urn:claim:${i}`,
    subjectUri: iri,
  })),
});

describe('goal signals and mapping (pure)', () => {
  it('recognises satisfaction in English and German', () => {
    for (const t of ["thanks, that's it", "That's all, thanks!", 'passt', 'Passt so, danke', 'erledigt', 'das wars', 'danke, das war’s']) {
      expect(detectGoalSignal(t), t).toBe('satisfied');
    }
  });
  it('recognises cancellation in English and German', () => {
    for (const t of ['nevermind', 'never mind', 'forget it', 'vergiss es', 'vergiss es bitte', 'stop', 'Stopp!', 'abbrechen', 'cancel that']) {
      expect(detectGoalSignal(t), t).toBe('cancelled');
    }
  });
  it('does not treat other messages as closers', () => {
    for (const t of ['thanks', 'danke', 'stop the server', 'what is done?', 'is that it?', 'nein', 'hello', 'passt das auch zu Zoe? bitte erkläre die ganze Geschichte nochmal']) {
      expect(detectGoalSignal(t), t).toBeUndefined();
    }
    expect(detectGoalSignal('done', 'question')).toBeUndefined();
  });
  it('maps intents to goal types; chit-chat and feedback create none', () => {
    expect(INTENT_GOAL_TYPE.question).toBe(GOAL_TYPES.AnswerQuestion);
    expect(INTENT_GOAL_TYPE.command).toBe(GOAL_TYPES.ExecuteCommand);
    expect(INTENT_GOAL_TYPE.request).toBe(GOAL_TYPES.HandleRequest);
    expect(INTENT_GOAL_TYPE['topic-reference']).toBe(GOAL_TYPES.AnswerInTopic);
    expect(goalFromIntent('chit-chat', 'hello there')).toBeUndefined();
    expect(goalFromIntent('feedback', 'thanks')).toBeUndefined();
    expect(goalFromIntent('command', 'restart nginx')?.label).toBe('Execute: restart nginx');
  });
  it('salience: top 1.0, parents 0.7 minus 0.1 per extra level, floor 0.3', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(goalSalience)).toEqual([1.0, 0.7, 0.6, 0.5, 0.4, 0.3, 0.3, 0.3]);
  });
});

describe('goal lifecycle in the cycle', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let cm: CycleManager;
  let n = 0;
  let sess: string;
  const errors: unknown[] = [];

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    cm = new CycleManager(store, registry, AGENT, (e) => errors.push(e), { awaitPersist: true });
    sess = `sess_gl_${++n}_${Math.random().toString(16).slice(2, 8)}`;
    errors.length = 0;
  });

  /** One turn through the goal hook, with the perception of `about` entities. */
  async function turn(
    text: string,
    opts: { sender?: Sender; about?: string[]; options?: RunCycleOptions; manager?: CycleManager; session?: string } = {},
  ): Promise<{ prompt: string | undefined }> {
    const s = opts.session ?? sess;
    let prompt: string | undefined;
    await (opts.manager ?? cm).runCycle(
      envelope(text, opts.sender),
      async (_rt, prepareGoals, recordInbound, perceive) => {
        perceive(aboutSource(opts.about ?? []));
        await recordInbound(s);
        prompt = await prepareGoals(s);
        return { text: 'ok', sessionId: s };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { goalsEnabled: true, episodicEnabled: true, ...opts.options },
    );
    return { prompt };
  }

  const goalsOf = async (s = sess): Promise<Goal[]> =>
    new GoalStack(store, registry, AGENT, s).list();
  const real = async (s = sess) => (await goalsOf(s)).filter((g) => g.goalType !== GOAL_TYPES.RespondToUser);
  const goalEpisodes = async () =>
    (
      await store.query(`SELECT ?type ?goal ?u ?payload WHERE { GRAPH <${EPISODIC}> {
        ?e a <${COGT}Episode> ; <${COGT}episodeType> ?type ; <${COGT}partOfGoal> ?goal ; <${COGT}forUser> ?u .
        OPTIONAL { ?e <${COGT}payload> ?payload }
        FILTER(STRSTARTS(?type, "goal-")) } }`)
    ).bindings ?? [];
  const chooseRecords = async (s = sess) =>
    (
      await store.query(`SELECT ?r ?w ?l ?u WHERE { GRAPH <${GraphUriResolver.getCogCyclesGraph(AGENT, s)}> {
        ?r a <${COGT}ChooseGoal> ; <${COGT}winner> ?w ; <${COGT}forUser> ?u . OPTIONAL { ?r <${COGT}loser> ?l } } }`)
    ).bindings ?? [];

  it('a pushed goal writes a goal-pushed episode with partOfGoal and forUser', async () => {
    await turn('what is oxigraph?');
    const [g] = await real();
    const eps = await goalEpisodes();
    expect(eps).toHaveLength(1);
    expect(eps[0].type.value).toBe('goal-pushed');
    expect(eps[0].goal.value).toBe(g.uri);
    expect(eps[0].u.value).toBe('alice');
    expect(g.forUser).toBe('alice');
    expect(errors).toEqual([]);
  });

  it('no goal episode when flagEpisodicMemory is off (the goal itself is still written)', async () => {
    await turn('what is oxigraph?', { options: { episodicEnabled: false } });
    await turn('passt', { options: { episodicEnabled: false } });
    expect(await goalEpisodes()).toHaveLength(0);
    const [g] = await real();
    expect(g.status).toBe('resolved');
  });

  it('satisfaction resolves the top goal and writes goal-resolved', async () => {
    for (const cue of ["thanks, that's it", 'passt', 'erledigt']) {
      const s = `${sess}_${cue.length}`;
      await turn('what is oxigraph?', { session: s });
      await turn(cue, { session: s });
      const [g] = await real(s);
      expect(g.status, cue).toBe('resolved');
      expect(g.resolvedAt).toBeDefined();
    }
    const types = (await goalEpisodes()).map((e) => e.type.value);
    expect(types.filter((t) => t === 'goal-resolved')).toHaveLength(3);
    expect(types.filter((t) => t === 'goal-pushed')).toHaveLength(3);
  });

  it('cancellation abandons the top goal and writes goal-abandoned (German and English)', async () => {
    for (const cue of ['nevermind', 'vergiss es', 'stop']) {
      const s = `${sess}_${cue.length}`;
      await turn('what is oxigraph?', { session: s });
      await turn(cue, { session: s });
      const [g] = await real(s);
      expect(g.status, cue).toBe('abandoned');
      expect(g.abandonedAt).toBeDefined();
    }
    const types = (await goalEpisodes()).map((e) => e.type.value);
    expect(types.filter((t) => t === 'goal-abandoned')).toHaveLength(3);
    // A cancel cue creates no ExecuteCommand goal for "stop".
    expect(await real(`${sess}_4`)).toHaveLength(1);
  });

  it('plain thanks and a cue without an open goal change nothing', async () => {
    await turn('what is oxigraph?');
    await turn('danke');
    expect((await real())[0].status).toBe('active');
    await turn('passt', { session: `${sess}_x` });
    expect(await real(`${sess}_x`)).toHaveLength(0);
  });

  it('entity overlap continues the goal; no overlap creates a new goal of the mapped type', async () => {
    await turn('tell me about Zoe', { about: [ZOE] });
    let goals = await real();
    expect(goals).toHaveLength(1);
    expect(goals[0].goalType).toBe(GOAL_TYPES.HandleRequest);
    expect(goals[0].about).toEqual([ZOE]);

    await turn('what is her job?', { about: [ZOE] }); // overlap: continued
    expect(await real()).toHaveLength(1);
    expect(await chooseRecords()).toHaveLength(0);

    await turn('what is Rome?', { about: [ROME] }); // no overlap: new AnswerQuestion
    goals = await real();
    expect(goals).toHaveLength(2);
    const created = goals.find((g) => g.goalType === GOAL_TYPES.AnswerQuestion)!;
    expect(created.about).toEqual([ROME]);
  });

  it('a command turn creates an ExecuteCommand goal; chit-chat creates none', async () => {
    await turn('restart the nginx service');
    const goals = await real();
    expect(goals).toHaveLength(1);
    expect(goals[0].goalType).toBe(GOAL_TYPES.ExecuteCommand);
    await turn('hello there', { session: `${sess}_c` });
    expect(await real(`${sess}_c`)).toHaveLength(0);
    await turn('Zoe', { session: `${sess}_t`, about: [ZOE] });
    expect((await real(`${sess}_t`))[0].goalType).toBe(GOAL_TYPES.AnswerInTopic);
  });

  it('most recent intent wins a competition and a ChooseGoal record names winner and loser', async () => {
    await turn('what is oxigraph?', { about: [ZOE] });
    const [first] = await real();
    await turn('what is Rome?', { about: [ROME] });
    const second = (await real()).find((g) => g.uri !== first.uri)!;
    // New goal won over the older one (higher priority is no longer the rule).
    let recs = await chooseRecords();
    expect(recs).toHaveLength(1);
    expect(recs[0].w.value).toBe(second.uri);
    expect(recs[0].l.value).toBe(first.uri);
    expect(recs[0].u.value).toBe('alice');

    // A message about both entities: both overlap, the more recent one wins.
    await turn('how are Zoe and Rome related?', { about: [ZOE, ROME] });
    recs = await chooseRecords();
    expect(recs).toHaveLength(2);
    const last = recs.find((r) => r.w.value === second.uri && r.l.value === first.uri && r.r.value !== recs[0].r.value);
    expect(last).toBeDefined();
  });

  it('an older high-priority goal does not beat a newer one without an intent', async () => {
    const gs = new GoalStack(store, registry, AGENT, sess, undefined, { userId: 'alice', isOwner: false });
    const old = await gs.push({ goalType: GOAL_TYPES.HandleRequest, goalLabel: 'old', priority: 0.9 }, new Date('2026-01-01T00:00:00Z'));
    const recent = await gs.push({ goalType: GOAL_TYPES.HandleRequest, goalLabel: 'recent', priority: 0.2 }, new Date('2026-01-02T00:00:00Z'));
    const { prompt } = await turn('hello there');
    expect(prompt).toContain('recent');
    const recs = await chooseRecords();
    expect(recs[0].w.value).toBe(recent);
    expect(recs[0].l.value).toBe(old);
  });

  it('the implicit goal is resolved at cycle end: no zombies over five turns', async () => {
    for (let i = 0; i < 5; i++) await turn('hello there');
    const all = await goalsOf();
    expect(all.filter((g) => g.status === 'active')).toHaveLength(0);
    expect(all.every((g) => g.goalType === GOAL_TYPES.RespondToUser && g.status === 'resolved')).toBe(true);
    expect(await goalEpisodes()).toHaveLength(0); // the implicit goal has no episodes
    // Resolved implicit goals never move to the long-term graph.
    expect(await new GoalStack(store, registry, AGENT, sess).migrateLongterm()).toBe(0);
  });

  it('stale implicit goals of earlier cycles are resolved on the first touch of the session', async () => {
    const gs = new GoalStack(store, registry, AGENT, sess, undefined, { userId: 'alice', isOwner: false });
    await gs.ensureImplicit(new Date('2026-01-01T00:00:00Z'), 'alice');
    expect((await gs.active())).toHaveLength(1);
    const fresh = new CycleManager(store, registry, AGENT, (e) => errors.push(e), { awaitPersist: true });
    await turn('what is oxigraph?', { manager: fresh });
    const active = await goalsOf().then((l) => l.filter((g) => g.status === 'active'));
    expect(active.map((g) => g.goalType)).toEqual([GOAL_TYPES.AnswerQuestion]);
  });

  it('two users: a closer or a continuation never touches the other user\'s goals', async () => {
    await turn('what is oxigraph?', { sender: ALICE, about: [ZOE] });
    await turn('how do I bake bread?', { sender: BOB });
    await turn('passt', { sender: BOB }); // resolves Bob's goal only
    const goals = await real();
    const alice = goals.find((g) => g.forUser === 'alice')!;
    const bob = goals.find((g) => g.forUser === 'bob')!;
    expect(alice.status).toBe('active');
    expect(bob.status).toBe('resolved');
    // The owner sees all goals but its closer does not resolve Alice's goal.
    await turn('passt', { sender: OWNER });
    expect((await real()).find((g) => g.forUser === 'alice')!.status).toBe('active');
    // Bob's view contains no goal of Alice.
    const bobView = await new GoalStack(store, registry, AGENT, sess, undefined, { userId: 'bob', isOwner: false }).list();
    expect(bobView.every((g) => g.forUser !== 'alice')).toBe(true);
    // Every goal episode carries its owner's key.
    const eps = await goalEpisodes();
    expect(eps.filter((e) => e.u.value === 'bob').map((e) => e.type.value).sort()).toEqual(['goal-pushed', 'goal-resolved']);
    expect(eps.filter((e) => e.u.value === 'alice').map((e) => e.type.value)).toEqual(['goal-pushed']);
    expect(eps.filter((e) => e.u.value === 'owner')).toHaveLength(0);
  });

  it('goalBuffer: top goal 1.0, parents 0.7 minus 0.1 per extra level', async () => {
    const gs = new GoalStack(store, registry, AGENT, sess, undefined, { userId: 'alice', isOwner: false });
    const g0 = await gs.push({ goalType: GOAL_TYPES.HandleRequest, goalLabel: 'grand', priority: 0.5 });
    const g1 = await gs.push({ goalType: GOAL_TYPES.HandleRequest, goalLabel: 'middle', priority: 0.5, parentGoal: g0 });
    await gs.push({ goalType: GOAL_TYPES.HandleRequest, goalLabel: 'leaf', priority: 0.5, parentGoal: g1, about: [ZOE] });
    await turn('what does Zoe do?', { about: [ZOE], options: { promptMode: 'shadow' } });
    const rows =
      (
        await store.query(`SELECT ?kind ?payload ?sal WHERE { GRAPH ?g { ?e a <${COGT}WorkingMemoryEntry> ;
          <${COGT}writtenTo> "goalBuffer" ; <${COGT}entryKind> ?kind ; <${COGT}payload> ?payload ; <${COGT}salience> ?sal } }`)
      ).bindings ?? [];
    const by = (k: string) => rows.filter((r) => r.kind.value === k).map((r) => [r.payload.value, Number(r.sal.value)]);
    expect(by('goal-active')).toHaveLength(1);
    expect(by('goal-active')[0][1]).toBe(1);
    expect(by('goal-parent').map((r) => r[1]).sort()).toEqual([0.6, 0.7]);
    expect(by('goal-parent').find((r) => (r[0] as string).startsWith('middle'))![1]).toBe(0.7);
    expect(by('goal-parent').find((r) => (r[0] as string).startsWith('grand'))![1]).toBe(0.6);
  });

  it('flag off: no goal work at all (no goals, no goal episodes, no choice records)', async () => {
    await cm.runCycle(
      envelope('what is oxigraph?'),
      async (_rt, prepareGoals, recordInbound) => {
        await recordInbound(sess);
        const p = await prepareGoals(sess);
        expect(p).toBeUndefined();
        return { text: 'ok', sessionId: sess };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { goalsEnabled: false, episodicEnabled: true },
    );
    expect(await goalsOf()).toHaveLength(0);
    expect(await goalEpisodes()).toHaveLength(0);
    expect(await chooseRecords()).toHaveLength(0);
  });
});

describe('tool-driven transitions', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let enabled: boolean;
  const SESS = 'sess_tools';

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    enabled = true;
  });

  const stack = () =>
    new GoalStack(
      store,
      registry,
      AGENT,
      SESS,
      undefined,
      undefined,
      directGoalEpisodeSink({ triplestore: store, agentId: AGENT, sessionId: SESS, enabled: async () => enabled }),
    );
  const types = async () =>
    ((
      await store.query(`SELECT ?type ?goal ?u WHERE { GRAPH <${EPISODIC}> { ?e <${COGT}episodeType> ?type ;
        <${COGT}partOfGoal> ?goal ; <${COGT}forUser> ?u } }`)
    ).bindings ?? []).map((b) => `${b.type.value}|${b.u.value}`).sort();

  it('update_goal_step writes goal-resolved and goal-blocked; arm_goal writes goal-pushed', async () => {
    const gs = stack();
    const uri = await gs.push({ goalType: GOAL_TYPES.OwnerRequestedWork, goalLabel: 'write report', priority: 0.6, forUser: 'owner' });
    const r1 = await updateGoalStep({ goalStack: gs }, { sessionId: SESS, goal: uri, status: 'blocked', blockedReason: 'waiting for data' });
    expect(r1.ok).toBe(true);
    const r2 = await updateGoalStep({ goalStack: gs }, { sessionId: SESS, goal: uri, status: 'active' });
    expect(r2.ok).toBe(true);
    const r3 = await updateGoalStep({ goalStack: gs }, { sessionId: SESS, goal: uri, status: 'resolved' });
    expect(r3.ok).toBe(true);
    expect(await types()).toEqual(['goal-blocked|owner', 'goal-pushed|owner', 'goal-resolved|owner']);

    // arm_goal with a new goal pushes it (goal-pushed, owner key).
    const mandate = await new EpisodicMemory(store, AGENT).append({
      episodeType: 'message-received', actor: 'urn:entity:agent-sender:owner', actorIsOwner: true, payload: 'do it', forUser: 'owner',
    });
    const armed = await armGoal(
      { goalStack: gs, registerWake: async () => undefined, initiativeEnabled: async () => true },
      { sessionId: SESS, mandateEpisodeUri: mandate, newGoal: 'daily check', wakeIn: 'PT2H' },
    );
    expect(armed.ok).toBe(true);
    expect((await types()).filter((t) => t === 'goal-pushed|owner')).toHaveLength(2);
  });

  it('an initiative failure that blocks the goal writes goal-blocked with the reason', async () => {
    const gs = stack();
    const uri = await gs.push({ goalType: GOAL_TYPES.OwnerRequestedWork, goalLabel: 'flaky', priority: 0.6, forUser: 'owner' });
    for (let i = 0; i < 3; i++) await gs.recordWakeFailure(uri);
    const rows = (
      await store.query(`SELECT ?payload WHERE { GRAPH <${EPISODIC}> { ?e <${COGT}episodeType> "goal-blocked" ; <${COGT}payload> ?payload } }`)
    ).bindings ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.value).toContain('initiative-failures-exceeded');
  });

  it('writes no episode when a flag is off', async () => {
    enabled = false;
    const gs = stack();
    const uri = await gs.push({ goalType: GOAL_TYPES.OwnerRequestedWork, goalLabel: 'quiet', priority: 0.6, forUser: 'owner' });
    await gs.setStatus(uri, 'resolved');
    expect(await types()).toEqual([]);
  });

  it('the implicit goal never writes an episode', async () => {
    const gs = stack();
    const g = await gs.ensureImplicit(new Date(), 'owner');
    await gs.setStatus(g.uri, 'resolved');
    expect(await types()).toEqual([]);
  });
});
