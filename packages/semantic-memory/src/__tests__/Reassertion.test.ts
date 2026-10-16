import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rm } from 'node:fs/promises';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { GraphRegistry } from '../utils/GraphRegistry.js';
import { SemanticIngestionService } from '../ingestion/SemanticIngestionService.js';
import { EpisodicMemory } from '../cognitive/EpisodicMemory.js';
import { EpisodicConsolidation } from '../cognitive/EpisodicConsolidation.js';
import type { FactContext, FactInput } from '../types.js';
import type { SemanticParseResult } from '../ingestion/types.js';

// A user who states a triple that already exists: the existing accepted claim of
// the graph the routing rule picks for THIS sender is returned and gets an
// Evidence record; no second claim, no second triple. Real Oxigraph store.

const AGENT = 'ontofelia';
const CORE = 'urn:shared:ontology#';
const CLAIMS = `urn:${AGENT}:claims`;
const EVIDENCE = `urn:${AGENT}:evidence`;
const WORLDVIEW = `urn:${AGENT}:worldview`;
const userGraph = (k: string) => `urn:${AGENT}:user:${k}`;

const likes = (object = 'Tea', span = 'I like tea'): FactInput => ({
  subject: 'User', predicate: 'likes', object, objectType: 'literal', sourceSpan: span,
  confidenceLabel: 'high', status: 'accepted',
});
const world = (span = 'Anna works at Acme'): FactInput => ({
  subject: 'Anna', subjectType: 'Person', predicate: 'worksAt', object: 'Acme', objectType: 'Organization',
  sourceKind: 'user', sourceSpan: span, confidenceLabel: 'high', status: 'accepted',
});
const ctx = (userId: string, session: string, over: Partial<FactContext> = {}): FactContext => ({
  agentId: AGENT, userId, sessionId: session, isOwner: false, recordReassertion: true, ...over,
});

describe('re-assertion of an existing triple', () => {
  let dir: string;
  let store: TriplestoreAdapter;
  let engine: KnowledgeEngine;

  beforeEach(async () => {
    dir = `/tmp/reassert-test-${Math.random().toString(16).slice(2)}`;
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
    engine = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }).catch(() => {}); });

  const count = async (q: string) => Number(((await store.query(q)).bindings ?? [])[0]?.n.value ?? 0);
  const quads = () => count('SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }');
  const claimsOfObject = (o: string) =>
    count(`SELECT (COUNT(?c) AS ?n) WHERE { GRAPH <${CLAIMS}> { ?c a <${CORE}Claim> ; <${CORE}claimObject> ?o . FILTER (STR(?o) = "${o}") } }`);
  const tripleCount = (g: string) => count(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${g}> { ?s ?p ?o } }`);
  async function evidenceOf(claim: string): Promise<Array<{ span?: string; session?: string; at?: string }>> {
    const r = await store.query(`SELECT ?span ?session ?at WHERE {
      GRAPH <${CLAIMS}> { <${claim}> <${CORE}hasEvidence> ?e }
      GRAPH <${EVIDENCE}> { ?e <${CORE}capturedAt> ?at . OPTIONAL { ?e <${CORE}rawText> ?span } OPTIONAL { ?e <${CORE}sessionId> ?session } } }`);
    return (r.bindings ?? []).map((b) => ({ span: b.span?.value, session: b.session?.value, at: b.at?.value }));
  }

  it('returns the existing claim, adds an Evidence record (span, session, time), mints no second claim and no triple', async () => {
    const first = await engine.storeFact(likes(), ctx('anna', 's1'));
    expect(first.tripleCount).toBe(1);
    expect(first.reassertedClaimUri).toBeUndefined();
    const tBefore = await tripleCount(userGraph('anna'));
    const qBefore = await quads();

    const again = await engine.storeFact(likes('Tea', 'yes, I like tea'), ctx('anna', 's2'));
    expect(again.tripleCount).toBe(0);
    expect(again.claimUri).toBeUndefined();
    expect(again.reassertedClaimUri).toBe(first.claimUri);

    expect(await claimsOfObject('Tea')).toBe(1);
    expect(await tripleCount(userGraph('anna'))).toBe(tBefore);
    const ev = await evidenceOf(first.claimUri!);
    expect(ev).toHaveLength(2);
    const added = ev.find((e) => e.session === 's2')!;
    expect(added.span).toBe('yes, I like tea');
    expect(added.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // Only the evidence (and its link on the claim) was written.
    expect(await quads()).toBeGreaterThan(qBefore);
    expect(await tripleCount(userGraph('anna'))).toBe(tBefore);
  });

  it('a third statement links the same claim again and still mints nothing', async () => {
    const first = await engine.storeFact(likes(), ctx('anna', 's1'));
    await engine.storeFact(likes(), ctx('anna', 's2'));
    const third = await engine.storeFact(likes(), ctx('anna', 's3'));
    expect(third.reassertedClaimUri).toBe(first.claimUri);
    expect(await claimsOfObject('Tea')).toBe(1);
    expect(await evidenceOf(first.claimUri!)).toHaveLength(3);
  });

  it('without recordReassertion a duplicate is skipped exactly as before: no field, no write', async () => {
    await engine.storeFact(likes(), ctx('anna', 's1'));
    const before = await quads();
    const again = await engine.storeFact(likes(), ctx('anna', 's2', { recordReassertion: undefined }));
    expect(again.tripleCount).toBe(0);
    expect(again).not.toHaveProperty('reassertedClaimUri');
    expect(await quads()).toBe(before);
  });

  it('user B stating what only user A holds privately does not link to A\'s claim; B\'s own routing applies', async () => {
    const a = await engine.storeFact(likes(), ctx('anna', 'sa'));
    const aEvidence = await evidenceOf(a.claimUri!);
    const b = await engine.storeFact(likes(), ctx('bob', 'sb'));
    // Not a duplicate for B: stored in B's own graph with B's own claim.
    expect(b.tripleCount).toBe(1);
    expect(b.reassertedClaimUri).toBeUndefined();
    expect(b.claimUri).not.toBe(a.claimUri);
    expect(await evidenceOf(a.claimUri!)).toEqual(aEvidence);
    const r = await store.query(`SELECT ?g WHERE { GRAPH <${CLAIMS}> { <${b.claimUri}> <${CORE}assertedInGraph> ?g } }`);
    expect(r.bindings![0].g.value).toBe(userGraph('bob'));

    // B again: B's own claim is linked, never A's.
    const bAgain = await engine.storeFact(likes(), ctx('bob', 'sb2'));
    expect(bAgain.reassertedClaimUri).toBe(b.claimUri);
    expect(await evidenceOf(a.claimUri!)).toEqual(aEvidence);
  });

  it('a worldview fact is linked by whoever restates it through the worldview route', async () => {
    const first = await engine.storeFact(world(), ctx('anna', 's1'));
    const r = await engine.storeFact(world('as I said, Anna works at Acme'), ctx('bob', 's2'));
    expect(r.tripleCount).toBe(0);
    expect(r.reassertedClaimUri).toBe(first.claimUri);
    const g = await store.query(`SELECT ?g WHERE { GRAPH <${CLAIMS}> { <${first.claimUri}> <${CORE}assertedInGraph> ?g } }`);
    expect(g.bindings![0].g.value).toBe(WORLDVIEW);
  });

  it('a secret-class, a superseded and a consolidation claim are not linked', async () => {
    const first = await engine.storeFact(likes(), ctx('anna', 's1'));
    await store.update(`INSERT DATA { GRAPH <${CLAIMS}> { <${first.claimUri}> <${CORE}privacyClass> "secret" } }`);
    const secret = await engine.storeFact(likes(), ctx('anna', 's2'));
    expect(secret.tripleCount).toBe(0);
    expect(secret.reassertedClaimUri).toBeUndefined();
    expect(await evidenceOf(first.claimUri!)).toHaveLength(1);

    await store.update(`DELETE DATA { GRAPH <${CLAIMS}> { <${first.claimUri}> <${CORE}privacyClass> "secret" } }`);
    await store.update(`DELETE { GRAPH <${CLAIMS}> { <${first.claimUri}> <${CORE}status> "accepted" } } INSERT { GRAPH <${CLAIMS}> { <${first.claimUri}> <${CORE}status> "superseded" } } WHERE {}`);
    expect((await engine.storeFact(likes(), ctx('anna', 's3'))).reassertedClaimUri).toBeUndefined();

    await store.update(`DELETE { GRAPH <${CLAIMS}> { <${first.claimUri}> <${CORE}status> "superseded" } } INSERT { GRAPH <${CLAIMS}> { <${first.claimUri}> <${CORE}status> "accepted" ; <${CORE}sourceKind> "consolidation-episodic" } } WHERE {}`);
    expect((await engine.storeFact(likes(), ctx('anna', 's4'))).reassertedClaimUri).toBeUndefined();
  });

  it('through the ingestion service: skipped as duplicate as before, plus the reasserted claim; claimUris unchanged', async () => {
    const svc = new SemanticIngestionService(engine);
    const parsed = (span: string): SemanticParseResult => ({
      facts: [{ kind: 'fact', subject: 'User', predicate: 'likes', object: 'Tea', objectType: 'literal', confidence: 'high', sourceSpan: span }],
      proposals: [], confidence: 'high', meta: { skipped: false },
    } as unknown as SemanticParseResult);
    const r1 = await svc.ingest(parsed('one'), ctx('anna', 's1'));
    expect(r1.claimUris).toHaveLength(1);
    expect(r1.reassertedClaims).toEqual([]);
    const r2 = await svc.ingest(parsed('two'), ctx('anna', 's2'));
    expect(r2.storedFacts).toHaveLength(0);
    expect(r2.skippedFacts.map((s) => s.reason)).toEqual(['duplicate']);
    expect(r2.claimUris).toEqual([]);
    expect(r2.reassertedClaims.map((x) => x.claimUri)).toEqual(r1.claimUris);
    // Off: the same call without the option reports nothing extra.
    const r3 = await svc.ingest(parsed('three'), ctx('anna', 's3', { recordReassertion: undefined }));
    expect(r3.reassertedClaims).toEqual([]);
  });

  describe('promotion', () => {
    const T0 = Date.parse('2026-09-01T10:00:00.000Z');

    it('a triple the worldview already holds as an independent accepted claim is not promoted', async () => {
      const w = await engine.storeFact(world(), ctx('carl', 'sc'));
      const em = new EpisodicMemory(store, AGENT);
      // Anna's episodes cite claims of their own for the same triple.
      for (let i = 0; i < 3; i++) {
        const c = `urn:claim:anna_${i}`;
        await store.update(`INSERT DATA { GRAPH <${CLAIMS}> { <${c}> a <${CORE}Claim> ;
          <${CORE}claimSubject> <urn:ontofelia:entity:Anna> ; <${CORE}claimPredicate> <urn:ontofelia:core#worksAt> ;
          <${CORE}claimObject> <urn:ontofelia:entity:Acme> ; <${CORE}status> "accepted" ;
          <${CORE}assertedInGraph> <${WORLDVIEW}> ; <${CORE}sourceKind> "user" } }`);
        await em.append({ episodeType: 'message-received', forUser: 'anna', factGraph: userGraph('anna'), sessionId: `a${i}`, occurredAt: new Date(T0 + i * 86_400_000), hasClaim: [c] });
      }
      expect(w.claimUri).toBeDefined();
      const before = await quads();
      const report = await new EpisodicConsolidation(store, AGENT, engine).run();
      expect(report.qualified).toBe(1);
      expect(report.promoted).toBe(0);
      expect(report.alreadyKnown).toBe(1);
      expect(await quads()).toBe(before);
      expect(await tripleCount(userGraph('anna'))).toBe(0);
    });
  });
});
