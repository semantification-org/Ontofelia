import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine, ReseedInvariantError } from '../KnowledgeEngine.js';
import { GraphRegistry } from '../utils/GraphRegistry.js';
import { SelfModel } from '../cognitive/SelfModel.js';

// reseedSelf drives SPARQL DELETE/INSERT across named graphs, so it needs the
// embedded Oxigraph store (the in-memory adapter is a no-op for updates).

const AGENT = 'ontofelia';
const SELF_GRAPH = 'urn:ontofelia:self';
const CORE = 'urn:ontofelia:core#';
const COGT = 'urn:shared:ontology#cog/';

const SELF_TTL_V1 = `@prefix onto: <urn:ontofelia:core#> .
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

onto:Ontofelia rdf:type onto:AIAgent .
onto:Ontofelia onto:name    "Ontofelia" .
onto:Ontofelia onto:version "0.2.0" .
onto:Ontofelia onto:personality "friendly" .
onto:Ontofelia onto:brevity     "concise" .
onto:Ontofelia onto:capability  "RDF Knowledge Graph" .
onto:Ontofelia onto:capability  "OWL reasoning" .
`;

// v2: version changed, brevity removed, a personality value changed, a brand-new
// predicate added, one capability dropped.
const SELF_TTL_V2 = `@prefix onto: <urn:ontofelia:core#> .
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

onto:Ontofelia rdf:type onto:AIAgent .
onto:Ontofelia onto:name    "Ontofelia" .
onto:Ontofelia onto:version "0.9.9-test" .
onto:Ontofelia onto:personality "sharp and warm" .
onto:Ontofelia onto:tagline     "memory that lasts" .
onto:Ontofelia onto:capability  "RDF Knowledge Graph" .
`;

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/reseed-test-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

async function count(store: TriplestoreAdapter, filter = ''): Promise<number> {
  const res = await store.query(
    `SELECT (COUNT(*) AS ?c) WHERE { GRAPH <${SELF_GRAPH}> { ?s ?p ?o } ${filter} }`,
  );
  const v = res.type === 'bindings' ? res.bindings?.[0]?.c?.value : undefined;
  return v ? Number.parseInt(v, 10) : 0;
}

async function ask(store: TriplestoreAdapter, triple: string): Promise<boolean> {
  return store.ask(`ASK { GRAPH <${SELF_GRAPH}> { ${triple} } }`);
}

describe('KnowledgeEngine.reseedSelf', () => {
  let store: TriplestoreAdapter;
  let ke: KnowledgeEngine;
  let bootstrapDir: string;

  beforeEach(async () => {
    store = await makeStore();
    ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));

    bootstrapDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reseed-boot-'));
    await fs.writeFile(path.join(bootstrapDir, 'self.ttl'), SELF_TTL_V1, 'utf-8');

    // First-time seed from v1, then simulate runtime-learned self-model facts.
    await ke.seedCoreGraphs(bootstrapDir, AGENT);
    const sm = new SelfModel(store, AGENT);
    await sm.seed({
      capabilities: [{ id: 'chat', label: 'Conversational chat', requires: ['none'] }],
      constraints: [{ id: 'no_secret', label: 'Never persist secrets', applies: ['memory_store'] }],
    });
  });

  afterEach(async () => {
    await fs.rm(bootstrapDir, { recursive: true, force: true });
  });

  it('applies edited bootstrap facts (changed, removed, added) to the self graph', async () => {
    // Sanity: v1 state is in place.
    expect(await ask(store, `<${CORE}Ontofelia> <${CORE}version> "0.2.0"`)).toBe(true);
    expect(await ask(store, `<${CORE}Ontofelia> <${CORE}brevity> "concise"`)).toBe(true);

    await fs.writeFile(path.join(bootstrapDir, 'self.ttl'), SELF_TTL_V2, 'utf-8');
    await ke.reseedSelf(bootstrapDir, AGENT);

    // Changed value replaced (old gone, new present).
    expect(await ask(store, `<${CORE}Ontofelia> <${CORE}version> "0.2.0"`)).toBe(false);
    expect(await ask(store, `<${CORE}Ontofelia> <${CORE}version> "0.9.9-test"`)).toBe(true);
    // Removed predicate is gone.
    expect(await ask(store, `<${CORE}Ontofelia> <${CORE}brevity> ?o`)).toBe(false);
    // Added predicate is present.
    expect(await ask(store, `<${CORE}Ontofelia> <${CORE}tagline> "memory that lasts"`)).toBe(true);
    // A dropped multi-valued member is gone; the kept one remains.
    expect(await ask(store, `<${CORE}Ontofelia> <${CORE}capability> "OWL reasoning"`)).toBe(false);
    expect(await ask(store, `<${CORE}Ontofelia> <${CORE}capability> "RDF Knowledge Graph"`)).toBe(true);
    // The rdf:type onto:AIAgent survives (re-inserted).
    expect(await ask(store, `<${CORE}Ontofelia> a <${CORE}AIAgent>`)).toBe(true);
  });

  it('preserves every runtime-learned fact (provable by triple count)', async () => {
    // Learned self-model triples hang off the self subject (urn:<agent>:self#…)
    // or off cogt: capability/constraint resources — both disjoint from the
    // bootstrap core#Ontofelia subject.
    const learnedFilter = `FILTER( STRSTARTS(STR(?s), "urn:${AGENT}:self#") || STRSTARTS(STR(?s), "${COGT}") )`;
    const learnedBefore = await count(store, learnedFilter);
    expect(learnedBefore).toBeGreaterThan(0);

    await fs.writeFile(path.join(bootstrapDir, 'self.ttl'), SELF_TTL_V2, 'utf-8');
    const report = await ke.reseedSelf(bootstrapDir, AGENT);

    const learnedAfter = await count(store, learnedFilter);
    expect(learnedAfter).toBe(learnedBefore);

    // The learned facts are still semantically readable.
    const sm = new SelfModel(store, AGENT);
    const view = await sm.queryFor();
    expect(view.capabilities.map((c) => c.label)).toContain('Conversational chat');
    expect(view.constraints.map((c) => c.label)).toContain('Never persist secrets');

    // The reported preserved count equals the learned/other triples.
    expect(report.preserved).toBe(learnedBefore);
  });

  it('is idempotent — a second reseed changes nothing', async () => {
    await fs.writeFile(path.join(bootstrapDir, 'self.ttl'), SELF_TTL_V2, 'utf-8');
    const first = await ke.reseedSelf(bootstrapDir, AGENT);
    const totalAfterFirst = await count(store);

    const second = await ke.reseedSelf(bootstrapDir, AGENT);
    const totalAfterSecond = await count(store);

    expect(totalAfterSecond).toBe(totalAfterFirst);
    expect(second.bootstrapAfter).toBe(first.bootstrapAfter);
    expect(second.preserved).toBe(first.preserved);
  });

  it('handles a bootstrap file that uses a non-core predicate', async () => {
    // Ownership is by subject, not namespace: a future self.ttl may describe the
    // agent with rdfs: / other predicates. Those must reseed cleanly and must
    // NOT trip the non-bootstrap-count tripwire.
    const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
    const ttlWithForeignPred = `@prefix onto: <urn:ontofelia:core#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .

onto:Ontofelia rdf:type onto:AIAgent .
onto:Ontofelia onto:version "1.0.0" .
onto:Ontofelia rdfs:label "Ontofelia the owl" .
`;
    await fs.writeFile(path.join(bootstrapDir, 'self.ttl'), ttlWithForeignPred, 'utf-8');

    const learnedFilter = `FILTER( STRSTARTS(STR(?s), "urn:${AGENT}:self#") || STRSTARTS(STR(?s), "${COGT}") )`;
    const learnedBefore = await count(store, learnedFilter);

    // Must not throw the invariant error.
    const report = await ke.reseedSelf(bootstrapDir, AGENT);

    // The non-core predicate landed and is owned by the reseed.
    expect(await ask(store, `<${CORE}Ontofelia> <${RDFS_LABEL}> "Ontofelia the owl"`)).toBe(true);
    // Learned facts still fully intact.
    expect(await count(store, learnedFilter)).toBe(learnedBefore);
    expect(report.preserved).toBe(learnedBefore);

    // Idempotent even with the foreign predicate present.
    const again = await ke.reseedSelf(bootstrapDir, AGENT);
    expect(again.bootstrapAfter).toBe(report.bootstrapAfter);
    expect(again.preserved).toBe(learnedBefore);
  });

  it('rejects blank-node subjects before touching the self graph', async () => {
    // Subject ownership cannot be tracked for blank nodes (every parse mints
    // fresh ones), so a blank-node subject must fail BEFORE any mutation.
    const ttlWithBlankNode = `@prefix onto: <urn:ontofelia:core#> .
[] onto:name "anonymous persona fragment" .
`;
    await fs.writeFile(path.join(bootstrapDir, 'self.ttl'), ttlWithBlankNode, 'utf-8');

    const totalBefore = await count(store);
    await expect(ke.reseedSelf(bootstrapDir, AGENT)).rejects.toThrow(/blank-node subjects/);

    // Nothing changed: v1 persona intact, triple count identical.
    expect(await count(store)).toBe(totalBefore);
    expect(await ask(store, `<${CORE}Ontofelia> <${CORE}version> "0.2.0"`)).toBe(true);
    expect(await ask(store, `?s <${CORE}name> "anonymous persona fragment"`)).toBe(false);
  });

  it('ReseedInvariantError states that the reseed WAS applied (tripwire contract)', () => {
    // The tripwire fires AFTER the atomic update commits; the error type and
    // message must not read as "reseed failed" on any surface that relays it.
    const err = new ReseedInvariantError(
      'Persona re-seed WAS applied (bootstrap triples 7 → 8), but the post-apply invariant ' +
      'check found that preserved (non-bootstrap) triples changed (12 → 13).',
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ReseedInvariantError');
    expect(err.message).toContain('WAS applied');
  });

  it('seeds an empty self graph like a first-time seed', async () => {
    // Wipe the self graph entirely, then reseed from scratch.
    await store.update(`DROP SILENT GRAPH <${SELF_GRAPH}>`);
    expect(await count(store)).toBe(0);

    const report = await ke.reseedSelf(bootstrapDir, AGENT);
    expect(report.preserved).toBe(0);
    expect(report.bootstrapAfter).toBeGreaterThan(0);
    expect(await ask(store, `<${CORE}Ontofelia> <${CORE}version> "0.2.0"`)).toBe(true);
  });
});
