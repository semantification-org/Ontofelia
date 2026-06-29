/**
 * REL-2 / Privacy-P0 (OPRO #869) — Graph Isolation Regression Test
 *
 * Verifies that SPARQL queries WITHOUT an explicit GRAPH clause do NOT read
 * data from private named graphs (urn:...:user:*, urn:...:session:*).
 *
 * Background: TODO-001 in review/2026_05_18_antigravity_semantic_memory_todos.md
 * flagged Fuseki's `tdb2:unionDefaultGraph true` as a privacy leak. The live
 * runtime uses OxigraphAdapter whose embedded WASM Store has an empty default
 * graph by default. This test suite guarantees:
 *
 *   1. Data stored in a private named graph is invisible to graph-less queries.
 *   2. Data stored in one user's graph is invisible from another user's graph.
 *   3. Session-scoped data is invisible from graph-less queries.
 *   4. Cross-graph queries via `GRAPH ?g` work (data is present), proving
 *      the test setup is valid (data was actually stored).
 *
 * If this test ever fails, it means the Oxigraph store configuration has
 * changed to union named graphs into the default graph — a privacy breach.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import type { TriplestoreAdapter } from '@ontofelia/core';

// ── Fixtures ──────────────────────────────────────────────────────────

const ALICE_USER_GRAPH = 'urn:ontofelia:user:alice';
const BOB_USER_GRAPH   = 'urn:ontofelia:user:bob';
const SESSION_GRAPH    = 'urn:ontofelia:session:sess_secret42';
const AGENT_ABOX       = 'urn:ontofelia:agent:ontofelia:abox';

const ALICE_TRIPLE = `
  <urn:person:alice> <http://xmlns.com/foaf/0.1/name> "Alice Nakamura" .
  <urn:person:alice> <urn:shared:ontology#email> "alice@secret.internal" .
`;

const BOB_TRIPLE = `
  <urn:person:bob> <http://xmlns.com/foaf/0.1/name> "Bob Chen" .
`;

const SESSION_TRIPLE = `
  <urn:session:event:1> <urn:shared:ontology#payload> "private session data" .
  <urn:session:event:1> <urn:shared:ontology#cog/occurredAt> "2026-06-01T10:00:00Z" .
`;

const ABOX_TRIPLE = `
  <urn:entity:berlin> <http://www.w3.org/2000/01/rdf-schema#label> "Berlin" .
  <urn:entity:berlin> <urn:shared:ontology#population> "3748148" .
`;

// ── Helpers ───────────────────────────────────────────────────────────

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/privacy-iso-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

/**
 * Run a GRAPH-less SELECT and return all binding rows.
 * If the default graph is properly isolated (empty), this must return [].
 */
async function graphlessSelect(
  store: TriplestoreAdapter,
  sparql: string,
): Promise<Array<Record<string, { type: string; value: string }>>> {
  const res = await store.query(sparql);
  if (res.type !== 'bindings') return [];
  return (res.bindings ?? []) as Array<Record<string, { type: string; value: string }>>;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('Privacy: Graph Isolation (REL-2 / TODO-001)', () => {
  let store: TriplestoreAdapter;

  beforeEach(async () => {
    store = await makeStore();

    // Populate FOUR named graphs with private data
    await store.putGraph(ALICE_USER_GRAPH, ALICE_TRIPLE, 'turtle');
    await store.putGraph(BOB_USER_GRAPH, BOB_TRIPLE, 'turtle');
    await store.putGraph(SESSION_GRAPH, SESSION_TRIPLE, 'turtle');
    await store.putGraph(AGENT_ABOX, ABOX_TRIPLE, 'turtle');
  });

  // ── Core isolation: graph-less queries must see NOTHING ───────────

  it('graph-less SELECT returns NOTHING from user graphs', async () => {
    const rows = await graphlessSelect(store, `
      SELECT ?s ?p ?o WHERE { ?s ?p ?o }
    `);
    expect(rows).toHaveLength(0);
  });

  it('graph-less SELECT for Alice name returns NOTHING', async () => {
    const rows = await graphlessSelect(store, `
      PREFIX foaf: <http://xmlns.com/foaf/0.1/>
      SELECT ?name WHERE { ?s foaf:name ?name }
    `);
    expect(rows).toHaveLength(0);
  });

  it('graph-less ASK for any triple returns false', async () => {
    const result = await store.ask('ASK { ?s ?p ?o }');
    expect(result).toBe(false);
  });

  it('graph-less SELECT with FILTER returns NOTHING from session graph', async () => {
    const rows = await graphlessSelect(store, `
      SELECT ?payload WHERE {
        ?s <urn:shared:ontology#payload> ?payload
      }
    `);
    expect(rows).toHaveLength(0);
  });

  it('graph-less COUNT returns zero', async () => {
    const rows = await graphlessSelect(store, `
      SELECT (COUNT(*) AS ?count) WHERE { ?s ?p ?o }
    `);
    const count = parseInt(rows[0]?.count?.value ?? '0', 10);
    expect(count).toBe(0);
  });

  // ── Cross-user isolation: user A cannot see user B ────────────────

  it('querying Alice graph does NOT return Bob data', async () => {
    const rows = await graphlessSelect(store, `
      PREFIX foaf: <http://xmlns.com/foaf/0.1/>
      SELECT ?name WHERE {
        GRAPH <${ALICE_USER_GRAPH}> { ?s foaf:name ?name }
      }
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].name.value).toBe('Alice Nakamura');
    // Explicitly: Bob must NOT appear
    const names = rows.map((r) => r.name.value);
    expect(names).not.toContain('Bob Chen');
  });

  it('querying Bob graph does NOT return Alice data', async () => {
    const rows = await graphlessSelect(store, `
      PREFIX foaf: <http://xmlns.com/foaf/0.1/>
      SELECT ?name WHERE {
        GRAPH <${BOB_USER_GRAPH}> { ?s foaf:name ?name }
      }
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0].name.value).toBe('Bob Chen');
    const names = rows.map((r) => r.name.value);
    expect(names).not.toContain('Alice Nakamura');
  });

  // ── Session-graph isolation ───────────────────────────────────────

  it('session data is only visible within its own GRAPH scope', async () => {
    // Session data visible via explicit GRAPH
    const scoped = await graphlessSelect(store, `
      SELECT ?payload WHERE {
        GRAPH <${SESSION_GRAPH}> { ?s <urn:shared:ontology#payload> ?payload }
      }
    `);
    expect(scoped).toHaveLength(1);
    expect(scoped[0].payload.value).toBe('private session data');

    // NOT visible via graph-less query
    const leaked = await graphlessSelect(store, `
      SELECT ?payload WHERE { ?s <urn:shared:ontology#payload> ?payload }
    `);
    expect(leaked).toHaveLength(0);
  });

  // ── Validity check: data IS actually present ──────────────────────

  it('data IS present when queried via GRAPH ?g (validity check)', async () => {
    const rows = await graphlessSelect(store, `
      PREFIX foaf: <http://xmlns.com/foaf/0.1/>
      SELECT ?g ?name WHERE {
        GRAPH ?g { ?s foaf:name ?name }
      }
      ORDER BY ?name
    `);
    // Alice + Bob = 2 results across their respective graphs
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const names = rows.map((r) => r.name.value).sort();
    expect(names).toContain('Alice Nakamura');
    expect(names).toContain('Bob Chen');
  });

  it('all four graphs contain data (validity check)', async () => {
    for (const graphUri of [ALICE_USER_GRAPH, BOB_USER_GRAPH, SESSION_GRAPH, AGENT_ABOX]) {
      const rows = await graphlessSelect(store, `
        SELECT (COUNT(*) AS ?count) WHERE {
          GRAPH <${graphUri}> { ?s ?p ?o }
        }
      `);
      const count = parseInt(rows[0]?.count?.value ?? '0', 10);
      expect(count).toBeGreaterThan(0);
    }
  });

  // ── getInferredTriples must not leak named-graph data ─────────────

  it('getInferredTriples returns nothing when all data is in named graphs', async () => {
    // This tests the exact query pattern from OxigraphAdapter.getInferredTriples()
    const rows = await graphlessSelect(store, `
      SELECT ?s ?p ?o WHERE {
        ?s ?p ?o .
        FILTER NOT EXISTS {
          GRAPH ?g { ?s ?p ?o }
        }
      } LIMIT 1000
    `);
    expect(rows).toHaveLength(0);
  });

  // ── Consistency check query must not leak ─────────────────────────

  it('checkConsistency-style query on default graph returns zero', async () => {
    // This is the exact pattern from KnowledgeEngine.checkConsistency()
    const rows = await graphlessSelect(store, `
      SELECT (COUNT(*) AS ?count) WHERE {
        ?s ?p ?o .
        FILTER NOT EXISTS { GRAPH ?g { ?s ?p ?o } }
      }
    `);
    const count = parseInt(rows[0]?.count?.value ?? '0', 10);
    expect(count).toBe(0);
  });

  // ── ReflectionRunner-style count must not leak ────────────────────

  it('reflection-style graph-less triple count returns zero', async () => {
    // This is the exact pattern from ReflectionRunner.reflect()
    const rows = await graphlessSelect(store, `
      PREFIX onto: <http://ontofelia.org/ontology/>
      SELECT (COUNT(*) AS ?count) WHERE {
        ?s ?p ?o .
      }
    `);
    const count = parseInt(rows[0]?.count?.value ?? '0', 10);
    expect(count).toBe(0);
  });
});
