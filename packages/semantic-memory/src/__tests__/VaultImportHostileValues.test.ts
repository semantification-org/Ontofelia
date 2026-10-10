/**
 * A vault whose frontmatter carries hostile values (CR, backslash + quote,
 * braces, angle brackets) must import without error: every value that reaches
 * SPARQL / N-Triples text goes through the shared validators. Literals
 * round-trip byte-exact and nothing is injected into another graph.
 * Real round-trip on the embedded OxigraphAdapter, reasoner included.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { importVault } from '../ingestion/VaultImporter.js';

const AGENT = 'ontofelia';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('importVault with hostile frontmatter values', () => {
  it('imports without error, round-trips literals and injects nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded',
      dataDir: mkdtempSync(join(tmpdir(), 'hostile-store-')), port: 0, endpoint: '' } as never);
    const engine = new KnowledgeEngine(store as never);
    const rows = async (sparql: string) => (await store.query(sparql)).bindings ?? [];

    const root = mkdtempSync(join(tmpdir(), 'hostile-vault-'));
    mkdirSync(join(root, 'Notes'));
    // YAML double-quoted scalars: the escapes below are decoded by the YAML parser.
    const hostile = [
      '---',
      'type: "[[Thing]]"',
      'cr: "a\\rb"',
      `bs: 'x\\" y'`,
      'rel: "ex:a><urn:x>\\"\\\\}"',
      'lit: "brace } here"',
      'inj: "v\\" } } ; INSERT DATA { GRAPH <urn:pwn> { <urn:a> <urn:b> <urn:c> } } #"',
      '---',
      'Body with } and > characters.',
      '',
    ].join('\n');
    writeFileSync(join(root, 'Notes', 'hostile.md'), hostile);
    writeFileSync(join(root, 'Notes', 'normal.md'),
      ['---', 'type: "[[Thing]]"', 'colour: red', '---', 'Plain note.', ''].join('\n'));

    const report = await importVault(engine, { root, vaultName: 'hostile', agentId: AGENT, apply: true });

    expect(report.notes.find(n => n.path === 'Notes/hostile.md')?.status).toBe('imported');
    expect(report.notes.find(n => n.path === 'Notes/normal.md')?.status).toBe('imported');
    const hostileFacts = report.notes.find(n => n.path === 'Notes/hostile.md')!.facts;
    expect(hostileFacts.length).toBe(6); // type, cr, bs, rel, lit, inj
    expect(hostileFacts.every(f => f.outcome === 'stored')).toBe(true);
    expect(report.notes.find(n => n.path === 'Notes/normal.md')!.facts.every(f => f.outcome === 'stored')).toBe(true);

    // Literals round-trip byte-exact.
    const lits = (await rows(
      `SELECT ?o WHERE { GRAPH <urn:${AGENT}:worldview> { ?s ?p ?o FILTER(isLiteral(?o)) } }`,
    )).map(b => b.o.value);
    expect(lits).toContain('a\rb');
    expect(lits).toContain('x\\" y');
    expect(lits).toContain('brace } here');
    expect(lits).toContain('v" } } ; INSERT DATA { GRAPH <urn:pwn> { <urn:a> <urn:b> <urn:c> } } #');
    expect(lits).toContain('red');

    // The hostile entity-valued fact produced a claim whose object is a plain IRI.
    const claims = (await rows(
      `SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:${AGENT}:claims> { ?c a <urn:shared:ontology#Claim> } }`,
    ))[0].n.value;
    expect(Number(claims)).toBeGreaterThanOrEqual(7);

    // Nothing was injected anywhere.
    const pwn = (await rows('SELECT (COUNT(*) AS ?n) WHERE { GRAPH <urn:pwn> { ?s ?p ?o } }'))[0].n.value;
    expect(Number(pwn)).toBe(0);
    const stray = (await rows(
      'SELECT (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } FILTER(CONTAINS(STR(?s), "urn:a") && STR(?s) = "urn:a") }',
    ))[0].n.value;
    expect(Number(stray)).toBe(0);

    // The reasoner never choked on a hostile term.
    const reasoningFailures = errors.mock.calls.filter(c => String(c[0]).includes('Reasoning failed'));
    expect(reasoningFailures).toEqual([]);
  });
});
