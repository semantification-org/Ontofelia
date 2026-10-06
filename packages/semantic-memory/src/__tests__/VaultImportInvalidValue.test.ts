/**
 * A note whose values the validators reject is refused on its own; the import
 * carries on with the remaining notes, in dry run and with apply, and nothing
 * of the refused note is written. Real round-trip on the embedded OxigraphAdapter.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { importVault } from '../ingestion/VaultImporter.js';

const AGENT = 'ontofelia';

async function setup() {
  const store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'invalid-store-')), port: 0, endpoint: '' } as never);
  const engine = new KnowledgeEngine(store as never);
  const root = mkdtempSync(join(tmpdir(), 'invalid-vault-'));
  mkdirSync(join(root, 'N'));
  const note = (name: string, rel: string) => writeFileSync(join(root, 'N', name),
    ['---', 'type: "[[Thing]]"', `rel: ${JSON.stringify(rel)}`, '---', 'Body.', ''].join('\n'));
  note('a.md', 'fine');
  note('b.md', 'urn:x>y');
  note('c.md', 'also fine');
  return { store, engine, root };
}

const status = (r: { notes: { path: string; status: string }[] }, p: string) =>
  r.notes.find(n => n.path === p)?.status;

describe('importVault with a note that has an invalid value', () => {
  it('dry run refuses only the bad note', async () => {
    const { engine, root } = await setup();
    const r = await importVault(engine, { root, vaultName: 'probe', agentId: AGENT, apply: false });
    expect(status(r, 'N/a.md')).toBe('would-import');
    expect(status(r, 'N/b.md')).toBe('refused');
    expect(status(r, 'N/c.md')).toBe('would-import');
    const reason = r.notes.find(n => n.path === 'N/b.md')!.reason!;
    expect(reason).toContain('invalid value for "rel"');
    expect(reason).not.toContain('>');
  });

  it('apply imports the others, stores nothing of the bad note, and a re-run is stable', async () => {
    const { store, engine, root } = await setup();
    const r = await importVault(engine, { root, vaultName: 'probe', agentId: AGENT, apply: true });
    expect(status(r, 'N/a.md')).toBe('imported');
    expect(status(r, 'N/b.md')).toBe('refused');
    expect(status(r, 'N/c.md')).toBe('imported');

    const rows = (await store.query(
      `SELECT ?src WHERE { GRAPH <urn:${AGENT}:evidence> { ?e <urn:shared:ontology#sourceUri> ?src } }`,
    )).bindings ?? [];
    const srcs = rows.map(b => b.src.value);
    expect(srcs.some(u => u.endsWith('/N/a.md'))).toBe(true);
    expect(srcs.some(u => u.endsWith('/N/c.md'))).toBe(true);
    expect(srcs.some(u => u.endsWith('/N/b.md'))).toBe(false);
    const anyB = (await store.query(
      'SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?o), "x>y") || CONTAINS(STR(?o), "urn:x"))}',
    )).bindings?.[0].n.value;
    expect(Number(anyB)).toBe(0);

    const again = await importVault(engine, { root, vaultName: 'probe', agentId: AGENT, apply: true });
    expect(status(again, 'N/a.md')).toBe('unchanged');
    expect(status(again, 'N/b.md')).toBe('refused');
    expect(status(again, 'N/c.md')).toBe('unchanged');
  });
});
