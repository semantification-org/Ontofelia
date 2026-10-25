/**
 * A goal's cogt:goalType is written as the IRI of a goal-type class
 * (GoalStack, Metacognition), so the shipped core ontology must declare it an
 * object property, without an rdfs:range that would type the class as an
 * instance. Real round-trip on the embedded OxigraphAdapter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createOxigraphTestAdapter, type OxigraphTestAdapter } from './helpers/oxigraphTestAdapter.js';

const COGT = 'urn:shared:ontology#cog/';
const OWL = 'http://www.w3.org/2002/07/owl#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const TTL = join(dirname(fileURLToPath(import.meta.url)), '..', 'ontologies', 'ontofelia-core.ttl');

let store: OxigraphTestAdapter;

beforeEach(async () => {
  store = createOxigraphTestAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'goal-type-tbox-')), port: 0, endpoint: '' } as never);
  await store.putGraph('urn:test:tbox', readFileSync(TTL, 'utf-8'), 'turtle');
});

describe('cogt:goalType in the core ontology', () => {
  it('is an object property on goals', async () => {
    expect(await store.ask(`ASK { GRAPH <urn:test:tbox> {
      <${COGT}goalType> a <${OWL}ObjectProperty> ; <${RDFS}domain> <${COGT}Goal> } }`)).toBe(true);
  });

  it('is not a datatype property and has no range', async () => {
    expect(await store.ask(`ASK { GRAPH <urn:test:tbox> { <${COGT}goalType> a <${OWL}DatatypeProperty> } }`)).toBe(false);
    expect(await store.ask(`ASK { GRAPH <urn:test:tbox> { <${COGT}goalType> <${RDFS}range> ?r } }`)).toBe(false);
  });

  it('takes the goal-type classes the code writes as values', async () => {
    for (const t of ['RespondToUser', 'ResolveConflict', 'OwnerRequestedWork']) {
      expect(await store.ask(`ASK { GRAPH <urn:test:tbox> { <${COGT}${t}> <${RDFS}subClassOf> <${COGT}GoalType> } }`), t).toBe(true);
    }
  });
});
