/**
 * importVault: dry run writes nothing, schema notes are refused, re-import is
 * idempotent, and a vault never supersedes claims that did not come from it.
 * Real round-trips on the embedded OxigraphAdapter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, cpSync, symlinkSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { importVault, type VaultImportReport } from '../ingestion/VaultImporter.js';

const AGENT = 'ontofelia';
const CORE = 'urn:shared:ontology#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault');

let store: OxigraphAdapter;
let engine: KnowledgeEngine;
let root: string;

async function rows(sparql: string): Promise<Array<Record<string, { value: string }>>> {
  const r = await store.query(sparql);
  return r.bindings ?? [];
}
const countAll = async (): Promise<number> =>
  Number((await rows('SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }'))[0].n.value);
const status = (r: VaultImportReport, p: string): string | undefined => r.notes.find(n => n.path === p)?.status;
const run = (apply: boolean, extra: object = {}): Promise<VaultImportReport> =>
  importVault(engine, { root, vaultName: 'demo', agentId: AGENT, apply, ...extra });

const HUMMUS = 'Recipes/hummus.md';
const IMPORTED = [HUMMUS, 'Ingredients/Chickpeas.md', 'Vocabularies/Beginner.md'];

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'vimp-')), port: 0, endpoint: '' } as never);
  engine = new KnowledgeEngine(store as never);
  await store.update(`INSERT DATA { GRAPH <urn:shared:ontology> {
    <urn:ontofelia:core#prepTimeMinutes> a <${OWL}DatatypeProperty>, <${OWL}FunctionalProperty> . } }`);
  root = mkdtempSync(join(tmpdir(), 'vault-'));
  cpSync(FIXTURE, root, { recursive: true });
  const outside = join(mkdtempSync(join(tmpdir(), 'outside-')), 'secret.md');
  writeFileSync(outside, '---\ntype: "[[Recipe]]"\n---\nOutside.\n');
  symlinkSync(outside, join(root, 'Link.md'));
});

describe('importVault', () => {
  it('dry run classifies notes and writes nothing', async () => {
    const before = await countAll();
    const r = await run(false);
    for (const p of IMPORTED) expect(status(r, p)).toBe('would-import');
    expect(r.notes.find(n => n.path === 'Ontologies/Recipe.md')).toMatchObject({
      status: 'refused', reason: 'schema note (not imported as facts)',
    });
    expect(r.notes.find(n => n.path === 'Plain.md')).toMatchObject({ status: 'refused', reason: 'no frontmatter' });
    expect(status(r, 'Link.md')).toBe('skipped');
    expect(r.notes.find(n => n.path === HUMMUS)!.facts.every(f => f.outcome === 'would-store')).toBe(true);
    expect(r.notes.map(n => n.path)).toEqual([...r.notes.map(n => n.path)].sort());
    expect(await countAll()).toBe(before);
  });

  it('apply stores into the worldview with vault evidence and no user graph', async () => {
    const r = await run(true);
    for (const p of IMPORTED) expect(status(r, p)).toBe('imported');
    expect(r.totals.stored).toBeGreaterThan(0);
    const wv = await rows(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:${AGENT}:worldview> { ?s ?p ?o } }`);
    expect(Number(wv[0].n.value)).toBeGreaterThan(0);
    const user = await rows(`SELECT ?g WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?g), "urn:${AGENT}:user:")) } LIMIT 1`);
    expect(user).toHaveLength(0);
    const hash = 'sha256:' + createHash('sha256').update(readFileSync(join(root, HUMMUS))).digest('hex');
    const ev = await rows(`SELECT ?c ?u ?h WHERE {
      GRAPH <urn:${AGENT}:claims> { ?c <${CORE}hasEvidence> ?e }
      GRAPH <urn:${AGENT}:evidence> { ?e <${CORE}sourceUri> ?u ; <${CORE}contentHash> ?h }
      FILTER(STRSTARTS(STR(?u), "vault://demo/Recipes/")) }`);
    expect(ev.length).toBeGreaterThan(0);
    for (const row of ev) {
      expect(row.u.value).toBe('vault://demo/Recipes/hummus.md');
      expect(row.h.value).toBe(hash);
    }
  });

  it('re-import of unchanged notes is a no-op', async () => {
    await run(true);
    const before = await countAll();
    const r = await run(true);
    for (const p of IMPORTED) expect(status(r, p)).toBe('unchanged');
    expect(r.totals.stored).toBeUndefined();
    expect(await countAll()).toBe(before);
  });

  it('a changed note supersedes its own earlier vault claim', async () => {
    await run(true);
    writeFileSync(join(root, HUMMUS), readFileSync(join(root, HUMMUS), 'utf8').replace('prepTimeMinutes: 25', 'prepTimeMinutes: 30'));
    const r = await run(true);
    expect(status(r, HUMMUS)).toBe('imported');
    expect(r.notes.find(n => n.path === HUMMUS)!.facts.find(f => f.predicate === 'prepTimeMinutes')!.outcome).toBe('stored');
    const claims = await rows(`SELECT ?o ?s WHERE { GRAPH <urn:${AGENT}:claims> {
      ?c <${CORE}claimPredicate> ?p ; <${CORE}claimObject> ?o ; <${CORE}status> ?s .
      FILTER(CONTAINS(STR(?p), "prepTimeMinutes")) } }`);
    const accepted = claims.filter(c => /accepted/i.test(c.s.value));
    expect(accepted.map(c => c.o.value.replace(/"/g, ''))).toEqual(['30']);
    expect(claims.length).toBeGreaterThan(1);
  });

  it('never supersedes a user-learned claim', async () => {
    const ctx = { agentId: AGENT, userId: 'alice', sessionId: 's', isOwner: false };
    await engine.storeFact({
      subject: 'hummus', subjectType: 'Concept', predicate: 'prepTimeMinutes', object: '10',
      objectType: 'literal', sourceKind: 'user', status: 'accepted',
    }, { ...ctx, userId: undefined } as never);
    const r = await run(true);
    const f = r.notes.find(n => n.path === HUMMUS)!.facts.find(x => x.predicate === 'prepTimeMinutes')!;
    expect(f.outcome).toBe('blocked-supersede');
    const accepted = await rows(`SELECT ?o WHERE { GRAPH <urn:${AGENT}:claims> {
      ?c <${CORE}claimPredicate> ?p ; <${CORE}claimObject> ?o ; <${CORE}status> ?s .
      FILTER(CONTAINS(STR(?p), "prepTimeMinutes") && CONTAINS(LCASE(STR(?s)), "accepted")) } }`);
    expect(accepted.map(c => c.o.value.replace(/"/g, ''))).toEqual(['10']);
  });

  it('rejects a bad vault name and an oversized vault before any write', async () => {
    await expect(run(true, { vaultName: 'bad name!' })).rejects.toThrow(/vaultName/);
    const before = await countAll();
    await expect(run(true, { maxFiles: 1 })).rejects.toThrow(/maxFiles/);
    expect(await countAll()).toBe(before);
  });
});
