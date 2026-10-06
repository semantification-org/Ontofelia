/**
 * previewFacts is strictly read-only and agrees with what storeFact then does;
 * a mapped Vault-LD note stores into the worldview with document evidence.
 * Real round-trips on the embedded OxigraphAdapter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { mapVaultNote } from '../ingestion/VaultNoteMapper.js';
import type { FactInput } from '../types.js';

const AGENT = 'ontofelia';
const CORE = 'urn:shared:ontology#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const CLAIMS = `urn:${AGENT}:claims`;
const EVIDENCE = `urn:${AGENT}:evidence`;
const WORLDVIEW = `urn:${AGENT}:worldview`;
const ctx = { agentId: AGENT, userId: 'alice', sessionId: 's', isOwner: false };

let store: OxigraphAdapter;
let engine: KnowledgeEngine;

async function rows(sparql: string): Promise<Array<Record<string, { value: string }>>> {
  const r = await store.query(sparql);
  return r.bindings ?? [];
}
const countAll = async (): Promise<number> =>
  Number((await rows('SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }'))[0].n.value);

const fact = (predicate: string, object: string, extra: Partial<FactInput> = {}): FactInput => ({
  subject: 'Anna', subjectType: 'Person', predicate, object, objectType: 'Place', sourceKind: 'tool', ...extra,
});

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'preview-')), port: 0, endpoint: '' } as never);
  engine = new KnowledgeEngine(store as never);
  await store.update(`INSERT DATA { GRAPH <urn:shared:ontology> {
    <urn:ontofelia:core#livesIn> a <${OWL}ObjectProperty>, <${OWL}FunctionalProperty> . } }`);
});

describe('previewFacts', () => {
  it('reports supersession for a functional predicate and writes nothing', async () => {
    await engine.storeFact(fact('livesIn', 'Hamburg'), ctx);
    const old = await rows(`SELECT ?c WHERE { GRAPH <${CLAIMS}> { ?c <${CORE}claimObject> ?o } }`);
    expect(old).toHaveLength(1);

    const before = await countAll();
    const [p] = await engine.previewFacts([fact('livesIn', 'Berlin')], ctx);
    expect(p.duplicate).toBe(false);
    expect(p.targetGraph).toBe(WORLDVIEW);
    expect(p.wouldSupersede).toEqual([old[0].c.value]);
    expect(await countAll()).toBe(before);
  });

  it('flags an identical fact as duplicate', async () => {
    await engine.storeFact(fact('livesIn', 'Hamburg'), ctx);
    const before = await countAll();
    const [p] = await engine.previewFacts([fact('livesIn', 'Hamburg')], ctx);
    expect(p).toMatchObject({ duplicate: true, wouldSupersede: [] });
    expect(await countAll()).toBe(before);
  });

  it('predicts nothing to supersede for non-functional or unknown predicates, writing nothing', async () => {
    await engine.storeFact(fact('visited', 'Hamburg'), ctx);
    const before = await countAll();
    const out = await engine.previewFacts([
      fact('visited', 'Berlin'),             // known, non-functional
      fact('neverSeenBefore', 'Berlin'),     // predicate does not exist yet
      { ...fact('type', 'Person'), subject: 'NewThing', subjectType: 'Concept', objectType: 'Concept' },
    ], ctx);
    expect(out.map(p => p.wouldSupersede)).toEqual([[], [], []]);
    expect(out.map(p => p.duplicate)).toEqual([false, false, false]);
    expect(await countAll()).toBe(before);
  });
});

describe('vault note end to end', () => {
  it('stores a mapped note into the worldview with document evidence', async () => {
    const mapping = mapVaultNote({
      path: 'Recipes/hummus.md',
      frontmatter: { type: '[[Recipe]]', requiresIngredient: '[[Chickpeas]]', difficulty: '[[Beginner]]', prepTimeMinutes: 25 },
      body: '# Hummus', contentHash: 'sha256:abc', vaultName: 'demo',
    });
    const vctx = { agentId: AGENT, sessionId: 'vault-import', isOwner: false };

    const before = await countAll();
    const preview = await engine.previewFacts(mapping.facts, vctx);
    expect(preview.every(p => p.targetGraph === WORLDVIEW && !p.duplicate)).toBe(true);
    expect(await countAll()).toBe(before);

    for (const f of mapping.facts) {
      const res = await engine.storeFact(f, vctx);
      expect(res.success).toBe(true);
      expect(res.tripleCount).toBeGreaterThan(0);
    }
    const claims = await rows(`SELECT ?c ?g WHERE { GRAPH <${CLAIMS}> { ?c <${CORE}assertedInGraph> ?g } }`);
    expect(claims).toHaveLength(4);
    expect(claims.every(c => c.g.value === WORLDVIEW)).toBe(true);
    expect(await rows(`SELECT ?o WHERE { GRAPH <urn:${AGENT}:user:alice> { ?s ?p ?o } }`)).toHaveLength(0);

    const ev = await rows(`SELECT ?c ?t ?u ?h WHERE { GRAPH <${CLAIMS}> { ?c <${CORE}hasEvidence> ?e }
      GRAPH <${EVIDENCE}> { ?e <${CORE}evidenceType> ?t ; <${CORE}sourceUri> ?u ; <${CORE}contentHash> ?h } }`);
    expect(ev).toHaveLength(4);
    for (const e of ev) {
      expect(e.t.value).toBe('document');
      expect(e.u.value).toBe('vault://demo/Recipes/hummus.md');
      expect(e.h.value).toBe('sha256:abc');
    }
  });
});
