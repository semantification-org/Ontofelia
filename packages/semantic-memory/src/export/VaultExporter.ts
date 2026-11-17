/**
 * Build a Vault-LD export (one Markdown note per subject) from the knowledge
 * store, in memory. Nothing is written to disk here.
 *
 * Allow-list (security-relevant): a fact is exported iff `urn:<agent>:claims`
 * holds a claim for it with status "accepted", asserted in
 * `urn:<agent>:worldview`, with vault provenance, AND the claim's base triple
 * is currently present in the worldview. Vault provenance means the claim has
 * `core:hasEvidence` to an evidence in `urn:<agent>:evidence` whose
 * `core:sourceUri` starts with `vault://`; only the vault importer writes such
 * evidence (no agent tool can set a sourceUri). The claim's `sourceKind` is
 * deliberately NOT a criterion: the model can choose it (`memory_store`).
 * Labels (`rdfs:label`) follow the same rule: a label is taken from an
 * allow-listed claim, or from a worldview triple whose subject is exactly the
 * IRI the engine mints from that label. Such a label carries no information
 * beyond the IRI itself, which the export shows anyway via the displayName
 * fallback; any other label needs a vault-backed claim. The schema and
 * ontology graphs are not read at all.
 * Only the claims graph, the evidence graph (matched by sourceUri prefix; its
 * text is never read) and the worldview are read, each by explicit IRI. User, self, session,
 * inferred and cog graphs are never read. Evidence text, raw text and source
 * spans are never exported.
 */
import { constants as fsc, promises as fs } from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { mintedEntityUri, type KnowledgeEngine } from '../KnowledgeEngine.js';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import { sparqlIri } from '../utils/SparqlSyntax.js';
import { isReferenceString, isWikiLinkSafe } from '../ingestion/VaultNoteMapper.js';

export interface VaultExportOptions { agentId: string; vaultName?: string; }
export interface VaultExportNote { path: string; content: string; subject: string; facts: number; }
export interface VaultExportReport {
  notes: VaultExportNote[];
  skipped: { claim: string; reason: string }[];
  totals: Record<string, number>;
}

const CORE = 'urn:shared:ontology#';
const ENTITY_NS = 'urn:ontofelia:entity:';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const NUMERIC_TYPES = new Set(['integer', 'int', 'long', 'short', 'decimal', 'double', 'float',
  'nonNegativeInteger', 'positiveInteger', 'negativeInteger', 'nonPositiveInteger'].map(t => XSD + t));
/** Keys the importer treats specially (identity, host or context keys): never emitted as facts. */
const RESERVED_KEYS = new Set(['id', '@id', '@type', '@context', 'tags', 'aliases', 'cssclasses']);
const MAX_NAME = 120;
const SEP = '\u001f';

/**
 * Value encodings (what the importer reads back):
 *  - plain string/number           a literal that cannot be mistaken for a reference
 *  - `[[name]]`                    a reference to the entity labelled `name`
 *  - `{"@value": text}`            a string literal that LOOKS like a reference
 *                                  (`[[X]]`, `prefix:local`): without this form the
 *                                  importer would turn it into an entity
 *  - `{"@value": t, "@language"}`  a language-tagged literal (the importer validates
 *                                  the tag but cannot store it)
 *  - `{"@id": name-or-IRI}`        a reference that `[[...]]` cannot spell: a name with
 *                                  `]`, `|`, `#`, `/` or outer whitespace, or an
 *                                  unlabelled absolute IRI (e.g. a skos: class), which
 *                                  the importer resolves back to that same IRI
 */
type Value = string | number | { '@value': string; '@language'?: string } | { '@id': string };

type Term = { type: string; value: string; datatype?: string; 'xml:lang'?: string; language?: string };
/** The embedded adapter reports `language`, the SPARQL JSON protocol `xml:lang`. */
const langOf = (t: Term): string | undefined => t['xml:lang'] || t.language || undefined;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Part of an IRI after `#` or the last `/` (percent-decoded when valid). */
function localName(iri: string): string {
  const cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'), iri.lastIndexOf(':'));
  const raw = cut >= 0 ? iri.slice(cut + 1) : iri;
  try { return decodeURIComponent(raw); } catch { return raw; }
}

/** Entity IRIs are minted with `_` for whitespace; undo that for display. */
function displayName(iri: string): string {
  return localName(iri).replace(/_/g, ' ').trim() || iri;
}

/** File-system safe name: no / \ : * ? " < > | (nor wiki-link breakers [ ] # ^), no leading dot. */
export function sanitizeFileName(name: string, max = MAX_NAME): string {
  let s = Array.from(name)
    .map(ch => (/[/\\:*?"<>|[\]#^]/.test(ch) || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f ? '_' : ch))
    .join('')
    .replace(/\s+/g, ' ').trim();
  s = s.replace(/^[.\s]+/, '');
  s = Array.from(s).slice(0, max).join('').replace(/[.\s]+$/, '');
  return s || 'Unnamed';
}

function scalar(t: Term): string | number {
  const text = t.value;
  const numericType = t.datatype !== undefined && NUMERIC_TYPES.has(t.datatype);
  // A plain literal that reads as a canonical number stays a number (the
  // store keeps literals as strings); a non-canonical one such as "1.50" or
  // "007" stays a string so the value round-trips exactly.
  if ((numericType || t.datatype === undefined || t.datatype === XSD + 'string')
    && /^-?(0|[1-9]\d*)(\.\d+)?$/.test(text) && String(Number(text)) === text
    && Number.isSafeInteger(Math.trunc(Number(text)))) {
    return Number(text);
  }
  return text;
}

export async function buildVaultExport(engine: KnowledgeEngine, opts: VaultExportOptions): Promise<VaultExportReport> {
  const claimsG = sparqlIri(GraphUriResolver.getClaimsGraph(opts.agentId));
  const worldG = sparqlIri(GraphUriResolver.getWorldviewGraph(opts.agentId));
  const evidenceG = sparqlIri(GraphUriResolver.getEvidenceGraph(opts.agentId));

  // 1. The allow-list: the only source of exported facts.
  const allowSparql = `SELECT DISTINCT ?c ?s ?p ?o WHERE {
  GRAPH ${claimsG} {
    ?c a <${CORE}Claim> ;
       <${CORE}status> "accepted" ;
       <${CORE}assertedInGraph> ${worldG} ;
       <${CORE}hasEvidence> ?e ;
       <${CORE}claimSubject> ?s ;
       <${CORE}claimPredicate> ?p ;
       <${CORE}claimObject> ?o .
  }
  GRAPH ${evidenceG} { ?e <${CORE}sourceUri> ?u }
  FILTER(STRSTARTS(STR(?u), "vault://"))
  GRAPH ${worldG} { ?s ?p ?o }
}`;
  const allowRows = await engine.selectExplicitGraphs(allowSparql);

  // 2. Every claim with its selection attributes, for the skip report only.
  const claimSparql = `SELECT ?c
  (GROUP_CONCAT(DISTINCT ?st; separator="${SEP}") AS ?statuses)
  (GROUP_CONCAT(DISTINCT STR(?ag); separator="${SEP}") AS ?graphs)
WHERE {
  GRAPH ${claimsG} {
    ?c a <${CORE}Claim> .
    OPTIONAL { ?c <${CORE}status> ?st }
    OPTIONAL { ?c <${CORE}assertedInGraph> ?ag }
  }
} GROUP BY ?c`;
  const claimRows = await engine.selectExplicitGraphs(claimSparql);

  // 2b. Claims that do have vault provenance, for the skip report only.
  const vaultRows = await engine.selectExplicitGraphs(`SELECT DISTINCT ?c WHERE {
  GRAPH ${claimsG} { ?c <${CORE}hasEvidence> ?e }
  GRAPH ${evidenceG} { ?e <${CORE}sourceUri> ?u }
  FILTER(STRSTARTS(STR(?u), "vault://"))
}`);
  const withVault = new Set(vaultRows.map(r => r.c.value));

  // 3. Labels: from the allow-list rows, so a label stands on the same
  // accepted, vault-backed claim as any other fact, or (worldview only) a
  // label that merely restates the IRI minted from it.
  const labels = new Map<string, string[]>();
  const addLabel = (iri: string, l: string): void => {
    const arr = labels.get(iri) ?? [];
    arr.push(l);
    labels.set(iri, arr);
  };
  for (const r of allowRows) {
    if (r.p.value !== RDFS_LABEL || r.s.type !== 'uri' || r.o.type === 'uri') continue;
    addLabel(r.s.value, r.o.value);
  }
  const worldLabelRows = await engine.selectExplicitGraphs(
    `SELECT ?e ?l WHERE { GRAPH ${worldG} { ?e <${RDFS_LABEL}> ?l } }`);
  for (const r of worldLabelRows) {
    if (r.e.type !== 'uri' || r.l.type === 'uri') continue;
    if (r.e.value === mintedEntityUri(r.l.value)) addLabel(r.e.value, r.l.value);
  }
  const labelOf = (iri: string): string => {
    const ls = (labels.get(iri) ?? []).filter(l => l.trim()).sort(cmp);
    return ls.length ? ls[0].trim() : displayName(iri);
  };

  // Group the allowed base triples by claim id into distinct facts.
  const allowedClaims = new Set<string>();
  interface Fact { p: string; o: Term }
  const bySubject = new Map<string, Map<string, Fact>>();
  const skipped: { claim: string; reason: string }[] = [];
  const skipReasons: Record<string, number> = {};
  const skip = (claim: string, reason: string): void => {
    skipped.push({ claim, reason });
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
  };
  const allowSorted = [...allowRows].sort((a, b) =>
    cmp(a.c.value, b.c.value) || cmp(a.s.value, b.s.value) || cmp(a.p.value, b.p.value)
    || cmp(a.o.type + a.o.value, b.o.type + b.o.value));
  for (const r of allowSorted) {
    allowedClaims.add(r.c.value);
    if (r.s.type !== 'uri') { skip(r.c.value, 'blank node subject'); continue; }
    if (r.o.type === 'bnode') { skip(r.c.value, 'blank node object'); continue; }
    if (r.p.value === RDFS_LABEL) continue; // rendered as `label`
    if (r.o.type !== 'uri' && !r.o.value.trim()) { skip(r.c.value, 'empty literal'); continue; }
    const key = r.p.value === RDF_TYPE ? 'type' : localName(r.p.value);
    if (key === 'label') continue; // rendered as `label`, like rdfs:label
    if (key !== 'type' && RESERVED_KEYS.has(key)) { skip(r.c.value, 'reserved key'); continue; }
    if (!key) { skip(r.c.value, 'empty predicate name'); continue; }
    const facts = bySubject.get(r.s.value) ?? new Map<string, Fact>();
    facts.set(`${r.p.value}\u0000${r.o.type}\u0000${r.o.value}\u0000${r.o.datatype ?? ''}\u0000${langOf(r.o) ?? ''}`, { p: r.p.value, o: r.o });
    bySubject.set(r.s.value, facts);
  }

  let considered = 0;
  for (const r of [...claimRows].sort((a, b) => cmp(a.c.value, b.c.value))) {
    considered++;
    if (allowedClaims.has(r.c.value)) continue;
    const statuses = (r.statuses?.value ?? '').split(SEP).filter(Boolean);
    const graphs = (r.graphs?.value ?? '').split(SEP).filter(Boolean);
    const world = GraphUriResolver.getWorldviewGraph(opts.agentId);
    if (!statuses.includes('accepted')) skip(r.c.value, `status ${statuses.join('|') || 'missing'}`);
    else if (!graphs.includes(world)) skip(r.c.value, 'asserted outside the worldview');
    else if (!withVault.has(r.c.value)) skip(r.c.value, 'no vault provenance');
    else skip(r.c.value, 'base triple missing');
  }

  // 4. Names: unique vault-wide (wiki links resolve by name), subject IRI order.
  const subjects = [...bySubject.keys()].sort(cmp);
  const subjectSet = new Set(subjects);
  const nameOf = new Map<string, string>();
  const usedNames = new Set<string>();
  for (const s of subjects) {
    const base = sanitizeFileName(labelOf(s));
    let name = base;
    for (let n = 2; usedNames.has(name.toLowerCase()); n++) {
      const suffix = ` (${n})`;
      name = sanitizeFileName(base, MAX_NAME - suffix.length) + suffix;
    }
    usedNames.add(name.toLowerCase());
    nameOf.set(s, name);
  }

  // 5. Render.
  /** A reference to `iri`: by label when it has one, else by its absolute IRI. */
  const refValue = (iri: string): Value => {
    if (subjectSet.has(iri) || labels.has(iri) || iri.startsWith(ENTITY_NS) || !/^https?:\/\//.test(iri)) {
      const name = labelOf(iri);
      return isWikiLinkSafe(name) ? `[[${name}]]` : { '@id': name };
    }
    try { sparqlIri(iri); } catch { return { '@id': labelOf(iri) }; }
    return { '@id': iri };
  };
  const literalValue = (t: Term): Value => {
    const lang = langOf(t);
    if (lang) return { '@value': t.value, '@language': lang };
    const sc = scalar(t);
    return typeof sc === 'string' && isReferenceString(sc) ? { '@value': sc } : sc;
  };
  const sortKey = (x: Value): string =>
    typeof x === 'number' ? `n${x}` : typeof x === 'string' ? `s${x}` : `o${JSON.stringify(x)}`;
  const uniqueSorted = (xs: Value[]): Value[] =>
    [...new Map(xs.map(x => [sortKey(x), x])).entries()].sort((a, b) => cmp(a[0], b[0])).map(e => e[1]);

  const notes: VaultExportNote[] = [];
  for (const s of subjects) {
    const facts = [...bySubject.get(s)!.values()];
    const values = new Map<string, Value[]>();
    const types: Value[] = [];
    for (const f of facts) {
      if (f.p === RDF_TYPE) {
        if (f.o.type === 'uri') types.push(refValue(f.o.value));
        continue;
      }
      const key = localName(f.p);
      let v: Value;
      if (f.o.type === 'uri') {
        v = refValue(f.o.value);
      } else {
        v = literalValue(f.o);
      }
      const arr = values.get(key) ?? [];
      arr.push(v);
      values.set(key, arr);
    }
    const typeVals = uniqueSorted(types);
    const fm: Record<string, unknown> = {};
    if (typeVals.length) fm.type = typeVals.length === 1 ? typeVals[0] : typeVals;
    const label = labelOf(s);
    fm.label = label;
    for (const key of [...values.keys()].sort(cmp)) {
      const vs = uniqueSorted(values.get(key)!);
      fm[key] = vs.length === 1 ? vs[0] : vs;
    }
    const front = yaml.dump(fm, {
      schema: yaml.CORE_SCHEMA, sortKeys: false, lineWidth: -1, noRefs: true, quotingType: '"',
    });
    const first = typeVals[0];
    const folder = first === undefined ? 'Untyped'
      : sanitizeFileName(typeof first === 'string' ? first.replace(/^\[\[|\]\]$/g, '')
        : typeof first === 'object' && '@id' in first ? first['@id'] : 'Untyped');
    notes.push({
      path: `${folder}/${nameOf.get(s)}.md`,
      content: `---\n${front}---\n# ${label.replace(/\s+/g, ' ').trim()}\n`,
      subject: s,
      facts: facts.length,
    });
  }
  notes.sort((a, b) => cmp(a.path, b.path));
  skipped.sort((a, b) => cmp(a.claim, b.claim) || cmp(a.reason, b.reason));

  const skippedSet = new Set(skipped.map(k => k.claim));
  const totals: Record<string, number> = {
    claimsConsidered: considered,
    claimsExported: [...allowedClaims].filter(c => !skippedSet.has(c)).length,
    claimsSkipped: skipped.length,
    notes: notes.length,
  };
  for (const [reason, n] of Object.entries(skipReasons).sort((a, b) => cmp(a[0], b[0]))) {
    totals[`skipped: ${reason}`] = n;
  }
  return { notes, skipped, totals };
}

export interface WriteVaultExportOptions {
  agentId: string;
  /** Target folder; created when missing. */
  dir: string;
  /** Allow a non-empty folder. Nothing is ever deleted; only the export's own files are replaced. */
  overwrite?: boolean;
}
export interface WriteVaultExportReport {
  dir: string;
  notesWritten: number;
  /** Folder-relative paths of the written files, sorted. */
  paths: string[];
  skipped: VaultExportReport['skipped'];
  totals: Record<string, number>;
}

/** Path segments are checked again here, whatever produced them. */
function assertSafeRelPath(rel: string): string[] {
  const parts = rel.split('/');
  const bad = path.isAbsolute(rel) || rel.includes('\\') || rel.includes('\0') || parts.length !== 2
    || parts.some(p => p === '' || p === '.' || p === '..');
  if (bad) throw new Error(`Refusing unsafe export path: ${JSON.stringify(rel.slice(0, 80))}`);
  return parts;
}

async function lstatOrNull(p: string): Promise<import('fs').Stats | null> {
  try { return await fs.lstat(p); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/** Throws unless `p` is absent or a real (non-symlink) entry of the wanted kind. */
async function assertNotSymlink(p: string, kind: 'dir' | 'file'): Promise<boolean> {
  const st = await lstatOrNull(p);
  if (!st) return false;
  if (st.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${path.basename(p)}`);
  if (kind === 'dir' ? !st.isDirectory() : !st.isFile()) {
    throw new Error(`Refusing to replace a non-${kind === 'dir' ? 'directory' : 'regular file'}: ${path.basename(p)}`);
  }
  return true;
}

export interface WriteVaultNotesOptions {
  /** Target folder; created when missing. */
  dir: string;
  /** Allow a non-empty folder. Nothing is ever deleted; only the given files are replaced. */
  overwrite?: boolean;
}
export interface WriteVaultNotesReport {
  dir: string;
  notesWritten: number;
  /** Folder-relative paths of the written files, sorted. */
  paths: string[];
}

/**
 * Write `{ path, content }` notes (`<folder>/<name>.md`) under `opts.dir`.
 *
 * Safety: a non-empty folder is refused unless `overwrite`; even then nothing
 * is deleted, only the given files are created or replaced. Every target is
 * checked up front (no symlink, no non-regular file, safe name), before the
 * first byte is written, and files are opened with O_NOFOLLOW. The paths are
 * validated here whatever produced them.
 */
export async function writeVaultNotes(
  notes: { path: string; content: string }[], opts: WriteVaultNotesOptions,
): Promise<WriteVaultNotesReport> {
  const dir = path.resolve(opts.dir);
  const plan = notes.map(n => ({ note: n, parts: assertSafeRelPath(n.path) }));
  const seen = new Set<string>();
  for (const { note } of plan) {
    const k = note.path.toLowerCase();
    if (seen.has(k)) throw new Error('Refusing colliding export paths');
    seen.add(k);
  }

  const dirSt = await lstatOrNull(dir);
  if (dirSt) {
    if (dirSt.isSymbolicLink()) throw new Error('Refusing a symlink as export folder');
    if (!dirSt.isDirectory()) throw new Error('Export folder is not a directory');
    if (!opts.overwrite && (await fs.readdir(dir)).length > 0) {
      throw new Error('Export folder is not empty (pass overwrite to replace the export\'s own files)');
    }
  }
  for (const { parts } of plan) {
    await assertNotSymlink(path.join(dir, parts[0]), 'dir');
    await assertNotSymlink(path.join(dir, parts[0], parts[1]), 'file');
  }

  if (!dirSt) await fs.mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const { note, parts } of plan) {
    const folder = path.join(dir, parts[0]);
    const target = path.join(folder, parts[1]);
    // Re-check immediately before writing (narrows the window for a swapped entry).
    if (!(await assertNotSymlink(folder, 'dir'))) await fs.mkdir(folder);
    await assertNotSymlink(target, 'file');
    const fh = await fs.open(target, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | fsc.O_NOFOLLOW, 0o644);
    try { await fh.writeFile(note.content, 'utf8'); } finally { await fh.close(); }
    written.push(note.path);
  }
  return { dir, notesWritten: written.length, paths: written.sort(cmp) };
}

/**
 * Build the export and write one `.md` per note under `opts.dir`
 * (see `writeVaultNotes` for the safety rules).
 */
export async function writeVaultExport(
  engine: KnowledgeEngine, opts: WriteVaultExportOptions,
): Promise<WriteVaultExportReport> {
  const report = await buildVaultExport(engine, { agentId: opts.agentId });
  const w = await writeVaultNotes(report.notes, { dir: opts.dir, overwrite: opts.overwrite });
  return { ...w, skipped: report.skipped, totals: report.totals };
}
