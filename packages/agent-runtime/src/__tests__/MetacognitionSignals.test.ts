import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphRegistry, GraphUriResolver, type EntityFact } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter, MessageEnvelope } from '@ontofelia/core';
import { CycleManager, type RunCycleOptions, type ToolEpisodeEvent } from '../cognitive/CycleManager.js';
import { GoalStack, GOAL_TYPES } from '../cognitive/GoalStack.js';
import {
  Metacognition,
  CHURN_TOOL_CALLS,
  conflictsOfTurn,
  goalProgressOf,
  isUnknownQuestion,
  uncertaintyOf,
} from '../cognitive/Metacognition.js';
import type { RecallEntry } from '../cognitive/Comprehension.js';
import type { PerceptionSource } from '../cognitive/Perception.js';

// Metacognition signals of a cycle and the cross-cycle scan: markers carry
// goalDrift, goalProgress, newKnowledge, uncertainty and the conflict count; a
// conflict of the turn pushes a ResolveConflict goal; the scan reads one user's
// records at a time. Runs on embedded Oxigraph like the other cycle suites.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const OWNER = { id: 'owner', channelPrefix: 'webchat', isOwner: true };
const ALICE = { id: 'alice', channelPrefix: 'webchat', isOwner: false };
const BOB = { id: 'bob', channelPrefix: 'webchat', isOwner: false };
type Sender = typeof OWNER;
const ZOE = 'urn:ontofelia:entity:zoe';
const WIDE = { since: new Date('2000-01-01T00:00:00Z'), until: new Date('2100-01-01T00:00:00Z') };
const META = GraphUriResolver.getCogMetaGraph(AGENT);

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/meta-signals-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

const envelope = (text: string, sender: Sender = ALICE): MessageEnvelope =>
  ({
    id: 'm1', channel: 'webchat', accountId: 'acc1', chatType: 'web', sender,
    timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
  }) as MessageEnvelope;

const source = (over: Partial<PerceptionSource> = {}): PerceptionSource => ({ entities: [], storedClaims: [], ...over });
const aboutSource = (iris: string[], over: Partial<PerceptionSource> = {}): PerceptionSource => ({
  entities: iris.map((iri, i) => ({ name: `E${i}${iri.slice(-3)}`, source: 'known' as const })),
  storedClaims: iris.map((iri, i) => ({
    subject: `E${i}${iri.slice(-3)}`, predicate: 'p', object: 'o', claimUri: `urn:claim:${i}`, subjectUri: iri,
  })),
  ...over,
});

const toolRun = (name: string, outcome: 'success' | 'error', id = name): ToolEpisodeEvent[] => [
  { phase: 'called', toolName: name, callId: id, occurredAt: new Date() },
  { phase: 'completed', toolName: name, callId: id, occurredAt: new Date(), outcome, ...(outcome === 'error' ? { errorClass: 'tool-error' } : {}) },
];

const fact = (scope: 'user' | 'worldview', supersededAt?: string): EntityFact => ({
  entity: ZOE, direction: 'out', subject: ZOE, subjectLabel: 'Zoe',
  predicate: 'urn:ontofelia:prop:city', predicateLabel: 'lives in',
  object: 'urn:ontofelia:entity:rome', objectLabel: 'Rome', objectIsIri: true,
  graph: scope === 'user' ? `urn:${AGENT}:user:alice` : `urn:${AGENT}:worldview`, scope,
  ...(supersededAt ? { superseded: { previousObject: 'urn:ontofelia:entity:paris', previousLabel: 'Paris', supersededAt } } : {}),
});

describe('signals of a cycle (pure)', () => {
  it('uncertainty: empty retrieval counts for a question only; errors add; documented table', () => {
    const u = uncertaintyOf;
    expect(u({ emptyRetrieval: false, intent: 'question', toolErrors: 0 })).toBe('low');
    expect(u({ emptyRetrieval: true, intent: 'chit-chat', toolErrors: 0 })).toBe('low');
    expect(u({ emptyRetrieval: true, intent: 'question', toolErrors: 0 })).toBe('medium');
    expect(u({ emptyRetrieval: false, intent: 'question', toolErrors: 1 })).toBe('medium');
    expect(u({ emptyRetrieval: true, intent: 'question', toolErrors: 1 })).toBe('high');
    expect(u({ emptyRetrieval: false, intent: 'request', toolErrors: 3 })).toBe('high');
  });

  it('the unknown rule needs a question and a clean, empty retrieval', () => {
    const ok = { empty: true, status: 'ok' as const };
    expect(isUnknownQuestion('question', ok)).toBe(true);
    expect(isUnknownQuestion('chit-chat', ok)).toBe(false);
    expect(isUnknownQuestion('question', { empty: false, status: 'ok' })).toBe(false);
    expect(isUnknownQuestion('question', { empty: true, status: 'partial' })).toBe(false);
    expect(isUnknownQuestion('question', { empty: true, status: 'timeout' })).toBe(false);
    expect(isUnknownQuestion('question', undefined)).toBe(false);
    expect(isUnknownQuestion(undefined, ok)).toBe(false);
  });

  it('goal progress text names steps and resolved goals, and is absent when there are none', () => {
    expect(goalProgressOf({ stepUpdates: 0, goalsResolved: 0 })).toBeUndefined();
    expect(goalProgressOf({ stepUpdates: 2, goalsResolved: 1 })).toBe('2 step update(s), 1 goal(s) resolved');
  });

  it('a conflict of the turn is a changed fact of the sender\'s own graph, replaced during the turn, compared as instants', () => {
    const entry = (over: Partial<RecallEntry>): RecallEntry => ({
      kind: 'fact', payload: 'Zoe lives in Rome', score: 0.7, sourceGraph: 'g', refersTo: ZOE, forUser: 'alice',
      specificity: 'user', changed: { previous: 'Paris', supersededAt: '2026-10-15T10:00:41.4Z' }, ...over,
    });
    // The store trims the fraction: ".4Z" is 400 ms. As strings ".4Z" > ".431Z"; as instants it is earlier.
    expect(conflictsOfTurn([entry({})], '2026-10-15T10:00:41.431Z')).toHaveLength(0);
    expect(conflictsOfTurn([entry({})], '2026-10-15T10:00:41.399Z')).toHaveLength(1);
    expect(conflictsOfTurn([entry({})], '2026-10-15T10:00:41.400Z')).toHaveLength(1);
    expect(conflictsOfTurn([entry({ specificity: 'worldview' })], '2000-01-01T00:00:00Z')).toHaveLength(0);
    expect(conflictsOfTurn([entry({ kind: 'episode-ref', specificity: undefined })], '2000-01-01T00:00:00Z')).toHaveLength(0);
    expect(conflictsOfTurn([entry({ changed: undefined })], '2000-01-01T00:00:00Z')).toHaveLength(0);
    expect(CHURN_TOOL_CALLS).toBe(5);
  });
});

describe('the marker of a cycle', () => {
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
    sess = `sess_ms_${++n}_${Math.random().toString(16).slice(2, 8)}`;
    errors.length = 0;
  });

  interface TurnOpts {
    sender?: Sender;
    source?: PerceptionSource;
    tools?: ToolEpisodeEvent[];
    /** Facts read for the entity; a function is called during the turn (after it started). */
    facts?: EntityFact[] | (() => EntityFact[]);
    options?: RunCycleOptions;
    comprehend?: boolean;
    session?: string;
  }

  async function turn(text: string, opts: TurnOpts = {}): Promise<void> {
    const s = opts.session ?? sess;
    await cm.runCycle(
      envelope(text, opts.sender),
      async (recordTool, prepareGoals, recordInbound, perceive, comprehendHook) => {
        perceive(opts.source ?? source());
        if (opts.comprehend !== false) await comprehendHook(s);
        await prepareGoals(s);
        await recordInbound(s);
        for (const ev of opts.tools ?? []) recordTool(ev);
        return { text: 'ok', sessionId: s };
      },
      (r) => r.sessionId,
      (r) => r.text,
      {
        goalsEnabled: true,
        episodicEnabled: true,
        metacognitionEnabled: true,
        entityFacts: opts.facts ? async () => (typeof opts.facts === 'function' ? opts.facts() : opts.facts) as EntityFact[] : undefined,
        ...opts.options,
      },
    );
    await new Promise((r) => setTimeout(r, 3)); // distinct marker times
  }

  interface Marker {
    user?: string; knowledge?: string; uncertainty?: string; drift?: string; conflicts?: string;
    progress?: string; empty?: string; triples: number;
  }
  async function markers(): Promise<Marker[]> {
    const res = await store.query(`SELECT ?m ?at ?u ?nk ?unc ?drift ?cs ?gp ?er WHERE { GRAPH <${META}> {
      ?m a <${COGT}ReflectiveMarker> ; <${COGT}createdAt> ?at .
      OPTIONAL { ?m <${COGT}forUser> ?u } OPTIONAL { ?m <${COGT}newKnowledge> ?nk }
      OPTIONAL { ?m <${COGT}uncertainty> ?unc } OPTIONAL { ?m <${COGT}goalDrift> ?drift }
      OPTIONAL { ?m <${COGT}conflictSurfaced> ?cs } OPTIONAL { ?m <${COGT}goalProgress> ?gp }
      OPTIONAL { ?m <${COGT}emptyRetrieval> ?er } } } ORDER BY ?at`);
    const out: Marker[] = [];
    for (const r of res.bindings ?? []) {
      const c = await store.query(`SELECT ?p WHERE { GRAPH <${META}> { <${r.m.value}> ?p ?o } }`);
      out.push({
        user: r.u?.value, knowledge: r.nk?.value, uncertainty: r.unc?.value, drift: r.drift?.value,
        conflicts: r.cs?.value, progress: r.gp?.value, empty: r.er?.value, triples: (c.bindings ?? []).length,
      });
    }
    return out;
  }
  const last = async () => (await markers()).at(-1) as Marker;
  const goalsOf = async (type: string, s = sess) =>
    (await new GoalStack(store, registry, AGENT, s).list()).filter((g) => g.goalType === type);

  it('newKnowledge is the number of stored facts of the ingestion report', async () => {
    await turn('my sister lives in Rome and works at a bank', { source: source({ storedFactCount: 2 }) });
    expect((await last()).knowledge).toBe('2');
    await turn('nothing new here for you', { source: source({ storedFactCount: 0 }) });
    expect((await last()).knowledge).toBe('0');
    // No report count: the claims of the perception are the count.
    await turn('claims only', { source: aboutSource([ZOE]) });
    expect((await last()).knowledge).toBe('1');
    expect(errors).toEqual([]);
  });

  it('uncertainty follows empty retrieval and tool errors (question, empty, one failed tool => high)', async () => {
    // A fresh session per turn: an earlier turn of the same session would be recalled.
    await turn('who is Quentin Blorf?', { session: `${sess}1` });
    expect(await last()).toMatchObject({ uncertainty: 'medium', empty: 'true' });
    await turn('who is Quentin Blorf?', { session: `${sess}2`, tools: toolRun('lookup', 'error') });
    expect((await last()).uncertainty).toBe('high');
    await turn('well that is interesting indeed', { session: `${sess}3`, tools: toolRun('lookup', 'success') });
    expect((await last()).uncertainty).toBe('low');
    await turn('what does Zoe do?', { session: `${sess}4`, source: aboutSource([ZOE]), facts: [fact('worldview')] });
    expect(await last()).toMatchObject({ uncertainty: 'low', empty: 'false' });
    expect(errors).toEqual([]);
  });

  it('every marker carries the user of the cycle', async () => {
    await turn('what is oxigraph?', { sender: ALICE });
    await turn('what is oxigraph?', { sender: BOB, session: `${sess}b` });
    await turn('what is oxigraph?', { sender: OWNER, session: `${sess}c` });
    expect((await markers()).map((m) => m.user)).toEqual(['alice', 'bob', 'owner']);
  });

  it('goalProgress counts resolved goals and goal step updates of the cycle', async () => {
    await turn('what is oxigraph?');
    expect((await last()).progress).toBeUndefined();
    await turn('passt');
    expect((await last()).progress).toBe('1 goal(s) resolved');
    await turn('what is rome?', { tools: toolRun('update_goal_step', 'success') });
    expect((await last()).progress).toBe('1 step update(s)');
  });

  describe('goalDrift', () => {
    const alice = () => new GoalStack(store, registry, AGENT, sess, undefined, { userId: 'alice', isOwner: false });

    /** Turn 1 makes a goal; then another actor abandons it and pushes a different one. */
    async function changedBehindTheBack(): Promise<void> {
      await turn('what is oxigraph?');
      const [first] = await goalsOf(GOAL_TYPES.AnswerQuestion);
      await alice().setStatus(first.uri, 'abandoned');
      await alice().push({ goalType: GOAL_TYPES.HandleRequest, goalLabel: 'Handle request: something else', priority: 0.7, forUser: 'alice' });
    }

    it('is true when the top goal changed and the message did not cause it', async () => {
      await changedBehindTheBack();
      await turn('well that is interesting indeed'); // chit-chat: keeps the latest goal, links nothing
      expect((await markers()).map((m) => m.drift)).toEqual(['false', 'true']);
    });

    it('is false when the user\'s intent chose the new goal', async () => {
      await changedBehindTheBack();
      await turn('what is rome?');
      expect((await last()).drift).toBe('false');
    });

    it('is false when nothing changed, and when the user closed the goal', async () => {
      await turn('what is oxigraph?');
      await turn('well that is interesting indeed');
      expect((await last()).drift).toBe('false');
      await turn('passt');
      expect((await last()).drift).toBe('false');
    });

    it('is not measured without the goal stack', async () => {
      await turn('what is oxigraph?', { options: { goalsEnabled: false } });
      expect((await last()).drift).toBeUndefined();
    });
  });

  describe('conflict surfaced', () => {
    const NOW = () => new Date().toISOString();
    const conflictGoals = () => goalsOf(GOAL_TYPES.ResolveConflict);
    const run = (facts: EntityFact[] | (() => EntityFact[]), options: RunCycleOptions = {}, extra: TurnOpts = {}) =>
      turn('what does Zoe do?', { source: aboutSource([ZOE]), facts, options, ...extra });

    it('a fact of the sender\'s own graph changed this turn pushes a ResolveConflict goal for the sender', async () => {
      await run(() => [fact('user', NOW())]);
      const goals = await conflictGoals();
      expect(goals).toHaveLength(1);
      expect(goals[0]).toMatchObject({ forUser: 'alice', status: 'active', about: [ZOE] });
      expect(goals[0].goalLabel).toContain('Zoe lives in Rome');
      expect((await last()).conflicts).toBe('1');
      expect(errors).toEqual([]);
    });

    it('is not pushed twice for the same conflict', async () => {
      await run(() => [fact('user', NOW())]);
      await run(() => [fact('user', NOW())]);
      expect(await conflictGoals()).toHaveLength(1);
    });

    it('is pushed with metacognition and goals on only', async () => {
      await run(() => [fact('user', NOW())], { metacognitionEnabled: false });
      await run(() => [fact('user', NOW())], { goalsEnabled: false }, { session: `${sess}x` });
      expect(await conflictGoals()).toHaveLength(0);
      expect(await goalsOf(GOAL_TYPES.ResolveConflict, `${sess}x`)).toHaveLength(0);
      // With goals off the conflict still shows in the marker.
      expect((await last()).conflicts).toBe('1');
    });

    it('is not pushed for the worldview, for an older change, or for no change', async () => {
      await run(() => [fact('worldview', NOW())]);
      await run([fact('user', '2020-01-01T00:00:00Z')]);
      await run([fact('user')]);
      expect(await conflictGoals()).toHaveLength(0);
      expect((await last()).conflicts).toBe('0');
    });

    it('belongs to the sender: another user in the same session neither sees nor inherits it', async () => {
      await run(() => [fact('user', NOW())]);
      const bob = new GoalStack(store, registry, AGENT, sess, undefined, { userId: 'bob', isOwner: false });
      expect((await bob.active()).filter((g) => g.goalType === GOAL_TYPES.ResolveConflict)).toHaveLength(0);
      const owner = new GoalStack(store, registry, AGENT, sess, undefined, { userId: 'owner', isOwner: true });
      expect((await owner.active()).filter((g) => g.goalType === GOAL_TYPES.ResolveConflict)).toHaveLength(1); // owner sees all
    });
  });

  describe('metacognition off', () => {
    it('writes only the minimal marker and nothing of the new signals', async () => {
      await turn('who is Quentin Blorf?', {
        options: { metacognitionEnabled: false },
        source: aboutSource([ZOE], { storedFactCount: 3 }),
        tools: [...toolRun('a', 'success'), ...toolRun('a', 'success', 'a2'), ...toolRun('a', 'success', 'a3')],
        facts: () => [fact('user', new Date().toISOString())],
      });
      const m = await last();
      expect(m.triples).toBe(4); // type, reflectsOn, createdAt, noted
      expect([m.user, m.knowledge, m.uncertainty, m.drift, m.conflicts, m.progress, m.empty]).toEqual(Array(7).fill(undefined));
      const wm = await store.query(`SELECT ?e WHERE { GRAPH ?g { ?e <${COGT}writtenTo> "metaBuffer" } }`);
      expect(wm.bindings ?? []).toHaveLength(0);
      expect(await goalsOf(GOAL_TYPES.ResolveConflict)).toHaveLength(0);
      expect(errors).toEqual([]);
    });
  });
});

describe('the weekly scan (cross-cycle)', () => {
  let store: TriplestoreAdapter;
  let meta: Metacognition;

  beforeEach(async () => {
    store = await makeStore();
    meta = new Metacognition(store, AGENT);
  });

  const marker = (user: string | undefined, drift: boolean, at: string, pressure?: number) =>
    meta.writeMarker({
      cycleUri: `urn:${AGENT}:cog:cycle:${Math.random().toString(16).slice(2)}`,
      cycleStatus: 'completed',
      goalDrift: drift,
      ...(pressure !== undefined ? { constraintPressure: pressure } : {}),
      ...(user ? { forUser: user } : {}),
      createdAt: new Date(at),
    });

  it('detects drift on synthetic markers of one user', async () => {
    await marker('alice', true, '2026-10-10T10:00:00Z');
    await marker('alice', true, '2026-10-10T11:00:00Z');
    await marker('alice', false, '2026-10-10T12:00:00Z');
    await marker('alice', false, '2026-10-10T13:00:00Z');
    const r = await meta.crossCycleScan(WIDE, { forUser: 'alice' });
    expect(r).toMatchObject({ cyclesScanned: 4, driftCycles: 2, driftDetected: true, forUser: 'alice' });
  });

  it('does not report drift at or below the fraction, and ignores markers outside the window', async () => {
    for (let i = 0; i < 7; i++) await marker('alice', i === 0, `2026-10-10T1${i}:00:00Z`);
    await marker('alice', true, '2025-01-01T00:00:00Z'); // outside
    const r = await meta.crossCycleScan({ since: new Date('2026-10-01T00:00:00Z'), until: new Date('2026-10-20T00:00:00Z') }, { forUser: 'alice' });
    expect(r).toMatchObject({ cyclesScanned: 7, driftCycles: 1, driftDetected: false });
  });

  it('reads one user only: drift of alice is invisible to bob and to the owner', async () => {
    await marker('alice', true, '2026-10-10T10:00:00Z');
    await marker('alice', true, '2026-10-10T11:00:00Z');
    await marker('bob', false, '2026-10-10T12:00:00Z');
    const bob = await meta.crossCycleScan(WIDE, { forUser: 'bob' });
    expect(bob).toMatchObject({ cyclesScanned: 1, driftDetected: false });
    const owner = await meta.crossCycleScan(WIDE);
    expect(owner).toMatchObject({ cyclesScanned: 0, driftDetected: false, forUser: 'owner' });
    expect(await meta.usersInWindow(WIDE)).toEqual(expect.arrayContaining(['alice', 'bob']));
  });

  it('the owner scope also holds records written before the user key existed', async () => {
    await marker(undefined, true, '2026-10-10T10:00:00Z'); // legacy: no key
    await marker('owner', true, '2026-10-10T11:00:00Z');
    await marker('alice', false, '2026-10-10T12:00:00Z');
    const owner = await meta.crossCycleScan(WIDE);
    expect(owner).toMatchObject({ cyclesScanned: 2, driftCycles: 2, driftDetected: true });
    expect((await meta.crossCycleScan(WIDE, { forUser: 'alice' })).cyclesScanned).toBe(1);
  });

  it('compares instants: a stored time with a trimmed fraction is inside a window that ends a few ms later', async () => {
    await marker('alice', true, '2026-10-10T10:00:41.400Z'); // the store reads this back as "...41.4Z"
    const r = await meta.crossCycleScan(
      { since: new Date('2026-10-10T10:00:41.000Z'), until: new Date('2026-10-10T10:00:41.431Z') },
      { forUser: 'alice' },
    );
    expect(r.cyclesScanned).toBe(1);
    const after = await meta.crossCycleScan(
      { since: new Date('2026-10-10T10:00:41.401Z'), until: new Date('2026-10-10T10:00:42.000Z') },
      { forUser: 'alice' },
    );
    expect(after.cyclesScanned).toBe(0);
  });

  it('a chronic impasse and its long-term goal belong to the user whose impasses they are', async () => {
    for (let i = 0; i < 3; i++) {
      await meta.flagImpasse({
        kind: 'tool-error', flaggedInPhase: `urn:${AGENT}:cog:cycle:c1_4`, context: `e${i}`,
        occurredAt: new Date(`2026-10-1${i}T10:00:00Z`), forUser: 'alice',
      });
    }
    const bob = await meta.crossCycleScan(WIDE, { forUser: 'bob' });
    expect(bob.chronicImpassesRaised).toBe(0);
    const alice = await meta.crossCycleScan(WIDE, { forUser: 'alice' });
    expect(alice).toMatchObject({ chronicImpassesRaised: 1, longtermGoalsCreated: 1 });
    // Again: the goal is not duplicated, and bob's own count stays zero.
    await meta.crossCycleScan(WIDE, { forUser: 'alice' });
    const goals = await store.query(`SELECT ?g ?u WHERE { GRAPH <${GraphUriResolver.getCogGoalsLongtermGraph(AGENT)}> {
      ?g a <${COGT}Goal> ; <${COGT}forUser> ?u } }`);
    expect((goals.bindings ?? []).map((b) => b.u.value)).toEqual(['alice']);
    const chronic = await store.query(`SELECT ?c ?u WHERE { GRAPH <${META}> { ?c a <${COGT}ChronicImpasse> ; <${COGT}forUser> ?u } }`);
    expect((chronic.bindings ?? []).map((b) => b.u.value)).toEqual(['alice']);
    expect((await meta.crossCycleScan(WIDE, { forUser: 'bob' })).chronicImpassesRaised).toBe(0);
  });

  it('runs the worldview reflection (the former ReflectionRunner body) for the owner scope only', async () => {
    const detector = { detectConflicts: async () => [], storeConflicts: async () => {} };
    await store.update(`INSERT DATA { GRAPH <${GraphUriResolver.getWorldviewGraph(AGENT)}> { <urn:t:w1> <urn:t:p> "1" . <urn:t:w2> <urn:t:p> "2" . } }`);
    const owner = await meta.crossCycleScan(WIDE, { reflection: { conflictDetector: detector } });
    expect(owner.reflection).toEqual({ worldviewTriplesCount: 2, conflictsFound: 0 });
    const alice = await meta.crossCycleScan(WIDE, { forUser: 'alice', reflection: { conflictDetector: detector } });
    expect(alice.reflection).toBeUndefined();
    expect((await meta.crossCycleScan(WIDE)).reflection).toBeUndefined();
  });
});
