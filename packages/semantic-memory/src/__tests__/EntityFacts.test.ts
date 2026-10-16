import { describe, it, expect, beforeEach } from 'vitest';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { EpisodicMemory } from '../cognitive/EpisodicMemory.js';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';

// One-hop facts for cognitive recall (KnowledgeEngine.getEntityFacts) and the
// goal read of the episodic memory. Real embedded store.

const AGENT = 'ontofelia';
const E = 'urn:ontofelia:entity:';
const CORE = 'urn:ontofelia:core#';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const OWL = 'http://www.w3.org/2002/07/owl#';
const ZOE = `${E}zoe`;
const userG = (u: string) => GraphUriResolver.getUserGraph(AGENT, u);
const worldG = GraphUriResolver.getWorldviewGraph(AGENT);

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph', type: 'embedded', dataDir: `/tmp/entity-facts-${Math.random().toString(16).slice(2)}`, port: 0, endpoint: '',
  });
  return store;
}

describe('KnowledgeEngine.getEntityFacts', () => {
  let store: TriplestoreAdapter;
  let ke: KnowledgeEngine;
  const scope = (userId?: string) => ({ agentId: AGENT, userId });

  beforeEach(async () => {
    store = await makeStore();
    ke = new KnowledgeEngine(store);
    await store.update(`INSERT DATA {
      GRAPH <${worldG}> { <${ZOE}> <${LABEL}> "Zoe" ; <${CORE}knows> <${E}bob> . <${E}bob> <${LABEL}> "Bob" . }
      GRAPH <${userG('alice')}> { <${ZOE}> <${CORE}likes> <${E}tea> ; <${CORE}nickname> "Zo" . <${E}tea> <${LABEL}> "Tea" . <${E}ann> <${CORE}mentors> <${ZOE}> . <${E}ann> <${LABEL}> "Ann" . }
      GRAPH <${userG('bob')}> { <${ZOE}> <${CORE}fears> <${E}dogs> . <${E}dogs> <${LABEL}> "Dogs" . } }`);
  });

  it('returns the sender\'s own facts and the worldview\'s, user first, with their graph; never another user\'s', async () => {
    const facts = await ke.getEntityFacts([ZOE], scope('alice'));
    expect(facts.map((f) => `${f.scope}|${f.direction}|${f.subjectLabel} ${f.predicateLabel} ${f.objectLabel}`)).toEqual([
      'user|out|Zoe likes Tea',
      'user|in|Ann mentors Zoe',
      'user|out|Zoe nickname Zo',
      'worldview|out|Zoe knows Bob',
    ]);
    expect(facts.find((f) => f.scope === 'user')!.graph).toBe(userG('alice'));
    expect(facts.find((f) => f.scope === 'worldview')!.graph).toBe(worldG);
    expect(JSON.stringify(facts)).not.toContain('Dogs');
    // Positive control: bob's scope sees bob's fact, not alice's.
    const bobs = await ke.getEntityFacts([ZOE], scope('bob'));
    expect(JSON.stringify(bobs)).toContain('Dogs');
    expect(JSON.stringify(bobs)).not.toContain('Tea');
    // Without a user only the worldview is read.
    const anon = await ke.getEntityFacts([ZOE], scope(undefined));
    expect(anon.every((f) => f.scope === 'worldview')).toBe(true);
    expect(anon).toHaveLength(1);
  });

  it('limits facts per entity and entities per call, and skips unsafe IRIs', async () => {
    expect((await ke.getEntityFacts([ZOE], scope('alice'), { limitPerEntity: 2 }))).toHaveLength(2);
    expect(await ke.getEntityFacts(['urn:x> } #', ''], scope('alice'))).toEqual([]);
    const many = await ke.getEntityFacts([ZOE, `${E}a`, `${E}b`], scope('alice'), { maxEntities: 1 });
    expect(new Set(many.map((f) => f.entity))).toEqual(new Set([ZOE]));
  });

  it('flags a fact whose value was replaced by belief revision, with the previous value', async () => {
    await store.update(`INSERT DATA { GRAPH <urn:shared:ontology> { <${CORE}livesIn> a <${OWL}ObjectProperty>, <${OWL}FunctionalProperty> . } }`);
    const ctx = { agentId: AGENT, userId: 'alice', sessionId: 's', isOwner: false };
    for (const place of ['Hamburg', 'Berlin']) {
      await ke.storeFact({ subject: 'Mara', subjectType: 'Person', predicate: 'livesIn', object: place, objectType: 'Place', sourceKind: 'user' }, ctx);
    }
    const mara = `${E}Mara`;
    const facts = await ke.getEntityFacts([mara], scope('alice'));
    const lives = facts.filter((f) => f.predicate === `${CORE}livesIn`);
    expect(lives).toHaveLength(1);
    expect(lives[0].objectLabel).toBe('Berlin');
    expect(lives[0].superseded?.previousLabel).toBe('Hamburg');
    expect(lives[0].superseded?.supersededAt).toMatch(/^\d{4}-/);
    // A fact that was never revised carries no flag.
    expect(facts.filter((f) => f.predicate !== `${CORE}livesIn` && f.superseded)).toEqual([]);
  });

  it('a supersession asserted in another user\'s private graph is not visible', async () => {
    await store.update(`INSERT DATA { GRAPH <urn:shared:ontology> { <${CORE}livesIn> a <${OWL}ObjectProperty>, <${OWL}FunctionalProperty> . } }`);
    // A first-person fact of a non-owner stays in that user's own graph.
    const bob = { agentId: AGENT, userId: 'bob', sessionId: 's', isOwner: false };
    for (const place of ['Rome', 'Milan']) {
      await ke.storeFact({ subject: 'user', subjectType: 'Person', predicate: 'livesIn', object: place, objectType: 'Place', sourceKind: 'user' }, bob);
    }
    const bobNode = `${E}user:bob`;
    // Positive control: bob sees his fact and its revision.
    const own = await ke.getEntityFacts([bobNode], scope('bob'));
    expect(own.some((f) => f.scope === 'user' && f.objectLabel === 'Milan' && f.superseded?.previousLabel === 'Rome')).toBe(true);
    // Alice, asking about the same node, sees neither the fact nor its history.
    const alices = await ke.getEntityFacts([bobNode], scope('alice'));
    expect(alices).toEqual([]);
  });

  it('hostile labels come back verbatim; a hostile user id cannot alter the query', async () => {
    const nasty = 'a"b\nc\\d} # <x>';
    await store.update(`INSERT DATA { GRAPH <${userG('alice')}> {
      <${ZOE}> <${CORE}said> "${nasty.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}" . } }`);
    const facts = await ke.getEntityFacts([ZOE], scope('alice'));
    expect(facts.some((f) => f.objectLabel === nasty)).toBe(true);
    // An id that is not a safe graph name is rejected, not interpolated.
    await expect(ke.getEntityFacts([ZOE], scope('x> } DROP ALL #'))).rejects.toThrow();
    const n = await store.query(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }`);
    expect(Number(n.bindings![0].n.value)).toBeGreaterThan(0);
  });
});

describe('EpisodicMemory.findByGoal', () => {
  it('returns the episodes of a goal for the scope only, newest first', async () => {
    const store = await makeStore();
    const em = new EpisodicMemory(store, AGENT);
    const goal = `urn:${AGENT}:cog:goal:g1`;
    await em.append({ episodeType: 'message-received', forUser: 'alice', partOfGoal: goal, payload: 'old', occurredAt: new Date('2026-01-01T00:00:00Z'), sessionId: 's1' });
    await em.append({ episodeType: 'message-received', forUser: 'alice', partOfGoal: goal, payload: 'new', occurredAt: new Date('2026-02-01T00:00:00Z'), sessionId: 's2' });
    await em.append({ episodeType: 'message-received', forUser: 'bob', partOfGoal: goal, payload: 'bobs', sessionId: 's3' });
    await em.append({ episodeType: 'message-received', forUser: 'alice', payload: 'no goal', sessionId: 's4' });
    expect((await em.findByGoal(goal, 'alice')).map((h) => h.payload)).toEqual(['new', 'old']);
    expect((await em.findByGoal(goal, 'bob')).map((h) => h.payload)).toEqual(['bobs']);
    await expect(em.findByGoal(goal, '')).rejects.toThrow(/userScope/);
    await expect(em.findByGoal('urn:x> } #', 'alice')).rejects.toThrow();
  });
});

describe('EpisodicMemory limited reads (newest N inside the scope)', () => {
  const NASTY = 'a"b\nc\\d} # <x>';
  async function seeded() {
    const store = await makeStore();
    const em = new EpisodicMemory(store, AGENT);
    const ent = 'urn:entity:HOT';
    const goal = `urn:${AGENT}:cog:goal:g1`;
    const users: Array<string | undefined> = ['alice', 'bob', 'owner', undefined, NASTY];
    for (let i = 0; i < 40; i++) {
      const forUser = users[i % users.length];
      await em.append({
        episodeType: 'message-received', sessionId: `s${i}`, about: [ent], partOfGoal: goal,
        ...(forUser !== undefined ? { forUser } : {}), payload: `m${i}`,
        occurredAt: new Date(Date.UTC(2026, 0, 1, 0, i)),
      });
    }
    return { em, ent, goal };
  }

  it('equals the newest N of the unlimited read for every scope, legacy episodes counting as the owner\'s', async () => {
    const { em, ent, goal } = await seeded();
    for (const scope of ['alice', 'bob', 'owner', 'all', NASTY]) {
      const full = await em.findByEntity(ent, scope);
      const limited = await em.findByEntity(ent, scope, { limit: 3 });
      expect(limited.map((h) => h.uri)).toEqual(full.slice(0, 3).map((h) => h.uri));
      expect(limited).toHaveLength(3);
      const fullG = await em.findByGoal(goal, scope);
      expect((await em.findByGoal(goal, scope, { limit: 3 })).map((h) => h.uri)).toEqual(fullG.slice(0, 3).map((h) => h.uri));
    }
    // Owner scope: own key and legacy only.
    const owner = await em.findByEntity(ent, 'owner', { limit: 100 });
    expect(owner.every((h) => h.forUser === 'owner' || h.forUser === undefined)).toBe(true);
    expect(owner.some((h) => h.forUser === undefined)).toBe(true);
    // Another user's scope never contains legacy or foreign episodes.
    const alice = await em.findByEntity(ent, 'alice', { limit: 100 });
    expect(alice.every((h) => h.forUser === 'alice')).toBe(true);
    expect(alice).toHaveLength(8);
  });

  it('a key with quotes, newlines and backslashes reads exactly its own episodes; limit 0 reads nothing; "all" is not narrowed', async () => {
    const { em, ent } = await seeded();
    const nasty = await em.findByEntity(ent, NASTY, { limit: 100 });
    expect(nasty).toHaveLength(8);
    expect(nasty.every((h) => h.forUser === NASTY)).toBe(true);
    expect(await em.findByEntity(ent, 'alice', { limit: 0 })).toEqual([]);
    expect(await em.findByEntity(ent, 'all', { limit: 100 })).toHaveLength(40);
    await expect(em.findByEntity(ent, '', { limit: 3 })).rejects.toThrow(/userScope/);
  });
});
