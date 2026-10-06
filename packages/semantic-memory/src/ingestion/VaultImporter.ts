/**
 * Deterministic import of a Vault-LD folder into the knowledge store.
 *
 * Walks the folder, maps each note with `mapVaultNote`, and stores the facts
 * with document evidence. Schema notes (TBox) are refused: schema never goes
 * through the fact path. A fact that would supersede a claim that was not
 * itself imported from the same vault is blocked. `apply: false` writes nothing.
 * No LLM, no network.
 */
import { createHash, randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { KnowledgeEngine } from '../KnowledgeEngine.js';
import type { FactContext } from '../types.js';
import { mapVaultNote } from './VaultNoteMapper.js';

export interface VaultImportOptions {
  /** Absolute path to the vault folder. */
  root: string;
  /** [A-Za-z0-9_-]{1,64}, else throw. */
  vaultName: string;
  agentId: string;
  /** false = dry run: writes nothing. */
  apply: boolean;
  /** Default 5000; exceeding it throws before any write. */
  maxFiles?: number;
  /** Default 256 KiB; larger files are skipped with a reason. */
  maxFileBytes?: number;
}

export interface VaultImportNoteReport {
  path: string;
  status: 'imported' | 'would-import' | 'unchanged' | 'refused' | 'skipped';
  reason?: string;
  facts: { predicate: string; object: string; outcome: 'stored' | 'would-store' | 'duplicate' | 'blocked-supersede' }[];
  unmapped: { key: string; reason: string }[];
}

export interface VaultImportReport {
  runId: string;
  apply: boolean;
  notes: VaultImportNoteReport[];
  totals: Record<string, number>;
}

const SCHEMA_TYPES = new Set([
  'owl:Class', 'owl:ObjectProperty', 'owl:DatatypeProperty', 'owl:AnnotationProperty',
  'owl:Ontology', 'rdfs:Class', 'rdf:Property', 'rdfs:Datatype',
]);
const SCHEMA_KEYS = [
  'subClassOf', 'subPropertyOf', 'domain', 'range',
  'equivalentClass', 'equivalentProperty', 'inverseOf', 'disjointWith',
];
const SCHEMA_REASON = 'schema note (not imported as facts)';

interface Candidate { rel: string; abs: string; skip?: string }

async function walk(realRoot: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const visit = async (dirAbs: string, dirRel: string): Promise<void> => {
    const entries = await fs.readdir(dirAbs, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const abs = path.join(dirAbs, e.name);
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      const st = await fs.lstat(abs);
      if (st.isSymbolicLink()) {
        if (e.name.toLowerCase().endsWith('.md') || !e.name.startsWith('.')) {
          out.push({ rel, abs, skip: 'symlink (not followed)' });
        }
        continue;
      }
      if (st.isDirectory()) {
        if (e.name.startsWith('.')) continue;
        await visit(abs, rel);
      } else if (st.isFile() && e.name.toLowerCase().endsWith('.md')) {
        const real = await fs.realpath(abs);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          out.push({ rel, abs, skip: 'outside the vault root' });
        } else {
          out.push({ rel, abs });
        }
      }
    }
  };
  await visit(realRoot, '');
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** A validator message for a report: control characters dropped, length capped. */
function safeMessage(msg: string): string {
  return msg.replace(/[^\x20-\x7e]/g, '?').slice(0, 160);
}

function splitFrontmatter(text: string): { yamlSrc: string; body: string } | { error: string } {
  const lines = text.replace(/^﻿/, '').split('\n');
  if ((lines[0] ?? '').replace(/\r$/, '') !== '---') return { error: 'no frontmatter' };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].replace(/\r$/, '') === '---') {
      return { yamlSrc: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n') };
    }
  }
  return { error: 'unterminated frontmatter' };
}

export async function importVault(engine: KnowledgeEngine, opts: VaultImportOptions): Promise<VaultImportReport> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(opts.vaultName ?? '')) {
    throw new Error('Invalid vaultName: expected [A-Za-z0-9_-]{1,64}');
  }
  const maxFiles = opts.maxFiles ?? 5000;
  const maxFileBytes = opts.maxFileBytes ?? 256 * 1024;
  const realRoot = await fs.realpath(opts.root);
  const candidates = await walk(realRoot);
  if (candidates.length > maxFiles) {
    throw new Error(`Vault has ${candidates.length} markdown files, more than maxFiles ${maxFiles}`);
  }

  const runId = `vault-import-${new Date().toISOString()}-${randomBytes(4).toString('hex')}`;
  const ctx: FactContext = { agentId: opts.agentId, sessionId: 'vault-import', isOwner: false, ingestionRunId: runId };
  const vaultPrefix = `vault://${opts.vaultName}/`;
  const notes: VaultImportNoteReport[] = [];

  for (const c of candidates) {
    const rep: VaultImportNoteReport = { path: c.rel, status: 'skipped', facts: [], unmapped: [] };
    notes.push(rep);
    if (c.skip) { rep.reason = c.skip; continue; }
    const st = await fs.lstat(c.abs);
    if (st.size > maxFileBytes) { rep.reason = `file larger than ${maxFileBytes} bytes`; continue; }

    const raw = await fs.readFile(c.abs);
    const contentHash = 'sha256:' + createHash('sha256').update(raw).digest('hex');
    const sourceUri = vaultPrefix + c.rel.split('/').map(encodeURIComponent).join('/');
    const refuse = (reason: string): void => { rep.status = 'refused'; rep.reason = reason; };

    if (await engine.hasEvidence(opts.agentId, sourceUri, contentHash)) {
      rep.status = 'unchanged';
      continue;
    }

    const parts = splitFrontmatter(raw.toString('utf8'));
    if ('error' in parts) { refuse(parts.error); continue; }
    let fm: unknown;
    try {
      fm = yaml.load(parts.yamlSrc, { schema: yaml.CORE_SCHEMA });
    } catch {
      refuse('invalid YAML');
      continue;
    }
    if (typeof fm !== 'object' || fm === null || Array.isArray(fm)) {
      refuse('frontmatter is not a mapping');
      continue;
    }
    const frontmatter = fm as Record<string, unknown>;

    const mapping = mapVaultNote({
      path: c.rel, frontmatter, body: parts.body, contentHash, vaultName: opts.vaultName,
    });
    rep.unmapped = mapping.unmapped;
    const isSchema = SCHEMA_KEYS.some(k => k in frontmatter)
      || mapping.facts.some(f => f.predicate === 'type' && SCHEMA_TYPES.has(f.object));
    if (isSchema) { refuse(SCHEMA_REASON); continue; }
    if (mapping.refused) { refuse(mapping.refused); continue; }
    if (mapping.facts.length === 0) { refuse('no facts'); continue; }

    // Validate every fact of the note before the first write: previewFacts
    // is read-only and runs the engine's term validators. A rejected term
    // refuses this note only; any other error is a genuine failure and throws.
    const previews: Awaited<ReturnType<KnowledgeEngine['previewFacts']>> = [];
    let invalid: string | undefined;
    for (const f of mapping.facts) {
      try {
        previews.push(...await engine.previewFacts([f], ctx));
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (!/^Invalid /.test(msg)) throw err;
        invalid = `invalid value for ${JSON.stringify(f.predicate.slice(0, 64))}: ${safeMessage(msg)}`;
        break;
      }
    }
    if (invalid !== undefined) { refuse(invalid); continue; }
    const sources = await engine.claimSourceUris(
      opts.agentId, [...new Set(previews.flatMap(p => p.wouldSupersede))],
    );
    for (const p of previews) {
      const entry = { predicate: p.fact.predicate, object: p.fact.object };
      if (p.duplicate) { rep.facts.push({ ...entry, outcome: 'duplicate' }); continue; }
      const foreign = p.wouldSupersede.some(
        claim => !(sources.get(claim) ?? []).some(u => u.startsWith(vaultPrefix)),
      );
      if (foreign) { rep.facts.push({ ...entry, outcome: 'blocked-supersede' }); continue; }
      if (!opts.apply) { rep.facts.push({ ...entry, outcome: 'would-store' }); continue; }
      const res = await engine.storeFact(p.fact, ctx);
      if (!res.success) throw new Error(`storeFact failed for ${c.rel}`);
      rep.facts.push({ ...entry, outcome: 'stored' });
    }
    rep.status = opts.apply ? 'imported' : 'would-import';
  }

  const totals: Record<string, number> = {};
  for (const n of notes) {
    totals[n.status] = (totals[n.status] ?? 0) + 1;
    for (const f of n.facts) totals[f.outcome] = (totals[f.outcome] ?? 0) + 1;
  }
  return { runId, apply: opts.apply, notes, totals };
}
