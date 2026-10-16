import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { GraphRegistry } from '../utils/GraphRegistry.js';
import { EpisodicMemory } from '../cognitive/EpisodicMemory.js';
import { EpisodicConsolidation, consolidationClaimHash } from '../cognitive/EpisodicConsolidation.js';

// Episodic to semantic consolidation (pattern 1): a fact a user asserted in
// several independent episodes is promoted into THAT user's own graph and
// nowhere else. Real in-process Oxigraph store; claims are seeded directly
// because the ingestion path stores a repeated assertion only once.

const AGENT = 'ontofelia';
const CORE = 'urn:shared:ontology#';
const WORLDVIEW = `urn:${AGENT}:worldview`;
const CLAIMS = `urn:${AGENT}:claims`;
const userGraph = (k: string) => `urn:${AGENT}:user:${k}`;
const S = 'urn:entity:Anna';
const P = 'urn:core#likes';
const O = 'urn:entity:Tea';
const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T10:00:00.000Z');

describe('EpisodicConsolidation', () => {
  let dir: string;
  let store: TriplestoreAdapter;
  let engine: KnowledgeEngine;
  let em: EpisodicMemory;
  let job: EpisodicConsolidation;
  let n = 0;

  beforeEach(async () => {
    dir = `/tmp/ep-consol-test-${Math.random().toString(16).slice(2)}`;
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
    engine = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    em = new EpisodicMemory(store, AGENT);
    job = new EpisodicConsolidation(store, AGENT, engine);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  /** An accepted claim (and, optionally, its base triple) as the ingestion would store it. */
  async function seedClaim(o: {
    s?: string; p?: string; obj?: string; literal?: boolean; graph?: string;
    status?: string; sourceKind?: string; baseTriple?: boolean;
  } = {}): Promise<string> {
    const uri = `urn:claim:test_${++n}`;
    const s = o.s ?? S;
    const p = o.p ?? P;
    const obj = o.literal ? `"${o.obj ?? 'x'}"` : `<${o.obj ?? O}>`;
    const graph = o.graph ?? WORLDVIEW;
    const status = o.status ?? 'accepted';
    const link = status === 'accepted' ? 'assertedInGraph' : 'targetGraph';
    await store.update(`INSERT DATA { GRAPH <${CLAIMS}> {
      <${uri}> a <${CORE}Claim> ; <${CORE}claimSubject> <${s}> ; <${CORE}claimPredicate> <${p}> ;
        <${CORE}claimObject> ${obj} ; <${CORE}status> "${status}" ; <${CORE}${link}> <${graph}> ;
        <${CORE}sourceKind> "${o.sourceKind ?? 'user'}" .
    } }`);
    if (o.baseTriple) await store.update(`INSERT DATA { GRAPH <${graph}> { <${s}> <${p}> ${obj} . } }`);
    return uri;
  }

  /** An episode of `user` in `session` on day offset `day` that stored `claims`. */
  function episode(user: string, session: string, day: number, claims: string[], extra: Record<string, unknown> = {}) {
    return em.append({
      episodeType: 'message-received',
      forUser: user,
      sessionId: session,
      occurredAt: new Date(T0 + day * DAY),
      hasClaim: claims,
      // The graph the ingestion wrote this user's own facts to.
      factGraph: userGraph(user),
      ...extra,
    });
  }

  /** Three sessions, three distinct claims of the same triple, for one user. */
  async function threeSessions(user: string, o: Parameters<typeof seedClaim>[0] = {}) {
    for (let i = 0; i < 3; i++) await episode(user, `s${user}${i}`, 0, [await seedClaim(o)]);
  }

  async function graphsHolding(s: string, p: string, obj: string, literal = false): Promise<string[]> {
    const res = await store.query(`SELECT DISTINCT ?g WHERE { GRAPH ?g { <${s}> <${p}> ${literal ? `"${obj}"` : `<${obj}>`} } }`);
    return (res.bindings ?? []).map((b) => b.g.value).sort();
  }

  async function quadCount(): Promise<number> {
    const res = await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }');
    return (res.bindings ?? []).length;
  }

  async function claimsOf(sourceKind: string): Promise<string[]> {
    const res = await store.query(`SELECT ?c WHERE { GRAPH <${CLAIMS}> { ?c <${CORE}sourceKind> "${sourceKind}" ; <${CORE}status> "accepted" } }`);
    return (res.bindings ?? []).map((b) => b.c.value);
  }

  it('promotes a triple asserted in three independent sessions exactly once', async () => {
    await threeSessions('anna');
    const r = await job.run();
    expect(r.qualified).toBe(1);
    expect(r.promoted).toBe(1);
    expect(await graphsHolding(S, P, O)).toEqual([userGraph('anna')]);

    const promoted = await claimsOf('consolidation-episodic');
    expect(promoted).toHaveLength(1);
    // The evidence links the source episodes and the claims they stored.
    const ev = await store.query(`SELECT ?e ?c WHERE { GRAPH <${CLAIMS}> { <${promoted[0]}> <${CORE}hasEvidence> ?ev } GRAPH <urn:${AGENT}:evidence> { ?ev <${CORE}sourceEpisode> ?e ; <${CORE}supportClaim> ?c } }`);
    expect(new Set((ev.bindings ?? []).map((b) => b.e.value)).size).toBe(3);
    expect(new Set((ev.bindings ?? []).map((b) => b.c.value)).size).toBe(3);
    // A consolidation-promoted episode for the user carries the claim hash.
    const hits = await em.recent('anna', 50);
    const led = hits.filter((h) => h.episodeType === 'consolidation-promoted');
    expect(led).toHaveLength(1);
    expect(led[0].forUser).toBe('anna');
    expect(led[0].tags).toContain(`claim-hash:${consolidationClaimHash('anna', S, P, { kind: 'iri', value: O })}`);
  });

  it('a rerun is a no-op: identical quad count, nothing promoted', async () => {
    await threeSessions('anna');
    await job.run();
    const before = await quadCount();
    const again = await job.run();
    expect(again.promoted).toBe(0);
    expect(again.alreadyPromoted).toBe(1);
    expect(await quadCount()).toBe(before);
  });

  it('the same triple from only one session on one day does not promote', async () => {
    for (let i = 0; i < 3; i++) await episode('anna', 'only', 0, [await seedClaim()]);
    const r = await job.run();
    expect(r.triplesSeen).toBe(1);
    expect(r.qualified).toBe(0);
    expect(await graphsHolding(S, P, O)).toEqual([]);
  });

  it('a single occurrence and two episodes do not promote', async () => {
    await episode('anna', 'a', 0, [await seedClaim()]);
    await episode('anna', 'b', 1, [await seedClaim()]);
    expect((await job.run()).promoted).toBe(0);
  });

  it('one session over three days counts as independent groups', async () => {
    for (let d = 0; d < 3; d++) await episode('anna', 'long', d, [await seedClaim()]);
    expect((await job.run()).promoted).toBe(1);
  });

  it('thresholds are honoured', async () => {
    await threeSessions('anna');
    expect((await job.run({ minEpisodes: 4, minGroups: 2 })).promoted).toBe(0);
    expect((await job.run({ minEpisodes: 3, minGroups: 4 })).promoted).toBe(0);
    expect((await job.run({ minEpisodes: 3, minGroups: 3 })).promoted).toBe(1);
  });

  it('cross-user probe: user A three times lands in A only, in no other graph', async () => {
    await threeSessions('anna');
    await episode('bob', 'b1', 0, [await seedClaim({ obj: 'urn:entity:Coffee' })]);
    await job.run();
    expect(await graphsHolding(S, P, O)).toEqual([userGraph('anna')]);
    const all = await store.query('SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o } }');
    for (const b of all.bindings ?? []) {
      const g = b.g.value;
      if (g === userGraph('anna')) continue;
      expect(await graphsHolding(S, P, O)).not.toContain(g);
    }
    expect(await graphsHolding(S, P, O)).not.toContain(WORLDVIEW);
    expect(await graphsHolding(S, P, O)).not.toContain(userGraph('bob'));
    expect(await graphsHolding(S, P, O)).not.toContain(userGraph('owner'));
  });

  it('A twice plus B once promotes for neither', async () => {
    await episode('anna', 'a1', 0, [await seedClaim()]);
    await episode('anna', 'a2', 1, [await seedClaim()]);
    await episode('bob', 'b1', 2, [await seedClaim()]);
    const r = await job.run();
    expect(r.promoted).toBe(0);
    expect(await graphsHolding(S, P, O)).toEqual([]);
  });

  it('evidence of different users never mixes: 3 users with 2 each promote nothing', async () => {
    for (const u of ['anna', 'bob', 'carl']) {
      await episode(u, `${u}1`, 0, [await seedClaim()]);
      await episode(u, `${u}2`, 1, [await seedClaim()]);
    }
    expect((await job.run()).promoted).toBe(0);
  });

  it('the owner promotes into the owner user graph, never the worldview', async () => {
    await threeSessions('owner');
    await job.run();
    expect(await graphsHolding(S, P, O)).toEqual([userGraph('owner')]);
  });

  it('a legacy episode without forUser counts for the owner only', async () => {
    for (let i = 0; i < 3; i++) {
      await em.append({ episodeType: 'message-received', sessionId: `leg${i}`, occurredAt: new Date(T0), hasClaim: [await seedClaim()], factGraph: userGraph('owner') });
    }
    await job.run();
    expect(await graphsHolding(S, P, O)).toEqual([userGraph('owner')]);
  });

  it('episodes without a recorded fact graph are never promoted from (no guessing)', async () => {
    for (let i = 0; i < 3; i++) {
      await em.append({ episodeType: 'message-received', forUser: 'anna', sessionId: `nf${i}`, occurredAt: new Date(T0), hasClaim: [await seedClaim()] });
    }
    const r = await job.run();
    expect(r.promoted).toBe(0);
    expect(r.excluded.noFactGraphEpisodes).toBe(3);
    expect(await graphsHolding(S, P, O)).toEqual([]);
  });

  it('promotes into the recorded fact graph, not into the cognitive key\'s graph', async () => {
    for (let i = 0; i < 3; i++) await episode('owner', `fg${i}`, 0, [await seedClaim()], { factGraph: userGraph('u-7') });
    expect((await job.run()).promoted).toBe(1);
    expect(await graphsHolding(S, P, O)).toEqual([userGraph('u-7')]);
  });

  it('a fact graph that is not one of this agent\'s user graphs is refused', async () => {
    for (let i = 0; i < 3; i++) await episode('anna', `bg${i}`, 0, [await seedClaim()], { factGraph: `urn:other:user:anna` });
    const r = await job.run();
    expect(r.promoted).toBe(0);
    expect(r.excluded.noFactGraphEpisodes).toBe(3);
  });

  it('many messages of one session on one day are one group, however many transcript lines', async () => {
    for (let i = 0; i < 4; i++) await episode('anna', 'one', 0, [await seedClaim()], { transcriptRef: `one.jsonl:line_${i * 2}` });
    const r = await job.run();
    expect(r.qualified).toBe(0);
    expect(await graphsHolding(S, P, O)).toEqual([]);
  });

  it('a retracted claim does not count and a retracted promotion is not resurrected', async () => {
    const gone = await seedClaim();
    await episode('anna', 'a1', 0, [gone]);
    await episode('anna', 'a2', 1, [await seedClaim()]);
    await episode('anna', 'a3', 2, [await seedClaim()]);
    // Hard retraction: the claim object disappears.
    await store.update(`DELETE WHERE { GRAPH <${CLAIMS}> { <${gone}> ?p ?o } }`);
    expect((await job.run()).promoted).toBe(0);

    // A third claim again, promoted, then retracted from the user graph.
    await episode('anna', 'a4', 3, [await seedClaim()]);
    expect((await job.run()).promoted).toBe(1);
    const [pc] = await claimsOf('consolidation-episodic');
    await store.update(`DELETE WHERE { GRAPH <${userGraph('anna')}> { <${S}> <${P}> <${O}> } }`);
    await store.update(`DELETE WHERE { GRAPH <${CLAIMS}> { <${pc}> ?p ?o } }`);
    const r = await job.run();
    expect(r.promoted).toBe(0);
    expect(r.alreadyPromoted).toBe(1);
    expect(await graphsHolding(S, P, O)).toEqual([]);
  });

  it('superseded and rejected claims are excluded', async () => {
    await episode('anna', 'a1', 0, [await seedClaim({ status: 'superseded' })]);
    await episode('anna', 'a2', 1, [await seedClaim({ status: 'rejected' })]);
    await episode('anna', 'a3', 2, [await seedClaim()]);
    const r = await job.run();
    expect(r.qualified).toBe(0);
    expect(r.excluded.claims).toBe(2);
  });

  it('a claim asserted in another user graph is excluded', async () => {
    await episode('anna', 'a1', 0, [await seedClaim({ graph: userGraph('bob') })]);
    await episode('anna', 'a2', 1, [await seedClaim({ graph: userGraph('bob') })]);
    await episode('anna', 'a3', 2, [await seedClaim({ graph: userGraph('bob') })]);
    expect((await job.run()).promoted).toBe(0);
    expect(await graphsHolding(S, P, O)).toEqual([]);
  });

  it('an episode of an untrusted session is excluded, and the session mark spreads to its episodes', async () => {
    await episode('anna', 'a1', 0, [await seedClaim()]);
    await episode('anna', 'a2', 1, [await seedClaim()]);
    await episode('anna', 'dry', 2, [await seedClaim()], { sessionUntrusted: true });
    await episode('anna', 'dry', 3, [await seedClaim()]);
    const r = await job.run();
    expect(r.excluded.untrustedEpisodes).toBe(2);
    expect(r.promoted).toBe(0);
    expect(await graphsHolding(S, P, O)).toEqual([]);
  });

  it('a secret-classed episode is excluded', async () => {
    await episode('anna', 'a1', 0, [await seedClaim()]);
    await episode('anna', 'a2', 1, [await seedClaim()]);
    await episode('anna', 'a3', 2, [await seedClaim()], { privacyClass: 'secret' });
    const r = await job.run();
    expect(r.excluded.secretEpisodes).toBe(1);
    expect(r.promoted).toBe(0);
  });

  it('a secret-classed claim is excluded', async () => {
    const secret = await seedClaim();
    await store.update(`INSERT DATA { GRAPH <${CLAIMS}> { <${secret}> <${CORE}privacyClass> "secret" } }`);
    await episode('anna', 'a1', 0, [secret]);
    await episode('anna', 'a2', 1, [await seedClaim()]);
    await episode('anna', 'a3', 2, [await seedClaim()]);
    expect((await job.run()).promoted).toBe(0);
  });

  it('does not duplicate a triple the user graph already holds', async () => {
    await store.update(`INSERT DATA { GRAPH <${userGraph('anna')}> { <${S}> <${P}> <${O}> } }`);
    await threeSessions('anna');
    const before = await quadCount();
    const r = await job.run();
    expect(r.alreadyPresent).toBe(1);
    expect(r.promoted).toBe(0);
    expect(await quadCount()).toBe(before);
  });

  it('literal objects are promoted as plain literals', async () => {
    for (let i = 0; i < 3; i++) await episode('anna', `l${i}`, 0, [await seedClaim({ literal: true, obj: 'Koeln' })]);
    expect((await job.run()).promoted).toBe(1);
    expect(await graphsHolding(S, P, 'Koeln', true)).toEqual([userGraph('anna')]);
  });

  describe('functional properties', () => {
    async function declareFunctional(p: string) {
      await store.update(`INSERT DATA { GRAPH <urn:${AGENT}:schema> { <${p}> a <http://www.w3.org/2002/07/owl#FunctionalProperty> } }`);
    }

    it('a promoted claim is superseded by a later value, and is not re-promoted', async () => {
      const name = await engine.storeFact(
        { subject: 'user', predicate: 'name', object: 'Anna', objectType: 'literal', sourceKind: 'user' },
        { agentId: AGENT, userId: 'anna', sessionId: 'x', isOwner: false },
      );
      const prop = await engine.resolveProperty('livesIn', AGENT);
      await declareFunctional(prop.uri);
      const subj = name.subjectUri;
      for (let i = 0; i < 3; i++) {
        await episode('anna', `f${i}`, 0, [await seedClaim({ s: subj, p: prop.uri, literal: true, obj: 'Koeln' })]);
      }
      expect((await job.run()).promoted).toBe(1);
      expect(await graphsHolding(subj, prop.uri, 'Koeln', true)).toEqual([userGraph('anna')]);

      const later = await engine.storeFact(
        { subject: 'user', predicate: 'livesIn', object: 'Berlin', objectType: 'literal', sourceKind: 'user' },
        { agentId: AGENT, userId: 'anna', sessionId: 'x', isOwner: false },
      );
      expect(later.tripleCount).toBe(1);
      expect(await graphsHolding(subj, prop.uri, 'Koeln', true)).toEqual([]);
      expect(await graphsHolding(subj, prop.uri, 'Berlin', true)).toEqual([userGraph('anna')]);
      const sup = await store.query(`SELECT ?c WHERE { GRAPH <${CLAIMS}> { ?c <${CORE}status> "superseded" ; <${CORE}sourceKind> "consolidation-episodic" } }`);
      expect(sup.bindings ?? []).toHaveLength(1);

      // The older value does not come back over the newer one.
      const r = await job.run();
      expect(r.promoted).toBe(0);
      expect(await graphsHolding(subj, prop.uri, 'Koeln', true)).toEqual([]);
    });

    it('does not override a different value the user graph holds now', async () => {
      const prop = await engine.resolveProperty('livesIn', AGENT);
      await declareFunctional(prop.uri);
      const now = await engine.storeFact(
        { subject: 'user', predicate: 'livesIn', object: 'Berlin', objectType: 'literal', sourceKind: 'user' },
        { agentId: AGENT, userId: 'anna', sessionId: 'x', isOwner: false },
      );
      for (let i = 0; i < 3; i++) {
        await episode('anna', `g${i}`, 0, [await seedClaim({ s: now.subjectUri, p: prop.uri, literal: true, obj: 'Koeln' })]);
      }
      const r = await job.run();
      expect(r.conflicts).toBe(1);
      expect(r.promoted).toBe(0);
      expect(await graphsHolding(now.subjectUri, prop.uri, 'Berlin', true)).toEqual([userGraph('anna')]);
    });
  });

  it('is bounded: promotions per user and run are capped', async () => {
    for (let t = 0; t < 25; t++) {
      for (let i = 0; i < 3; i++) await episode('anna', `b${t}_${i}`, 0, [await seedClaim({ obj: `urn:entity:T${t}` })]);
    }
    const r = await job.run();
    expect(r.promoted).toBe(20);
    expect(r.deferred).toBe(5);
    const again = await job.run();
    expect(again.promoted).toBe(5);
  });
});
