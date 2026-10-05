/**
 * Belief revision records which claim replaced which: the old claim points
 * forward (core:supersededBy, core:supersededAt) and the Conflict names both
 * sides. The claim model is declared in the shipped core ontology.
 * Real round-trips on the embedded OxigraphAdapter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { OntologyContextProvider } from '../ingestion/OntologyContextProvider.js';

const AGENT = 'ontofelia';
const E = 'urn:ontofelia:entity:';
const LIVES = 'urn:ontofelia:core#livesIn';
const CORE = 'urn:shared:ontology#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const CLAIMS = `urn:${AGENT}:claims`;
const CONFLICTS = `urn:${AGENT}:conflicts`;
const ctx = { agentId: AGENT, userId: 'alice', sessionId: 's', isOwner: false };
const TTL = join(dirname(fileURLToPath(import.meta.url)), '..', 'ontologies', 'ontofelia-core.ttl');

let store: OxigraphAdapter;
let engine: KnowledgeEngine;

async function rows(sparql: string): Promise<Array<Record<string, { value: string; datatype?: string }>>> {
  const r: any = await store.query(sparql);
  return r.bindings;
}

const livesIn = (place: string) => engine.storeFact(
  { subject: 'Anna', subjectType: 'Person', predicate: 'livesIn', object: place,
    objectType: 'Place', sourceKind: 'user' },
  ctx,
);

async function claimFor(place: string): Promise<string> {
  const r = await rows(`SELECT ?c WHERE { GRAPH <${CLAIMS}> { ?c <${CORE}claimObject> <${E}${place}> } }`);
  expect(r).toHaveLength(1);
  return r[0].c.value;
}

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'superseded-by-')), port: 0, endpoint: '' } as never);
  engine = new KnowledgeEngine(store as never);
  await store.update(`INSERT DATA { GRAPH <urn:shared:ontology> {
    <${LIVES}> a <${OWL}ObjectProperty>, <${OWL}FunctionalProperty> . } }`);
});

describe('supersession is navigable old -> new', () => {
  it('the old claim records its replacement and the time', async () => {
    await livesIn('Hamburg');
    await livesIn('Berlin');
    const oldClaim = await claimFor('Hamburg');
    const newClaim = await claimFor('Berlin');

    const r = await rows(`SELECT ?by ?at ?st WHERE { GRAPH <${CLAIMS}> {
      <${oldClaim}> <${CORE}supersededBy> ?by ; <${CORE}supersededAt> ?at ; <${CORE}status> ?st } }`);
    expect(r).toHaveLength(1);
    expect(r[0].by.value).toBe(newClaim);
    expect(r[0].st.value).toBe('superseded');
    expect(r[0].at.datatype).toBe('http://www.w3.org/2001/XMLSchema#dateTime');
    expect(Number.isNaN(Date.parse(r[0].at.value))).toBe(false);

    // The replacement itself is a normal accepted claim and carries no pointer.
    const n = await rows(`SELECT ?st WHERE { GRAPH <${CLAIMS}> { <${newClaim}> <${CORE}status> ?st .
      FILTER NOT EXISTS { <${newClaim}> <${CORE}supersededBy> ?x } } }`);
    expect(n.map(b => b.st.value)).toEqual(['accepted']);
  });

  it('the Conflict links the retired and the replacing claim', async () => {
    await livesIn('Hamburg');
    await livesIn('Berlin');
    const oldClaim = await claimFor('Hamburg');
    const newClaim = await claimFor('Berlin');
    const r = await rows(`SELECT ?old ?new WHERE { GRAPH <${CONFLICTS}> {
      ?k a <${CORE}Conflict> ; <${CORE}supersededClaim> ?old ; <${CORE}supersedingClaim> ?new } }`);
    expect(r).toHaveLength(1);
    expect(r[0].old.value).toBe(oldClaim);
    expect(r[0].new.value).toBe(newClaim);
  });

  it('a chain Hamburg -> Berlin -> Munich can be walked forward', async () => {
    await livesIn('Hamburg');
    await livesIn('Berlin');
    await livesIn('Munich');
    const r = await rows(`SELECT ?o WHERE { GRAPH <${CLAIMS}> {
      ?h <${CORE}claimObject> <${E}Hamburg> ; <${CORE}supersededBy>+ ?x . ?x <${CORE}claimObject> ?o } }`);
    expect(r.map(b => b.o.value).sort()).toEqual([`${E}Berlin`, `${E}Munich`]);
  });

  it('a non-functional predicate records no supersession', async () => {
    await engine.storeFact({ subject: 'Anna', subjectType: 'Person', predicate: 'worksAt',
      object: 'Acme', objectType: 'Organization', sourceKind: 'user' }, ctx);
    await engine.storeFact({ subject: 'Anna', subjectType: 'Person', predicate: 'worksAt',
      object: 'BigCorp', objectType: 'Organization', sourceKind: 'user' }, ctx);
    expect(await store.ask(`ASK { GRAPH <${CLAIMS}> { ?c <${CORE}supersededBy> ?x } }`)).toBe(false);
  });
});

describe('the claim model is declared in the core ontology', () => {
  it('declares the classes and the supersession properties', async () => {
    await store.putGraph('urn:test:tbox', readFileSync(TTL, 'utf-8'), 'turtle');
    for (const cls of ['Claim', 'Evidence', 'Conflict']) {
      expect(await store.ask(`ASK { GRAPH <urn:test:tbox> { <${CORE}${cls}> a <${OWL}Class> ; <http://www.w3.org/2000/01/rdf-schema#label> ?l } }`)).toBe(true);
    }
    expect(await store.ask(`ASK { GRAPH <urn:test:tbox> {
      <${CORE}supersededBy> a <${OWL}ObjectProperty> ;
        <http://www.w3.org/2000/01/rdf-schema#domain> <${CORE}Claim> ;
        <http://www.w3.org/2000/01/rdf-schema#range> <${CORE}Claim> .
      <${CORE}supersededAt> a <${OWL}DatatypeProperty> ;
        <http://www.w3.org/2000/01/rdf-schema#range> <http://www.w3.org/2001/XMLSchema#dateTime> } }`)).toBe(true);
  });

  it('every core: term the engine writes is declared', async () => {
    await store.putGraph('urn:test:tbox', readFileSync(TTL, 'utf-8'), 'turtle');
    await livesIn('Hamburg');
    await livesIn('Berlin');
    const used = await rows(`SELECT DISTINCT ?t WHERE {
      { GRAPH <${CLAIMS}> { ?s ?t ?o } } UNION { GRAPH <${CONFLICTS}> { ?s ?t ?o } }
      FILTER(STRSTARTS(STR(?t), "${CORE}")) }`);
    expect(used.length).toBeGreaterThan(8);
    // Terms that describe evidence or optional metadata are out of scope here;
    // the ones that matter for claims and conflicts must be declared.
    const mustDeclare = used.map(b => b.t.value).filter(t => !/(learnedAt|acceptedAt|confidence|confidenceLabel|sourceKind|ingestionRunId|sessionId|sourceMessageId|sourceSpan|hasEvidence|evidenceGraph|targetGraph)$/.test(t));
    for (const t of mustDeclare) {
      expect(await store.ask(`ASK { GRAPH <urn:test:tbox> { <${t}> a ?k } }`), t).toBe(true);
    }
  });

  it('bookkeeping terms stay out of the parser\'s entity types and properties', async () => {
    await store.putGraph('urn:shared:ontology', readFileSync(TTL, 'utf-8'), 'turtle');
    const c = await new OntologyContextProvider(store as never).getCompact();
    expect(c.classes).not.toContain('Claim');
    expect(c.classes).not.toContain('Conflict');
    expect(c.classes).toContain('Person');
    expect(c.properties.map(p => p.name)).not.toContain('supersededBy');
  });
});
