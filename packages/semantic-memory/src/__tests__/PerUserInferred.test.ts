/**
 * Derivations must follow the privacy of the facts they come from: worldview
 * derivations land in the shared inferred graph, derivations that depend on a
 * user's private graph land in that user's own inferred graph and nowhere else.
 *
 * Real round-trips on the embedded OxigraphAdapter and the native reasoner.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Triple, TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { ReasonableEngine } from '../reasoning/ReasonableEngine.js';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import { GraphRegistry } from '../utils/GraphRegistry.js';

const AGENT = 'ontofelia';
const CORE = 'urn:ontofelia:core#';
const RDFS_SUBPROP = 'http://www.w3.org/2000/01/rdf-schema#subPropertyOf';
const ONTOLOGY = 'urn:shared:ontology';
const SHARED = GraphUriResolver.getInferredGraph(AGENT);
const BOB_INF = GraphUriResolver.getUserInferredGraph(AGENT, 'bob');
const ALICE_INF = GraphUriResolver.getUserInferredGraph(AGENT, 'alice');
const bobCtx = { agentId: AGENT, userId: 'bob', sessionId: 's', isOwner: false };
const aliceCtx = { agentId: AGENT, userId: 'alice', sessionId: 's', isOwner: false };

let store: OxigraphAdapter;
let engine: KnowledgeEngine;

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'pui-')), port: 0, endpoint: '',
  });
  engine = new KnowledgeEngine(store as never);
  // Two property hierarchies give the reasoner something genuine to derive.
  await store.update(`INSERT DATA { GRAPH <${ONTOLOGY}> {
    <${CORE}likes> <${RDFS_SUBPROP}> <${CORE}enjoys> .
    <${CORE}livesIn> <${RDFS_SUBPROP}> <${CORE}residesIn> .
  } }`);
});

/** Every `?g ?s ?p ?o` row of the graphs whose URI contains "inferred". */
async function inferredRows(): Promise<string[]> {
  const r: any = await store.query(
    `SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?g), "inferred")) } ORDER BY ?g ?s ?p ?o`,
  );
  return r.bindings.map((b: any) => `${b.g.value} | ${b.s.value} | ${b.p.value} | ${b.o.value}`);
}

async function graphText(graph: string): Promise<string> {
  const r: any = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  return r.bindings.map((b: any) => `${b.s.value} ${b.p.value} ${b.o.value}`).join('\n');
}

const bobLikes = () => engine.storeFact(
  { subject: 'User', subjectType: 'Person', predicate: 'likes', object: 'SecretBobThing', objectType: 'literal', sourceKind: 'user' },
  bobCtx,
);
const annaLivesInHamburg = () => engine.storeFact(
  { subject: 'Anna', subjectType: 'Person', predicate: 'livesIn', object: 'Hamburg', objectType: 'Place', sourceKind: 'user' },
  aliceCtx,
);

describe('input facts are not re-added as derivations', () => {
  it('measurement: lists exactly what lands in the inferred graphs', async () => {
    await bobLikes();
    await annaLivesInHamburg();
    const rows = await inferredRows();
    // Exactly the genuine derivations; neither input triple (likes / livesIn) appears.
    expect(rows).toEqual([
      `${SHARED} | urn:ontofelia:entity:Anna | ${CORE}residesIn | urn:ontofelia:entity:Hamburg`,
      `${BOB_INF} | urn:ontofelia:entity:user:bob | ${CORE}enjoys | SecretBobThing`,
    ]);
  });

  it('a plain-string literal input matches the reasoner\'s literal term (no ontology needed)', async () => {
    const stub = { async getGraph() { return ''; } } as unknown as TriplestoreAdapter;
    const input: Triple = { subject: 'urn:t:a', predicate: 'urn:t:likes', object: 'Plain' };
    // With an empty ABox the reasoner also derives `a rdf:type owl:Thing`; the
    // input triple itself (predicate urn:t:likes) must not come back.
    const predicates = async (t: Triple) =>
      (await new ReasonableEngine(stub).materialize([t], 'urn:t:g')).map(d => d.predicate);
    expect(await predicates(input)).not.toContain('urn:t:likes');
    // Same for the object form, with a language tag, and with a quote that needs escaping.
    const obj: Triple = { subject: 'urn:t:a', predicate: 'urn:t:n', object: { type: 'literal', value: 'say "hi"', language: 'en' } };
    expect(await predicates(obj)).not.toContain('urn:t:n');
    const quoted: Triple = { subject: 'urn:t:a', predicate: 'urn:t:n', object: 'say "hi"' };
    expect(await predicates(quoted)).not.toContain('urn:t:n');
  });
});

describe('per-scope derivations', () => {
  it('Bob\'s private fact leaves no trace in the shared inferred graph', async () => {
    await bobLikes();
    expect(await graphText(SHARED)).not.toContain('SecretBobThing');
    // The genuine derivation does exist, in Bob\'s own inferred graph only.
    expect(await graphText(BOB_INF)).toContain(`${CORE}enjoys SecretBobThing`);
    expect(await graphText(ALICE_INF)).not.toContain('SecretBobThing');
  });

  it('what Alice may read never shows it', async () => {
    await bobLikes();
    await annaLivesInHamburg();
    const readable = GraphUriResolver.getReadableInferredGraphs(AGENT, 'alice');
    expect(readable).toEqual([SHARED, ALICE_INF]);
    for (const g of readable) expect(await graphText(g)).not.toContain('SecretBobThing');
    for (const text of [
      await engine.getFactsAbout(['User'], AGENT, 20, 'alice'),
      await engine.getRecentFacts(AGENT, 30, 'alice'),
    ]) expect(text).not.toContain('SecretBobThing');
    // Bob reads his own.
    expect(GraphUriResolver.getReadableInferredGraphs(AGENT, 'bob')).toEqual([SHARED, BOB_INF]);
    expect(await graphText(BOB_INF)).toContain('SecretBobThing');
  });

  it('a worldview fact\'s derivation lands in the shared graph, visible to everyone', async () => {
    await annaLivesInHamburg();
    expect(await graphText(SHARED)).toContain(`${CORE}residesIn urn:ontofelia:entity:Hamburg`);
    for (const user of ['alice', 'bob']) {
      const texts = await Promise.all(
        GraphUriResolver.getReadableInferredGraphs(AGENT, user).map(graphText),
      );
      expect(texts.join('\n')).toContain('residesIn');
    }
    expect(await graphText(ALICE_INF)).toBe('');
  });

  it('per-user inferred graphs are registered (and not mistaken for user graphs)', () => {
    const reg = GraphRegistry.create([AGENT]);
    expect(reg.describe(BOB_INF)?.role).toBe('inferred-user');
    expect(reg.isAllowed(`urn:unknown:inferred:user:bob`)).toBe(false);
    expect(BOB_INF.startsWith(`urn:${AGENT}:user:`)).toBe(false);
  });
});

describe('retraction', () => {
  it('superseding Bob\'s fact removes its derivation from Bob\'s inferred graph', async () => {
    await store.update(`INSERT DATA { GRAPH <${ONTOLOGY}> {
      <${CORE}likes> a <http://www.w3.org/2002/07/owl#FunctionalProperty> . } }`);
    await bobLikes();
    expect(await graphText(BOB_INF)).toContain('SecretBobThing');
    await engine.storeFact(
      { subject: 'User', subjectType: 'Person', predicate: 'likes', object: 'SomethingElse', objectType: 'literal', sourceKind: 'user' },
      bobCtx,
    );
    expect(await graphText(GraphUriResolver.getUserGraph(AGENT, 'bob'))).not.toContain('SecretBobThing');
    const bob = await graphText(BOB_INF);
    expect(bob).not.toContain('SecretBobThing');
    expect(bob).toContain(`${CORE}enjoys SomethingElse`);
    expect(await graphText(SHARED)).toBe('');
  });

  it('rebuildInferredGraphFor recomputes a user\'s derivations after the base fact is deleted', async () => {
    await bobLikes();
    await store.update(`DELETE WHERE { GRAPH <${GraphUriResolver.getUserGraph(AGENT, 'bob')}> { ?s <${CORE}likes> ?o } }`);
    expect(await graphText(BOB_INF)).toContain('SecretBobThing'); // stale until recomputed
    await engine.rebuildInferredGraphFor(AGENT, GraphUriResolver.getUserGraph(AGENT, 'bob'));
    expect(await graphText(BOB_INF)).not.toContain('SecretBobThing');
  });
});

describe('rebuildInferredGraphs', () => {
  it('moves a mixed legacy state to the correct split', async () => {
    await bobLikes();
    await annaLivesInHamburg();
    // Recreate the legacy state: every derivation, plus the input fact, in the shared graph.
    await store.update(`CLEAR SILENT GRAPH <${BOB_INF}>`);
    await store.update(`INSERT DATA { GRAPH <${SHARED}> {
      <urn:ontofelia:entity:user:bob> <${CORE}enjoys> "SecretBobThing" .
      <urn:ontofelia:entity:user:bob> <${CORE}likes> "SecretBobThing" .
    } }`);
    // A derivation left over for a user whose graph no longer exists.
    await store.update(`INSERT DATA { GRAPH <${GraphUriResolver.getUserInferredGraph(AGENT, 'gone')}> {
      <urn:t:x> <${CORE}enjoys> "Orphan" . } }`);

    const summary = await engine.rebuildInferredGraphs(AGENT);

    expect(await graphText(SHARED)).not.toContain('SecretBobThing');
    expect(await graphText(SHARED)).toContain(`${CORE}residesIn urn:ontofelia:entity:Hamburg`);
    expect(await graphText(BOB_INF)).toContain(`${CORE}enjoys SecretBobThing`);
    expect(await graphText(BOB_INF)).not.toContain(`${CORE}likes`);
    expect(await graphText(GraphUriResolver.getUserInferredGraph(AGENT, 'gone'))).toBe('');
    expect(summary.shared).toBeGreaterThan(0);
    expect(summary.perUser.bob).toBeGreaterThan(0);
  });

  it('leaves the existing derivations alone when the reasoner fails', async () => {
    await bobLikes();
    const failing = engine as any;
    failing.reasoner.materialize = async () => { throw new Error('boom'); };
    await expect(engine.rebuildInferredGraphs(AGENT)).rejects.toThrow('boom');
    expect(await graphText(BOB_INF)).toContain('SecretBobThing');
  });
});
