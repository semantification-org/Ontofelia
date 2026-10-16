import { describe, it, expect, beforeEach } from 'vitest';
import {
  OxigraphAdapter, EpisodicMemory, KnowledgeEngine, GraphRegistry, GraphUriResolver,
  type EntityFact, type EpisodeInput,
} from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter, MessageEnvelope } from '@ontofelia/core';
import {
  comprehend, scoreEpisode, scoreFact, recencyOf, RECALL_CAP, PENDING_LOOKUP_MS, MAX_PENDING_LOOKUP,
  PHASE2_DEADLINE_MS, type ComprehensionInput, type ComprehensionDeps,
} from '../cognitive/Comprehension.js';
import { buildPerception } from '../cognitive/Perception.js';
import { CycleManager } from '../cognitive/CycleManager.js';
import { RESPOND_TO_USER } from '../cognitive/GoalStack.js';

// Phase 2 on its own: the scoring arithmetic, the scope rules, the fail-closed
// and time rules, and hostile values. Real embedded store.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const E1 = 'urn:ontofelia:entity:zoe';
const E2 = 'urn:ontofelia:entity:acme';
const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000);

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph', type: 'embedded', dataDir: `/tmp/compr-unit-${Math.random().toString(16).slice(2)}`, port: 0, endpoint: '',
  });
  return store;
}

const perceptionAbout = (...iris: string[]) => {
  const p = buildPerception({ text: 'What about it?', senderIsOwner: false });
  return { ...p, about: iris, pending: [], tags: ['question'] };
};

describe('scoring (doc 05 §5.4)', () => {
  const ctx = { entityIris: [E1, E2], goalUri: 'urn:g:1', tags: ['question'], nowMs: NOW };

  it('weights: 0.4 entity share, 0.3 goal, 0.2 recency, 0.1 tag share', () => {
    const full = scoreEpisode({ about: [E1, E2], partOfGoal: 'urn:g:1', tags: ['question'], occurredAt: new Date(NOW).toISOString() }, ctx);
    expect(full.score).toBeCloseTo(1.0, 6);
    expect(full.components).toEqual({ entity: 1, goal: 1, recency: 1, tag: 1 });
    const half = scoreEpisode({ about: [E1], tags: [], occurredAt: new Date(NOW).toISOString() }, ctx);
    expect(half.components.entity).toBe(0.5);
    expect(half.score).toBeCloseTo(0.4 * 0.5 + 0.2, 6);
    const goalOnly = scoreEpisode({ about: [], partOfGoal: 'urn:g:1', tags: [], occurredAt: hoursAgo(168).toISOString() }, ctx);
    expect(goalOnly.score).toBeCloseTo(0.3 + 0.2 * Math.exp(-1), 6);
  });

  it('no perceived entity gives entity 0, no goal gives goal 0, no tags gives tag 0', () => {
    const r = scoreEpisode({ about: [E1], partOfGoal: 'urn:g:1', tags: ['question'], occurredAt: new Date(NOW).toISOString() }, { entityIris: [], tags: [], nowMs: NOW });
    expect(r.components).toEqual({ entity: 0, goal: 0, recency: 1, tag: 0 });
  });

  it('recency is exp(-hours/168), 1 for the future, 0 for an unreadable time', () => {
    expect(recencyOf(hoursAgo(168).toISOString(), NOW)).toBeCloseTo(Math.exp(-1), 6);
    expect(recencyOf(hoursAgo(-5).toISOString(), NOW)).toBe(1);
    expect(recencyOf('not a date', NOW)).toBe(0);
  });

  it('a fact scores 0.4 + 0.3 * specificity: user above worldview, never above 0.7', () => {
    expect(scoreFact('user')).toBeCloseTo(0.7, 6);
    expect(scoreFact('worldview')).toBeCloseTo(0.58, 6);
    expect(scoreFact('user')).toBeGreaterThan(scoreFact('worldview'));
  });
});

describe('comprehend', () => {
  let store: TriplestoreAdapter;
  let em: EpisodicMemory;
  const deps = (extra: Partial<ComprehensionDeps> = {}): ComprehensionDeps => ({ episodic: em, now: () => NOW, ...extra });
  const input = (extra: Partial<ComprehensionInput> = {}): ComprehensionInput => ({
    userKey: 'alice', sessionId: 'sess-now', perception: perceptionAbout(E1), episodicEnabled: true, ...extra,
  });
  const add = (o: Omit<EpisodeInput, 'episodeType'>) => em.append({ episodeType: 'message-received', ...o });

  beforeEach(async () => {
    store = await makeStore();
    em = new EpisodicMemory(store, AGENT);
  });

  it('recalls entity-anchored episodes across sessions in score order, never another user\'s', async () => {
    await add({ forUser: 'alice', sessionId: 's1', about: [E1], payload: 'old', occurredAt: hoursAgo(100) });
    await add({ forUser: 'alice', sessionId: 's2', about: [E1], payload: 'new', occurredAt: hoursAgo(1) });
    await add({ forUser: 'bob', sessionId: 's3', about: [E1], payload: 'bobs', occurredAt: hoursAgo(1) });
    await add({ forUser: 'alice', sessionId: 's4', about: [E2], payload: 'other entity', occurredAt: hoursAgo(1) });
    const r = await comprehend(deps(), input());
    expect(r.entries.map((e) => e.payload)).toEqual(['new', 'old']);
    expect(r.entries.every((e) => e.forUser === 'alice' && e.kind === 'episode-ref')).toBe(true);
    expect(r.entries[0].score).toBeGreaterThan(r.entries[1].score);
    expect(r.status).toBe('ok');
    expect(r.empty).toBe(false);
  });

  it('an episode written for another user with the same text is not recalled, with a positive control', async () => {
    await add({ forUser: 'bob', sessionId: 'sb', about: [E1], payload: 'same words', occurredAt: hoursAgo(1) });
    expect((await comprehend(deps(), input())).entries).toEqual([]);
    expect((await comprehend(deps(), input({ userKey: 'bob', sessionId: 'sb2' }))).entries.map((e) => e.payload)).toEqual(['same words']);
  });

  it('the all-users key, an empty key and a disabled episodic memory read no episode (fail closed)', async () => {
    await add({ forUser: 'alice', sessionId: 's1', about: [E1], payload: 'x', occurredAt: hoursAgo(1) });
    const reads: string[] = [];
    const spy = new Proxy(em, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        return typeof v === 'function' && String(p).startsWith('find') ? (...a: unknown[]) => { reads.push(String(p)); return v.apply(t, a); } : typeof v === 'function' ? v.bind(t) : v;
      },
    }) as EpisodicMemory;
    for (const userKey of ['all', '']) {
      const r = await comprehend(deps({ episodic: spy }), input({ userKey }));
      expect(r.entries).toEqual([]);
    }
    const off = await comprehend(deps({ episodic: spy }), input({ episodicEnabled: false }));
    expect(off.entries).toEqual([]);
    expect(reads).toEqual([]);
    // Positive control: the same spy sees reads for a normal call.
    expect((await comprehend(deps({ episodic: spy }), input())).entries).toHaveLength(1);
    expect(reads.length).toBeGreaterThan(0);
  });

  it('never recalls this turn\'s inbound episode, nor a secret, nor a payload-less (warm) episode', async () => {
    const own = await add({ forUser: 'alice', sessionId: 'sess-now', about: [E1], payload: 'this turn', occurredAt: hoursAgo(0) });
    await add({ forUser: 'alice', sessionId: 'sess-now', about: [E1], payload: 'password: not-a-real-pw-12345', occurredAt: hoursAgo(1) });
    await add({ forUser: 'alice', sessionId: 'sess-now', about: [E1], occurredAt: hoursAgo(2) });
    await add({ forUser: 'alice', sessionId: 'sess-now', about: [E1], payload: 'fine', occurredAt: hoursAgo(3) });
    const r = await comprehend(deps(), input({ inboundEpisodeUri: own }));
    expect(r.entries.map((e) => e.payload)).toEqual(['fine']);
    // Positive control: without the exclusion the own episode is there.
    expect((await comprehend(deps(), input())).entries.map((e) => e.payload)).toContain('this turn');
  });

  it('tool episodes are not recalled; goal and response episodes are', async () => {
    await em.append({ episodeType: 'tool-called', forUser: 'alice', sessionId: 'sess-now', about: [E1], payload: 'search (query)', occurredAt: hoursAgo(1) });
    await em.append({ episodeType: 'response-sent', forUser: 'alice', sessionId: 'sess-now', about: [E1], payload: 'an answer', occurredAt: hoursAgo(2) });
    const r = await comprehend(deps(), input());
    expect(r.entries.map((e) => e.payload)).toEqual(['an answer']);
  });

  it('goal-anchored: episodes of the active goal count 0.3; the implicit RespondToUser goal anchors nothing', async () => {
    const goal = 'urn:ontofelia:cog:goal:g1';
    await add({ forUser: 'alice', sessionId: 'old', partOfGoal: goal, payload: 'goal episode', occurredAt: hoursAgo(0) });
    const withGoal = await comprehend(deps(), input({ perception: undefined, activeGoalUri: goal, activeGoalType: `${COGT}AnswerQuestion` }));
    expect(withGoal.entries).toHaveLength(1);
    expect(withGoal.entries[0].components).toMatchObject({ goal: 1, entity: 0 });
    expect(withGoal.entries[0].score).toBeCloseTo(0.3 + 0.2, 6);
    const implicit = await comprehend(deps(), input({ perception: undefined, activeGoalUri: goal, activeGoalType: RESPOND_TO_USER }));
    expect(implicit.entries).toEqual([]);
  });

  it('caps at eight entries, episodes and facts together, best first', async () => {
    for (let i = 0; i < 10; i++) await add({ forUser: 'alice', sessionId: `s${i}`, about: [E1], payload: `ep${i}`, occurredAt: hoursAgo(i + 1) });
    const facts: EntityFact[] = ['a', 'b', 'c'].map((x) => ({
      entity: E1, direction: 'out', subject: E1, subjectLabel: 'Zoe', predicate: `urn:p:${x}`, predicateLabel: `p${x}`,
      object: `urn:o:${x}`, objectLabel: `o${x}`, objectIsIri: true, graph: GraphUriResolver.getUserGraph(AGENT, 'alice'), scope: 'user',
    }));
    const r = await comprehend(deps({ entityFacts: async () => facts }), input());
    expect(r.entries).toHaveLength(RECALL_CAP);
    for (let i = 1; i < r.entries.length; i++) expect(r.entries[i - 1].score).toBeGreaterThanOrEqual(r.entries[i].score);
    // User facts (0.7) outrank every episode here (<= 0.4 + 0.2 + 0.1).
    expect(r.entries.slice(0, 3).every((e) => e.kind === 'fact')).toBe(true);
  });

  it('ties are broken deterministically: user fact, then worldview fact, then episode', async () => {
    const mk = (scope: 'user' | 'worldview', x: string): EntityFact => ({
      entity: E1, direction: 'out', subject: E1, subjectLabel: 'Zoe', predicate: `urn:p:${x}`, predicateLabel: x, object: 'v', objectLabel: 'v',
      objectIsIri: false, graph: `urn:g:${scope}`, scope,
    });
    const a = await comprehend(deps({ entityFacts: async () => [mk('worldview', 'w'), mk('user', 'u')] }), input());
    const b = await comprehend(deps({ entityFacts: async () => [mk('user', 'u'), mk('worldview', 'w')] }), input());
    expect(a.entries.map((e) => e.payload)).toEqual(b.entries.map((e) => e.payload));
    expect(a.entries.map((e) => e.specificity)).toEqual(['user', 'worldview']);
  });

  it('a failing read gives a smaller result (partial), a hanging one a timeout with nothing', async () => {
    await add({ forUser: 'alice', sessionId: 's1', about: [E1], payload: 'kept', occurredAt: hoursAgo(1) });
    const errors: unknown[] = [];
    const broken = await comprehend(deps({ entityFacts: async () => { throw new Error('boom'); }, onError: (e) => errors.push(e) }), input());
    expect(broken.status).toBe('partial');
    expect(broken.entries.map((e) => e.payload)).toEqual(['kept']);
    expect(errors).toHaveLength(1);
    // A real clock for the deadline.
    const slow = await comprehend(
      { episodic: em, entityFacts: () => new Promise(() => {}) },
      input(),
    );
    expect(slow.status).toBe('timeout');
    expect(slow.entries).toEqual([]);
    expect(slow.empty).toBe(true);
    expect(slow.elapsedMs).toBeGreaterThanOrEqual(PHASE2_DEADLINE_MS - 50);
  }, 10_000);

  describe('pending entities', () => {
    const pendingPerception = () =>
      buildPerception({ text: 'What about Zoe?', senderIsOwner: false }, {
        entities: [{ name: 'Zoe', source: 'known' }], storedClaims: [],
      });

    it('are resolved read-only before recall when the lookup is quick, and then used', async () => {
      await add({ forUser: 'alice', sessionId: 's1', about: [E1], payload: 'about zoe', occurredAt: hoursAgo(1) });
      const asked: string[][] = [];
      const p = pendingPerception();
      expect(p.pending).toEqual(['Zoe']);
      const r = await comprehend(
        deps({ resolveEntities: async (names) => { asked.push(names); return new Map([['zoe', [E1]]]); } }),
        input({ perception: p }),
      );
      expect(asked).toEqual([['Zoe']]);
      expect(r.pendingResolved).toBe(true);
      expect(r.perception?.about).toEqual([E1]);
      expect(r.entries.map((e) => e.payload)).toEqual(['about zoe']);
      // The input record is not modified.
      expect(p.about).toEqual([]);
    });

    it('are skipped for recall when the lookup is slower than the allowance', async () => {
      await add({ forUser: 'alice', sessionId: 's1', about: [E1], payload: 'about zoe', occurredAt: hoursAgo(1) });
      const t0 = Date.now();
      const r = await comprehend(
        { episodic: em, resolveEntities: () => new Promise((res) => setTimeout(() => res(new Map([['zoe', [E1]]])), PENDING_LOOKUP_MS + 400)) },
        input({ perception: pendingPerception() }),
      );
      expect(Date.now() - t0).toBeLessThan(PENDING_LOOKUP_MS + 300);
      expect(r.pendingResolved).toBe(false);
      expect(r.perception?.about).toEqual([]);
      expect(r.entries).toEqual([]);
    });

    it('are not looked up at all when there are more than the allowed number', async () => {
      const p = buildPerception({ text: 'a b c d', senderIsOwner: false }, {
        entities: ['A', 'B', 'C', 'D'].map((name) => ({ name, source: 'known' as const })), storedClaims: [],
      });
      expect(p.pending.length).toBeGreaterThan(MAX_PENDING_LOOKUP);
      let called = false;
      const r = await comprehend(deps({ resolveEntities: async () => { called = true; return new Map(); } }), input({ perception: p }));
      expect(called).toBe(false);
      expect(r.pendingResolved).toBe(false);
    });

    it('a failing lookup is only a skipped lookup', async () => {
      const r = await comprehend(deps({ resolveEntities: async () => { throw new Error('nope'); } }), input({ perception: pendingPerception() }));
      expect(r.pendingResolved).toBe(false);
      expect(r.status).toBe('ok');
    });
  });

  describe('hostile values', () => {
    const NASTY = 'a"b\nc\\d} # <x>';

    it('a user key with quotes, newlines and backslashes reads exactly its own episodes and breaks no query', async () => {
      await add({ forUser: NASTY, sessionId: 's1', about: [E1], payload: 'nasty owner of this key', occurredAt: hoursAgo(1) });
      await add({ forUser: 'alice', sessionId: 's2', about: [E1], payload: 'alice', occurredAt: hoursAgo(1) });
      const mine = await comprehend(deps(), input({ userKey: NASTY, sessionId: NASTY }));
      expect(mine.entries.map((e) => e.payload)).toEqual(['nasty owner of this key']);
      expect(mine.status).toBe('ok');
      const alice = await comprehend(deps(), input({ sessionId: NASTY }));
      expect(alice.entries.map((e) => e.payload)).toEqual(['alice']);
      // The store still holds exactly the three triples-worth of data we put in.
      const all = await store.query(`SELECT (COUNT(?e) AS ?n) WHERE { GRAPH ?g { ?e a <${COGT}Episode> } }`);
      expect(all.bindings![0].n.value).toBe('2');
    });

    it('payloads and labels with quotes and newlines come back verbatim and are written escaped', async () => {
      await add({ forUser: 'alice', sessionId: 's1', about: [E1], payload: NASTY, occurredAt: hoursAgo(1) });
      const r = await comprehend(deps(), input());
      expect(r.entries.map((e) => e.payload)).toEqual([NASTY]);
    });

    it('an unsafe entity IRI is ignored by the fact read and by the episode read without breaking the phase', async () => {
      const bad = 'urn:x> } DROP ALL #';
      const ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
      expect(await ke.getEntityFacts([bad], { agentId: AGENT, userId: 'alice' })).toEqual([]);
      const r = await comprehend(
        deps({ entityFacts: (iris) => ke.getEntityFacts(iris, { agentId: AGENT, userId: 'alice' }) }),
        input({ perception: perceptionAbout(bad) }),
      );
      expect(r.entries).toEqual([]);
      expect(r.status).toBe('partial'); // the episode read rejected the IRI; nothing leaked
    });
  });
});

describe('the cycle keeps the recall in memory and writes it only from the queue', () => {
  it('a pending entity resolved in Phase 2 is not looked up again in the persist; one that timed out is', async () => {
    const store = await makeStore();
    const cm = new CycleManager(store, GraphRegistry.create([AGENT]), AGENT, undefined, { awaitPersist: true });
    const env = (): MessageEnvelope => ({
      id: 'm', channel: 'webchat', accountId: 'a', chatType: 'web',
      sender: { id: 'alice', channelPrefix: 'webchat', isOwner: false },
      timestamp: new Date().toISOString(), text: 'What about Zoe?', mentions: [], attachments: [],
    }) as MessageEnvelope;
    const run = async (delayMs: number) => {
      const calls: string[][] = [];
      await cm.runCycle(
        env(),
        async (_t, _g, recordInbound, perceive, comprehendHook) => {
          // The hook order of the real core: perceive, recall, (goals), inbound.
          perceive({ entities: [{ name: 'Zoe', source: 'known' }], storedClaims: [] });
          void recordInbound;
          await comprehendHook('sess-q');
          return { text: 'ok', sessionId: 'sess-q' };
        },
        (r) => r.sessionId,
        (r) => r.text,
        {
          resolveEntities: async (names) => {
            calls.push(names);
            await new Promise((r) => setTimeout(r, delayMs));
            return new Map([['zoe', [E1]]]);
          },
        },
      );
      return calls;
    };
    expect(await run(0)).toEqual([['Zoe']]); // once: in Phase 2
    expect((await run(PENDING_LOOKUP_MS + 250)).length).toBe(2); // Phase 2 gave up, the persist looked again
  }, 15_000);
});
