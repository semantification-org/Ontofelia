/**
 * Label and entity lookups must stay inside the graphs the acting agent/user
 * may read: the agent worldview, the acting user's own graph, the shared
 * ontology and the agent schema graph. A private graph of ANOTHER user must
 * never contribute labels, reusable entities or conflicts.
 *
 * Real round-trips on the embedded OxigraphAdapter (empty default graph).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { ConflictDetector } from '../reasoning/ConflictDetector.js';

const AGENT = 'ontofelia';
const E = 'urn:ontofelia:entity:';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL_DISJOINT = 'http://www.w3.org/2002/07/owl#disjointWith';
const BOB_GRAPH = `urn:${AGENT}:user:bob`;
const ALICE_GRAPH = `urn:${AGENT}:user:alice`;
const WORLDVIEW = `urn:${AGENT}:worldview`;
const ONTOLOGY = 'urn:shared:ontology';

async function makeStore(): Promise<OxigraphAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'scoping-')),
    port: 0,
    endpoint: '',
  });
  return store;
}

async function insert(store: OxigraphAdapter, graph: string, triples: string): Promise<void> {
  await store.update(`INSERT DATA { GRAPH <${graph}> { ${triples} } }`);
}

const aliceCtx = { agentId: AGENT, userId: 'alice', sessionId: 's1', isOwner: false };

describe('recall labels are scoped to the acting user', () => {
  let store: OxigraphAdapter;
  let engine: KnowledgeEngine;

  beforeEach(async () => {
    store = await makeStore();
    engine = new KnowledgeEngine(store as never);
    await engine.storeFact(
      { subject: 'Anna', subjectType: 'Person', predicate: 'livesIn',
        object: 'Hamburg', objectType: 'Place', sourceKind: 'user' },
      aliceCtx,
    );
    // A label for the SAME entity that exists only in Bob's private graph.
    await insert(store, BOB_GRAPH, `<${E}Hamburg> <${RDFS_LABEL}> "BOBS-PRIVATE-NAME-FOR-IT" .`);
  });

  it('getFactsAbout does not use another user\'s label, still resolves own and predicate labels', async () => {
    const facts = await engine.getFactsAbout(['Anna'], AGENT, 20, 'alice');
    expect(facts).not.toContain('BOBS-PRIVATE-NAME-FOR-IT');
    expect(facts).toContain('Anna livesIn Hamburg');
  });

  it('getRecentFacts does not use another user\'s label', async () => {
    const facts = await engine.getRecentFacts(AGENT, 30, 'alice');
    expect(facts).not.toContain('BOBS-PRIVATE-NAME-FOR-IT');
    expect(facts).toContain('Hamburg');
    expect(facts.toLowerCase()).toContain('lives');
  });

  it('the label owner still sees his own label', async () => {
    const facts = await engine.getFactsAbout(['Anna'], AGENT, 20, 'bob');
    expect(facts).toContain('BOBS-PRIVATE-NAME-FOR-IT');
  });

  it('predicate labels from the shared ontology resolve', async () => {
    await insert(store, ONTOLOGY, `<urn:ontofelia:core#knowsWell> <${RDFS_LABEL}> "is well acquainted with" .`);
    await insert(store, WORLDVIEW, `<${E}Anna> <urn:ontofelia:core#knowsWell> <${E}Hamburg> .`);
    const facts = await engine.getFactsAbout(['Anna'], AGENT, 20, 'alice');
    expect(facts).toContain('is well acquainted with');
    expect(facts).not.toContain('BOBS-PRIVATE-NAME-FOR-IT');
  });
});

describe('entity reuse by label is scoped to the acting user', () => {
  let store: OxigraphAdapter;
  let engine: KnowledgeEngine;

  beforeEach(async () => {
    store = await makeStore();
    engine = new KnowledgeEngine(store as never);
  });

  it('an entity that exists only in another user\'s graph is not reused', async () => {
    await insert(store, BOB_GRAPH,
      `<${E}Quux_bobs> <${RDF_TYPE}> <urn:ontofelia:core#Person> . <${E}Quux_bobs> <${RDFS_LABEL}> "Quux" .`);
    const res = await engine.resolveEntity('Quux', 'Person', ALICE_GRAPH, undefined,
      { agentId: AGENT, userId: 'alice' });
    expect(res.uri).not.toBe(`${E}Quux_bobs`);
    expect(res.isNew).toBe(true);
  });

  it('an entity in the worldview is reused', async () => {
    await insert(store, WORLDVIEW,
      `<${E}Quux_shared> <${RDF_TYPE}> <urn:ontofelia:core#Person> . <${E}Quux_shared> <${RDFS_LABEL}> "Quux" .`);
    const res = await engine.resolveEntity('Quux', 'Person', ALICE_GRAPH, undefined,
      { agentId: AGENT, userId: 'alice' });
    expect(res).toEqual({ uri: `${E}Quux_shared`, isNew: false });
  });

  it('an entity in the user\'s own graph is reused', async () => {
    await insert(store, ALICE_GRAPH,
      `<${E}Quux_alices> <${RDF_TYPE}> <urn:ontofelia:core#Person> . <${E}Quux_alices> <${RDFS_LABEL}> "Quux" .`);
    const res = await engine.resolveEntity('Quux', 'Person', ALICE_GRAPH, undefined,
      { agentId: AGENT, userId: 'alice' });
    expect(res).toEqual({ uri: `${E}Quux_alices`, isNew: false });
  });

  it('a slug URI typed only in another user\'s graph does not count as taken', async () => {
    // Bob has "Paris" the Place; Alice's "Paris" the Person must get the plain
    // slug minted in HER graph rather than a suffix derived from Bob's data.
    await insert(store, BOB_GRAPH,
      `<${E}Paris> <${RDF_TYPE}> <urn:ontofelia:core#Place> . <${E}Paris> <${RDFS_LABEL}> "Paris" .`);
    const res = await engine.resolveEntity('Paris', 'Person', ALICE_GRAPH, undefined,
      { agentId: AGENT, userId: 'alice' });
    expect(res).toEqual({ uri: `${E}Paris`, isNew: true });
    const typed = await store.ask(
      `ASK { GRAPH <${ALICE_GRAPH}> { <${E}Paris> <${RDF_TYPE}> <urn:ontofelia:core#Person> } }`);
    expect(typed).toBe(true);
  });

  it('storeFact threads the acting user into the lookup', async () => {
    await insert(store, BOB_GRAPH,
      `<${E}Quux_bobs> <${RDF_TYPE}> <urn:ontofelia:core#Person> . <${E}Quux_bobs> <${RDFS_LABEL}> "Quux" .`);
    await engine.storeFact(
      { subject: 'Quux', subjectType: 'Person', predicate: 'likes', object: 'tea',
        objectType: 'literal', sourceKind: 'user' },
      aliceCtx,
    );
    const onBob = await store.ask(`ASK { GRAPH ?g { <${E}Quux_bobs> <urn:ontofelia:core#likes> ?o } }`);
    expect(onBob).toBe(false);
    const aliceFacts = await engine.getFactsAbout(['Quux'], AGENT, 20, 'alice');
    expect(aliceFacts).toContain('tea');
  });
});

describe('ConflictDetector is scoped to worldview + the given user', () => {
  let store: OxigraphAdapter;
  let detector: ConflictDetector;

  beforeEach(async () => {
    store = await makeStore();
    detector = new ConflictDetector(store as never);
    await insert(store, ONTOLOGY,
      `<urn:ontofelia:core#Person> <${OWL_DISJOINT}> <urn:ontofelia:core#Animal> .`);
  });

  const typedBoth = (s: string) =>
    `<${E}${s}> <${RDF_TYPE}> <urn:ontofelia:core#Person> . <${E}${s}> <${RDF_TYPE}> <urn:ontofelia:core#Animal> .`;

  it('a violation that exists only in another user\'s graph is not reported', async () => {
    await insert(store, BOB_GRAPH, typedBoth('BobsThing'));
    const forAlice = await detector.detectConflicts(AGENT, 'alice');
    expect(forAlice.filter(c => c.type === 'disjoint_violation')).toHaveLength(0);
    const worldviewOnly = await detector.detectConflicts(AGENT);
    expect(worldviewOnly.filter(c => c.type === 'disjoint_violation')).toHaveLength(0);
  });

  it('the owning user, the user\'s own graph and the worldview are still checked', async () => {
    await insert(store, BOB_GRAPH, typedBoth('BobsThing'));
    await insert(store, WORLDVIEW, typedBoth('SharedThing'));
    await insert(store, ALICE_GRAPH, typedBoth('AlicesThing'));
    const subjectsFor = async (u?: string) =>
      (await detector.detectConflicts(AGENT, u))
        .filter(c => c.type === 'disjoint_violation').flatMap(c => c.subjects).sort();
    expect(await subjectsFor('alice')).toEqual([`${E}AlicesThing`, `${E}SharedThing`]);
    expect(await subjectsFor('bob')).toEqual([`${E}BobsThing`, `${E}SharedThing`]);
    expect(await subjectsFor(undefined)).toEqual([`${E}SharedThing`]);
  });

  it('range violations in another user\'s graph are not reported', async () => {
    await insert(store, ONTOLOGY, `<urn:ontofelia:core#owns> <http://www.w3.org/2000/01/rdf-schema#range> <urn:ontofelia:core#Thing> .`);
    await insert(store, BOB_GRAPH, `<${E}Bob> <urn:ontofelia:core#owns> <${E}Untyped> .`);
    await insert(store, WORLDVIEW, `<${E}Wv> <urn:ontofelia:core#owns> <${E}Untyped2> .`);
    const range = (await detector.detectConflicts(AGENT, 'alice')).filter(c => c.type === 'range_violation');
    expect(range.map(c => c.subjects[0])).toEqual([`${E}Wv`]);
  });
});

describe('claim supersession and clashes stay inside one graph', () => {
  const LIVES = 'urn:ontofelia:core#livesIn';
  const CORE = 'urn:shared:ontology#';
  let store: OxigraphAdapter;
  let engine: KnowledgeEngine;

  async function claimStatus(obj: string): Promise<string[]> {
    const r = await store.query(
      `SELECT ?st WHERE { GRAPH <urn:${AGENT}:claims> { ?c <${CORE}claimObject> <${E}${obj}> ; <${CORE}status> ?st } }`);
    return ((r as unknown as { bindings: Array<{ st: { value: string } }> }).bindings).map(b => b.st.value);
  }

  beforeEach(async () => {
    store = await makeStore();
    engine = new KnowledgeEngine(store as never);
    await insert(store, ONTOLOGY,
      `<${LIVES}> a <http://www.w3.org/2002/07/owl#ObjectProperty>, <http://www.w3.org/2002/07/owl#FunctionalProperty> .`);
    // Bob's private graph and its claim talk about the shared entity Anna.
    await insert(store, BOB_GRAPH, `<${E}Anna> <${LIVES}> <${E}Bremen> .`);
    await insert(store, `urn:${AGENT}:claims`,
      `<urn:claim:bob1> a <${CORE}Claim> ; <${CORE}claimSubject> <${E}Anna> ;
         <${CORE}claimPredicate> <${LIVES}> ; <${CORE}claimObject> <${E}Bremen> ;
         <${CORE}assertedInGraph> <${BOB_GRAPH}> ; <${CORE}status> "accepted" .`);
  });

  const aliceLivesIn = (place: string) => engine.storeFact(
    { subject: 'Anna', subjectType: 'Person', predicate: 'livesIn', object: place,
      objectType: 'Place', sourceKind: 'agent' },
    aliceCtx,
  );

  it('a fact written for Alice does not supersede a claim asserted in Bob\'s graph', async () => {
    const res = await aliceLivesIn('Hamburg');
    expect(res.success).toBe(true);
    expect(await claimStatus('Bremen')).toEqual(['accepted']);
    expect(await store.ask(`ASK { GRAPH <${BOB_GRAPH}> { <${E}Anna> <${LIVES}> <${E}Bremen> } }`)).toBe(true);
  });

  it('a conflicting fact within the SAME graph still supersedes', async () => {
    await aliceLivesIn('Hamburg');
    await aliceLivesIn('Koeln');
    expect(await claimStatus('Hamburg')).toEqual(['superseded']);
    expect(await store.ask(`ASK { GRAPH <${WORLDVIEW}> { <${E}Anna> <${LIVES}> <${E}Hamburg> } }`)).toBe(false);
    expect(await store.ask(`ASK { GRAPH <${WORLDVIEW}> { <${E}Anna> <${LIVES}> <${E}Koeln> } }`)).toBe(true);
  });

  it('claim clashes are only reported within worldview + the given user', async () => {
    await aliceLivesIn('Hamburg');
    const detector = new ConflictDetector(store as never);
    const clashes = async (u?: string) =>
      (await detector.detectConflicts(AGENT, u)).filter(c => c.type === 'claim_clash');
    expect(await clashes('alice')).toHaveLength(0);
    expect(await clashes(undefined)).toHaveLength(0);
    expect(await clashes('bob')).toHaveLength(1);
  });
});
