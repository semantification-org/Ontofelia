/**
 * An approved ontology proposal must reach the triplestore: the engine reads
 * the TBox from the store, not from the version files. Real round-trips on the
 * embedded OxigraphAdapter; the ontology directory and the store live in temp
 * directories, never in the real home.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { OntologyManager } from '../ontology/OntologyManager.js';
import { OntologyContextProvider } from '../ingestion/OntologyContextProvider.js';
import { GraphRegistry } from '../utils/GraphRegistry.js';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';

const AGENT = 'ontofelia';
const CORE_TTL = join(dirname(fileURLToPath(import.meta.url)), '..', 'ontologies', 'ontofelia-core.ttl');
const CORE = 'urn:shared:ontology#';
const REVISION = 'urn:ontofelia:core#hasCurrentRevision';
const OWNS = 'urn:ontofelia:core#ownsDevice';
const ONTOLOGY_GRAPH = GraphUriResolver.getOntologyGraph(AGENT);
const CLAIMS = GraphUriResolver.getClaimsGraph(AGENT);
const ctx = { agentId: AGENT, userId: 'alice', sessionId: 's', isOwner: false };

const FUNCTIONAL_TTL = `
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<${REVISION}> a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:label "current revision" .
`;
const OWNS_TTL = `
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<${OWNS}> a owl:ObjectProperty, owl:FunctionalProperty ;
    rdfs:label "owned device" .
`;

type Probe = { isFunctionalProperty(p: string, agentId: string): Promise<boolean> };

async function newStore(): Promise<OxigraphAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'onto-approval-store-')), port: 0, endpoint: '' } as never);
  return store;
}

let store: OxigraphAdapter;
let engine: KnowledgeEngine;
let manager: OntologyManager;
let dir: string;

const isFunctional = (p: string, e: KnowledgeEngine = engine) =>
  (e as unknown as Probe).isFunctionalProperty(p, AGENT);

async function tripleCount(s: OxigraphAdapter, graph: string): Promise<number> {
  const r = await s.query(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  return Number(r.bindings?.[0]?.n?.value ?? -1);
}

/** Store `subject pred value` and return how many accepted claims the subject has for `pred`. */
async function store2(pred: string, subject: string, ...values: string[]): Promise<number> {
  for (const v of values) {
    await engine.storeFact(
      { subject, subjectType: 'Thing', predicate: pred, object: v, objectType: 'Thing', sourceKind: 'user' },
      ctx,
    );
  }
  const r = await store.query(`SELECT ?c WHERE { GRAPH <${CLAIMS}> {
    ?c <${CORE}claimSubject> <urn:ontofelia:entity:${subject}> ; <${CORE}claimPredicate> <${pred}> ;
       <${CORE}status> "accepted" } }`);
  return r.bindings?.length ?? 0;
}

async function approve(turtle: string, description = 'change'): Promise<string> {
  const id = `t${Date.now()}${Math.floor(Math.random() * 1000)}`;
  await manager.saveProposal({ id, agentId: AGENT, turtlePatch: turtle, description,
    createdAt: new Date().toISOString(), status: 'pending' });
  const v = await manager.approveProposal(id);
  return v.version;
}

beforeEach(async () => {
  store = await newStore();
  engine = new KnowledgeEngine(store as never);
  dir = mkdtempSync(join(tmpdir(), 'onto-approval-dir-'));
  manager = new OntologyManager(AGENT, dir, store as never);
  await manager.initialize(CORE_TTL);
  await manager.syncActiveToStore();
});

describe('approved ontology version reaches the store', () => {
  it('approval makes a declared functional property supersede; rollback restores multi-valued', async () => {
    // Before: not declared, so two values coexist.
    expect(await isFunctional(REVISION)).toBe(false);
    expect(await store2(REVISION, 'Doc1', 'Rev1', 'Rev2')).toBe(2);

    const v1 = await approve(FUNCTIONAL_TTL, 'revision is single-valued');
    expect(v1).toBe('v001');
    expect(await isFunctional(REVISION)).toBe(true);
    // A new value now replaces the old one.
    expect(await store2(REVISION, 'Doc2', 'Rev1', 'Rev2')).toBe(1);

    await manager.rollback('v000');
    expect(await isFunctional(REVISION)).toBe(false);
    expect(await tripleCount(store, ONTOLOGY_GRAPH)).toBe(0);
    expect(await store2(REVISION, 'Doc3', 'Rev1', 'Rev2')).toBe(2);
  });

  it('rolling back to an earlier approved version leaves nothing of the later one', async () => {
    await approve(FUNCTIONAL_TTL);
    await approve(OWNS_TTL);
    // The second version replaces the first: its content is the whole ontology.
    expect(await isFunctional(OWNS)).toBe(true);
    expect(await isFunctional(REVISION)).toBe(false);

    await manager.rollback('v001');
    expect(await isFunctional(REVISION)).toBe(true);
    expect(await isFunctional(OWNS)).toBe(false);
    const labels = await store.query(`SELECT ?l WHERE { GRAPH <${ONTOLOGY_GRAPH}> { ?s <http://www.w3.org/2000/01/rdf-schema#label> ?l } }`);
    expect(labels.bindings?.map((b) => b.l.value)).toEqual(['current revision']);
  });

  it('label lookup and the parser context see the approved property; rollback hides it again', async () => {
    await approve(FUNCTIONAL_TTL);
    const provider = new OntologyContextProvider(store as never, AGENT);
    expect((await provider.getCompact()).properties.map((p) => p.label)).toContain('current revision');
    // The label resolves to the declared URI instead of minting a new predicate.
    expect(await engine.resolveProperty('Current Revision', AGENT)).toEqual({ uri: REVISION, isNew: false });

    await manager.rollback('v000');
    expect((await provider.getCompact()).properties.map((p) => p.label)).not.toContain('current revision');
    expect((await engine.resolveProperty('Current Revision', AGENT)).isNew).toBe(true);
  });

  it('leaves the learned schema graph alone', async () => {
    await engine.resolveProperty('worksAt', AGENT);
    const schema = GraphUriResolver.getSchemaGraph(AGENT);
    const before = await tripleCount(store, schema);
    expect(before).toBeGreaterThan(0);
    await approve(FUNCTIONAL_TTL);
    await manager.rollback('v000');
    expect(await tripleCount(store, schema)).toBe(before);
  });

  it('the ontology graph is a registered graph of the agent', () => {
    expect(GraphRegistry.create([AGENT]).describe(ONTOLOGY_GRAPH)?.role).toBe('ontology');
  });
});

describe('restart', () => {
  it('a new engine on an empty store and the same ontology dir sees the active version', async () => {
    await approve(FUNCTIONAL_TTL);

    const freshStore = await newStore();
    const freshEngine = new KnowledgeEngine(freshStore as never);
    expect(await isFunctional(REVISION, freshEngine)).toBe(false);

    const restarted = new OntologyManager(AGENT, dir, freshStore as never);
    await restarted.initialize(CORE_TTL);
    await restarted.syncActiveToStore();
    expect(await isFunctional(REVISION, freshEngine)).toBe(true);
  });

  it('a restart on the same store does not duplicate the graph', async () => {
    await approve(FUNCTIONAL_TTL);
    const before = await tripleCount(store, ONTOLOGY_GRAPH);
    expect(before).toBeGreaterThan(0);

    const restarted = new OntologyManager(AGENT, dir, store as never);
    await restarted.initialize(CORE_TTL);
    await restarted.syncActiveToStore();
    await restarted.syncActiveToStore();
    expect(await tripleCount(store, ONTOLOGY_GRAPH)).toBe(before);
  });

  it('a rolled-back version stays gone after a restart', async () => {
    await approve(FUNCTIONAL_TTL);
    await manager.rollback('v000');

    const restarted = new OntologyManager(AGENT, dir, store as never);
    await restarted.initialize(CORE_TTL);
    await restarted.syncActiveToStore();
    expect(await isFunctional(REVISION)).toBe(false);
    expect(await tripleCount(store, ONTOLOGY_GRAPH)).toBe(0);
  });
});

describe('failure and compatibility', () => {
  it('invalid Turtle is refused, the previous version stays active and the store is unchanged', async () => {
    await approve(FUNCTIONAL_TTL);
    const before = await tripleCount(store, ONTOLOGY_GRAPH);

    await expect(approve('this is not turtle {{{')).rejects.toThrow();
    expect((await manager.getActiveVersion()).version).toBe('v001');
    expect(await isFunctional(REVISION)).toBe(true);
    expect(await tripleCount(store, ONTOLOGY_GRAPH)).toBe(before);
  });

  it('deleting a graph that does not exist is a no-op on the embedded store', async () => {
    await expect(store.deleteGraph('urn:ontofelia:never-written')).resolves.toBeUndefined();
  });

  it('without a triplestore only the files change', async () => {
    const plainDir = mkdtempSync(join(tmpdir(), 'onto-approval-plain-'));
    const plain = new OntologyManager(AGENT, plainDir);
    await plain.initialize(CORE_TTL);
    await plain.syncActiveToStore();
    await plain.saveProposal({ id: 'x', agentId: AGENT, turtlePatch: FUNCTIONAL_TTL, description: 'd',
      createdAt: new Date().toISOString(), status: 'pending' });
    const v = await plain.approveProposal('x');
    expect(v.version).toBe('v001');
    expect(existsSync(join(plainDir, 'versions', 'v001.ttl'))).toBe(true);
    expect(readFileSync(join(plainDir, 'versions', 'v001.ttl'), 'utf-8')).toContain('FunctionalProperty');
  });
});
