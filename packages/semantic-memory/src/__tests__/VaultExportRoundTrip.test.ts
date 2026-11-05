/**
 * writeVaultExport: files on disk, safety rules, and the round trip
 * export -> folder -> importVault into a FRESH store. Real engine on the
 * embedded OxigraphAdapter, real files under a unique temp dir.
 *
 * Subjects: the importer names an entity by its label and mints its IRI from
 * it, so subject and object IRIs of the fresh store are not guaranteed to be
 * the source IRIs (a vault holds names, not IRIs). Facts are therefore
 * compared as (subject label, predicate local name, object kind + label or
 * literal text). An unlabelled absolute IRI object is compared by its IRI,
 * which is also what the importer labels it with.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, lstatSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { createOxigraphTestAdapter, type OxigraphTestAdapter } from './helpers/oxigraphTestAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { importVault } from '../ingestion/VaultImporter.js';
import { buildVaultExport, writeVaultExport } from '../export/VaultExporter.js';

const AGENT = 'ontofelia';
const WV = `urn:${AGENT}:worldview`;
const CLAIMS = `urn:${AGENT}:claims`;
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const SKOS_CONCEPT = 'http://www.w3.org/2004/02/skos/core#Concept';
const SKOS_BROADER = 'http://www.w3.org/2004/02/skos/core#Broader';
const HOSTILE = 'Ho"stile\nlabel/../x>y';
const tmpDirs: string[] = [];
const freshTmp = (p: string): string => { const d = mkdtempSync(join(tmpdir(), p)); tmpDirs.push(d); return d; };

async function newEngine(prefix: string): Promise<{ store: OxigraphTestAdapter; engine: KnowledgeEngine }> {
  const store = createOxigraphTestAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: freshTmp(prefix), port: 0, endpoint: '' } as never);
  return { store, engine: new KnowledgeEngine(store as never) };
}

// A vault-import context: the facts below carry a `vault://` sourceUri, exactly the
// provenance the importer records and the export requires.
const ctx = { agentId: AGENT, sessionId: 'seed', isOwner: false, ingestionRunId: 'vault-import-seed' };
type Seed = { s: string; p: string; o: string; lit?: boolean };

async function seed(engine: KnowledgeEngine, facts: Seed[]): Promise<void> {
  for (const f of facts) {
    const r = await engine.storeFact({
      subject: f.s, subjectType: 'Concept', predicate: f.p, object: f.o,
      objectType: f.lit ? 'literal' : 'Concept', sourceKind: 'tool', status: 'accepted',
      evidenceType: 'document', sourceUri: 'vault://seed/seed.md', contentHash: 'sha256:seed',
    } as never, ctx);
    expect(r.success).toBe(true);
  }
}

/** Allow-listed facts of a store, normalised as described in the file comment. */
async function factSet(engine: KnowledgeEngine, stripLang: boolean): Promise<string[]> {
  const rows = await engine.selectExplicitGraphs(`SELECT DISTINCT ?s ?p ?o WHERE {
    GRAPH <${CLAIMS}> { ?c a <urn:shared:ontology#Claim> ; <urn:shared:ontology#status> "accepted" ;
      <urn:shared:ontology#assertedInGraph> <${WV}> ;
      <urn:shared:ontology#hasEvidence> ?e ;
      <urn:shared:ontology#claimSubject> ?s ; <urn:shared:ontology#claimPredicate> ?p ;
      <urn:shared:ontology#claimObject> ?o }
    GRAPH <urn:${AGENT}:evidence> { ?e <urn:shared:ontology#sourceUri> ?u }
    FILTER(STRSTARTS(STR(?u), "vault://"))
    GRAPH <${WV}> { ?s ?p ?o } }`);
  const labelRows = await engine.selectExplicitGraphs(`SELECT ?e ?l WHERE { GRAPH <${WV}> { ?e <${RDFS_LABEL}> ?l } }`);
  const label = new Map(labelRows.map(r => [r.e.value, r.l.value]));
  const name = (iri: string): string => label.get(iri) ?? iri;
  const local = (iri: string): string => iri.slice(Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/')) + 1);
  // The importer also stores each note's `label` key as a plain `label` fact;
  // the exporter never emits that (it writes rdfs:label as `label`), so it is
  // not part of the exported fact set.
  return rows.filter(r => !r.p.value.endsWith('#label') || r.p.value === RDFS_LABEL).map(r => {
    const p = r.p.value.endsWith('#type') ? 'type' : local(r.p.value);
    const lang = r.o['xml:lang'] || r.o.language;
    const o = r.o.type === 'uri' ? `ref:${name(r.o.value)}`
      : `lit:${r.o.value}${lang && !stripLang ? `@${lang}` : ''}`;
    return `${name(r.s.value)} | ${p} | ${o}`;
  }).sort();
}

let source: { store: OxigraphTestAdapter; engine: KnowledgeEngine };
let outDir: string;

beforeAll(async () => {
  source = await newEngine('vrt-src-');
  const { engine, store } = source;
  await seed(engine, [
    { s: 'Alpha', p: 'type', o: 'skos:Concept' },
    { s: 'Alpha', p: 'description', o: 'a plain sentence', lit: true },
    { s: 'Alpha', p: 'refLike', o: '[[X]]', lit: true },
    { s: 'Alpha', p: 'curieLike', o: 'ex:thing', lit: true },
    { s: 'Alpha', p: 'cityName', o: 'Koeln', lit: true },
    { s: 'Alpha', p: 'relatedTo', o: 'Beta' },
    { s: 'Alpha', p: 'relatedTo', o: HOSTILE },
    { s: 'Alpha', p: 'narrower', o: SKOS_CONCEPT },
    { s: 'Alpha', p: 'broader', o: SKOS_BROADER },
    { s: 'Beta', p: 'type', o: 'skos:Concept' },
    { s: HOSTILE, p: 'type', o: 'skos:Concept' },
    { s: HOSTILE, p: 'description', o: 'a "quoted"\nmultiline value', lit: true },
  ]);
  // A language-tagged literal: rewrite the claim and its base triple together.
  await store.update(`DELETE { GRAPH ?g { ?x ?p "Koeln" } } INSERT { GRAPH ?g { ?x ?p "Köln"@de } }
    WHERE { GRAPH ?g { ?x ?p "Koeln" } FILTER(?g IN (<${CLAIMS}>, <${WV}>)) }`);
  // One IRI object stays unlabelled: the exporter must carry its full IRI.
  await store.update(`DELETE WHERE { GRAPH <${WV}> { <${SKOS_BROADER}> <${RDFS_LABEL}> ?l } }`);
  // Private data around it (never exported).
  await engine.storeFact({ subject: 'me', subjectType: 'Person', predicate: 'secretNote', object: 'SecretCanary',
    objectType: 'literal', sourceKind: 'user', status: 'accepted' } as never,
    { agentId: AGENT, sessionId: 's', isOwner: true, userId: 'alice' });
  await store.update(`INSERT DATA { GRAPH <urn:${AGENT}:self> { <urn:ontofelia:entity:Alpha> <urn:ontofelia:core#selfNote> "SelfCanary" }
    GRAPH <${WV}> { <urn:ontofelia:entity:Alpha> <urn:ontofelia:core#orphanNote> "OrphanCanary" } }`);
  outDir = join(freshTmp('vrt-out-'), 'vault');
});

afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const filesIn = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? filesIn(join(dir, e.name)).map(f => `${e.name}/${f}`) : [e.name]).sort();

describe('writeVaultExport round trip', () => {
  let written: Awaited<ReturnType<typeof writeVaultExport>>;
  let fresh: { store: OxigraphTestAdapter; engine: KnowledgeEngine };

  it('writes one .md per note, creating the folder', async () => {
    expect(existsSync(outDir)).toBe(false);
    written = await writeVaultExport(source.engine, { agentId: AGENT, dir: outDir });
    const built = await buildVaultExport(source.engine, { agentId: AGENT });
    expect(written.notesWritten).toBe(built.notes.length);
    expect(written.notesWritten).toBeGreaterThanOrEqual(3);
    expect(filesIn(outDir)).toEqual(written.paths);
    for (const n of built.notes) expect(readFileSync(join(outDir, n.path), 'utf8')).toBe(n.content);
  });

  it('keeps private facts out of every written file (canary over the files)', () => {
    const all = filesIn(outDir).map(f => `${f}\n${readFileSync(join(outDir, f), 'utf8')}`).join('\n');
    for (const c of ['SecretCanary', 'SelfCanary', 'OrphanCanary', 'secretNote', 'selfNote', 'orphanNote']) {
      expect(all).not.toContain(c);
    }
    expect(all).toContain('a plain sentence'); // not vacuous: allowed content is there
  });

  it('encodes literals, references, language tags and IRIs as intended', () => {
    const alpha = readFileSync(join(outDir, filesIn(outDir).find(f => f.endsWith('/Alpha.md'))!), 'utf8');
    const fm = yaml.load(/^---\n([\s\S]*?)\n---\n/.exec(alpha)![1], { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;
    expect(fm.refLike).toEqual({ '@value': '[[X]]' });
    expect(fm.curieLike).toEqual({ '@value': 'ex:thing' });
    expect(fm.cityName).toEqual({ '@value': 'Köln', '@language': 'de' });
    expect(fm.description).toBe('a plain sentence');
    expect(fm.type).toBe('[[skos:Concept]]'); // not skos_Concept
    expect(fm.narrower).toEqual({ '@id': SKOS_CONCEPT });
    expect(fm.broader).toEqual({ '@id': SKOS_BROADER });
    expect(fm.relatedTo).toHaveLength(2);
    expect(fm.relatedTo).toContain('[[Beta]]');
    expect(fm.relatedTo).toContainEqual({ '@id': HOSTILE });
  });

  it('writes only safe file names', () => {
    for (const p of written.paths) {
      const parts = p.split('/');
      expect(parts).toHaveLength(2);
      for (const part of parts) expect(part).toMatch(/^[^/\\:*?"<>|[\]#^\u0000-\u001f]+$/);
      expect(parts.some(x => x === '..' || x === '.' || x.startsWith('.'))).toBe(false);
    }
    expect(written.paths.some(p => p.includes('x_y'))).toBe(true);
  });

  it('imports into a fresh store with the same facts', async () => {
    fresh = await newEngine('vrt-fresh-');
    const rep = await importVault(fresh.engine, { root: outDir, vaultName: 'rt', agentId: AGENT, apply: true });
    expect(rep.notes.every(n => n.status === 'imported')).toBe(true);
    const expected = await factSet(source.engine, true);
    const actual = await factSet(fresh.engine, true);
    expect(expected.length).toBeGreaterThanOrEqual(11);
    expect(actual).toEqual(expected);
    // literals stay literals and references stay references
    expect(actual).toContain('Alpha | refLike | lit:[[X]]');
    expect(actual).toContain('Alpha | curieLike | lit:ex:thing');
    expect(actual).toContain(`Alpha | narrower | ref:${SKOS_CONCEPT}`);
    expect(actual).toContain('Alpha | type | ref:skos:Concept');
  });

  it('language tag: exported losslessly, but the importer stores the literal without it', async () => {
    // The import side keeps plain literals only (the engine has no language
    // storage and was not extended). The tag is validated and reported as
    // unmapped; it is lost on re-import by design of the store, not of the export.
    expect(await factSet(source.engine, false)).toContain('Alpha | cityName | lit:Köln@de');
    expect(await factSet(fresh.engine, false)).toContain('Alpha | cityName | lit:Köln');
    expect(await factSet(fresh.engine, false)).not.toContain('Alpha | cityName | lit:Köln@de');
    const dry = await importVault((await newEngine('vrt-dry-')).engine,
      { root: outDir, vaultName: 'rt3', agentId: AGENT, apply: false });
    const alpha = dry.notes.find(n => n.path.endsWith('/Alpha.md'))!;
    expect(alpha.unmapped).toContainEqual({ key: 'cityName', reason: 'language tag not stored (literal kept without it)' });
  });

  it('re-running the import reports unchanged', async () => {
    const rep = await importVault(fresh.engine, { root: outDir, vaultName: 'rt', agentId: AGENT, apply: true });
    expect(rep.notes.length).toBe(written.notesWritten);
    expect(rep.notes.every(n => n.status === 'unchanged')).toBe(true);
  });
});

describe('writeVaultExport safety', () => {
  it('refuses a non-empty folder unless overwrite, and never deletes', async () => {
    const dir = freshTmp('vrt-ne-');
    writeFileSync(join(dir, 'keep.txt'), 'mine');
    await expect(writeVaultExport(source.engine, { agentId: AGENT, dir })).rejects.toThrow(/not empty/);
    expect(filesIn(dir)).toEqual(['keep.txt']);
    const r = await writeVaultExport(source.engine, { agentId: AGENT, dir, overwrite: true });
    expect(r.notesWritten).toBeGreaterThan(0);
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('mine');
    // overwrite replaces the export's own file, leaves a foreign one alone
    const first = r.paths[0];
    writeFileSync(join(dir, first), 'stale');
    await writeVaultExport(source.engine, { agentId: AGENT, dir, overwrite: true });
    expect(readFileSync(join(dir, first), 'utf8')).toContain('---');
    expect(readFileSync(join(dir, 'keep.txt'), 'utf8')).toBe('mine');
  });

  it('refuses a symlinked target file and writes nothing', async () => {
    const dir = freshTmp('vrt-sl-');
    const victim = join(freshTmp('vrt-victim-'), 'victim.txt');
    writeFileSync(victim, 'untouched');
    const probe = await buildVaultExport(source.engine, { agentId: AGENT });
    const last = probe.notes[probe.notes.length - 1].path;
    const [folder, file] = last.split('/');
    mkdirSync(join(dir, folder));
    symlinkSync(victim, join(dir, folder, file));
    await expect(writeVaultExport(source.engine, { agentId: AGENT, dir, overwrite: true })).rejects.toThrow(/symlink/);
    expect(readFileSync(victim, 'utf8')).toBe('untouched');
    expect(lstatSync(join(dir, folder, file)).isSymbolicLink()).toBe(true);
    // preflight: no other note was written before the refusal
    expect(filesIn(dir).filter(f => f !== last)).toEqual([]);
  });

  it('refuses a symlinked sub folder and a symlinked export folder', async () => {
    const probe = await buildVaultExport(source.engine, { agentId: AGENT });
    const folder = probe.notes[0].path.split('/')[0];
    const dir = freshTmp('vrt-sf-');
    const elsewhere = freshTmp('vrt-else-');
    symlinkSync(elsewhere, join(dir, folder));
    await expect(writeVaultExport(source.engine, { agentId: AGENT, dir, overwrite: true })).rejects.toThrow(/symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);
    const link = join(freshTmp('vrt-ld-'), 'link');
    symlinkSync(elsewhere, link);
    await expect(writeVaultExport(source.engine, { agentId: AGENT, dir: link, overwrite: true })).rejects.toThrow(/symlink/);
    expect(readdirSync(elsewhere)).toEqual([]);
  });
});
