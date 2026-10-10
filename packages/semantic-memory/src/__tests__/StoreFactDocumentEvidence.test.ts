/**
 * storeFact records evidence for document sources (sourceUri, evidenceType,
 * contentHash), keeps the message-span default for chat facts, and never lets
 * a hostile sourceUri / contentHash inject triples.
 * Real round-trips on the embedded OxigraphAdapter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import type { FactInput } from '../types.js';

const AGENT = 'ontofelia';
const CORE = 'urn:shared:ontology#';
const CLAIMS = `urn:${AGENT}:claims`;
const EVIDENCE = `urn:${AGENT}:evidence`;
const ctx = { agentId: AGENT, userId: 'alice', sessionId: 's', isOwner: false };

let store: OxigraphAdapter;
let engine: KnowledgeEngine;

async function rows(sparql: string): Promise<Array<Record<string, { value: string }>>> {
  const r = await store.query(sparql);
  return r.bindings ?? [];
}

const countAll = async (): Promise<number> =>
  Number((await rows('SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }'))[0].n.value);

const fact = (extra: Partial<FactInput>): FactInput => ({
  subject: 'Chickpeas', subjectType: 'Concept', predicate: 'isA', object: 'Legume',
  objectType: 'Concept', sourceKind: 'tool', ...extra,
});

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'doc-evidence-')), port: 0, endpoint: '' } as never);
  engine = new KnowledgeEngine(store as never);
});

describe('storeFact evidence', () => {
  it('document fact gets one document evidence with sourceUri and contentHash', async () => {
    await engine.storeFact(fact({
      evidenceType: 'document',
      sourceUri: 'vault://demo/notes/Chickpeas.md',
      contentHash: 'sha256:abc123',
    }), ctx);

    const ev = await rows(`SELECT ?e ?t ?u ?h WHERE { GRAPH <${EVIDENCE}> {
      ?e <${CORE}evidenceType> ?t ; <${CORE}sourceUri> ?u ; <${CORE}contentHash> ?h } }`);
    expect(ev).toHaveLength(1);
    expect(ev[0].t.value).toBe('document');
    expect(ev[0].u.value).toBe('vault://demo/notes/Chickpeas.md');
    expect(ev[0].h.value).toBe('sha256:abc123');
    expect(await rows(`SELECT ?e WHERE { GRAPH <${EVIDENCE}> { ?e a <${CORE}Evidence> } }`)).toHaveLength(1);

    const link = await rows(`SELECT ?e WHERE { GRAPH <${CLAIMS}> { ?c <${CORE}hasEvidence> ?e } }`);
    expect(link).toHaveLength(1);
    expect(link[0].e.value).toBe(ev[0].e.value);
  });

  it('chat fact with only sourceSpan keeps the message-span type', async () => {
    await engine.storeFact(fact({ sourceKind: 'user', sourceSpan: 'chickpeas are legumes' }), ctx);
    const ev = await rows(`SELECT ?t ?u ?h WHERE { GRAPH <${EVIDENCE}> { ?e <${CORE}evidenceType> ?t .
      OPTIONAL { ?e <${CORE}sourceUri> ?u } OPTIONAL { ?e <${CORE}contentHash> ?h } } }`);
    expect(ev).toHaveLength(1);
    expect(ev[0].t.value).toBe('message-span');
    expect(ev[0].u).toBeUndefined();
    expect(ev[0].h).toBeUndefined();
  });

  it('fact without any source creates no evidence and no hasEvidence link', async () => {
    await engine.storeFact(fact({}), ctx);
    expect(await rows(`SELECT ?e WHERE { GRAPH <${EVIDENCE}> { ?e ?p ?o } }`)).toHaveLength(0);
    expect(await rows(`SELECT ?c WHERE { GRAPH <${CLAIMS}> { ?c <${CORE}claimSubject> ?s } }`)).toHaveLength(1);
    expect(await rows(`SELECT ?c WHERE { GRAPH <${CLAIMS}> { ?c <${CORE}hasEvidence> ?e } }`)).toHaveLength(0);
  });
});

describe('hostile evidence values cannot inject triples', () => {
  it('a hostile sourceUri is rejected before anything is written', async () => {
    const before = await countAll();
    await expect(engine.storeFact(fact({
      evidenceType: 'document',
      sourceUri: 'vault://x> . <urn:x> <urn:y> "z',
    }), ctx)).rejects.toThrow(/Invalid sourceUri/);
    await expect(engine.storeFact(fact({ sourceUri: 'vault://a b' }), ctx)).rejects.toThrow(/Invalid sourceUri/);
    expect(await countAll()).toBe(before);
    expect(await rows('SELECT ?s WHERE { GRAPH ?g { ?s <urn:y> ?o } }')).toHaveLength(0);
  });

  it('a hostile contentHash is stored as one escaped literal', async () => {
    const evil = 'sha256:x" . <urn:x> <urn:y> "z';
    await engine.storeFact(fact({ evidenceType: 'document', sourceUri: 'vault://demo/a.md', contentHash: evil }), ctx);
    expect(await rows('SELECT ?s WHERE { GRAPH ?g { ?s <urn:y> ?o } }')).toHaveLength(0);
    expect(await rows('SELECT ?s WHERE { GRAPH ?g { <urn:x> ?p ?o } }')).toHaveLength(0);
    const h = await rows(`SELECT ?h WHERE { GRAPH <${EVIDENCE}> { ?e <${CORE}contentHash> ?h } }`);
    expect(h).toHaveLength(1);
    expect(h[0].h.value).toBe(evil);
  });
});
