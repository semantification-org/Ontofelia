/**
 * The vault export must only emit labels that stand on accepted, vault-backed
 * claims. An extra label in the worldview or schema graph that no vault claim
 * backs must not become a file name, a frontmatter label or a heading. Real
 * engine on the embedded OxigraphAdapter, same setup as the other vault export
 * tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createOxigraphTestAdapter, type OxigraphTestAdapter } from './helpers/oxigraphTestAdapter.js';
import { KnowledgeEngine, mintedEntityUri } from '../KnowledgeEngine.js';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';
import { importVault } from '../ingestion/VaultImporter.js';
import { buildVaultExport, type VaultExportReport } from '../export/VaultExporter.js';

const AGENT = 'ontofelia';
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vault');
const EXTRA = 'AAA_CHAT_SECRET';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const CORE = 'urn:shared:ontology#';

let engine: KnowledgeEngine;
let store: OxigraphTestAdapter;

beforeEach(async () => {
  store = createOxigraphTestAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'vexp-label-')), port: 0, endpoint: '' } as never);
  engine = new KnowledgeEngine(store as never);
  const imp = await importVault(engine, { root: FIXTURE, vaultName: 'demo', agentId: AGENT, apply: true });
  expect(imp.totals.stored).toBeGreaterThan(0);
});

const everything = (r: VaultExportReport) => r.notes.map(n => `${n.path}\n${n.content}`).join('\n');

/** Insert a label triple into the worldview plus a claim for it with the given status and evidence source. */
async function insertLabelClaim(subject: string, label: string, status: string, sourceUri: string): Promise<void> {
  const world = GraphUriResolver.getWorldviewGraph(AGENT);
  const claims = GraphUriResolver.getClaimsGraph(AGENT);
  const evidence = GraphUriResolver.getEvidenceGraph(AGENT);
  await store.update(`INSERT DATA {
    GRAPH <${world}> { <${subject}> <${RDFS_LABEL}> "${label}" }
    GRAPH <${claims}> {
      <urn:test:claim:label> a <${CORE}Claim> ;
        <${CORE}status> "${status}" ;
        <${CORE}assertedInGraph> <${world}> ;
        <${CORE}hasEvidence> <urn:test:evidence:label> ;
        <${CORE}claimSubject> <${subject}> ;
        <${CORE}claimPredicate> <${RDFS_LABEL}> ;
        <${CORE}claimObject> "${label}" .
    }
    GRAPH <${evidence}> { <urn:test:evidence:label> <${CORE}sourceUri> "${sourceUri}" }
  }`);
}

describe('vault export label provenance', () => {
  it('control: without an extra label the export uses the proper vault-backed labels', async () => {
    const report = await buildVaultExport(engine, { agentId: AGENT });
    expect(report.notes.length).toBeGreaterThan(0);
    expect(everything(report)).not.toContain(EXTRA);
    for (const n of report.notes) expect(n.content).toMatch(/^---\n[\s\S]*label: /);
  });

  it('does not export a worldview label that no vault claim backs', async () => {
    const baseline = await buildVaultExport(engine, { agentId: AGENT });
    const target = baseline.notes[0];
    expect(target).toBeDefined();
    // A label without any claim or vault evidence, sorting before every proper label.
    await store.update(`INSERT DATA { GRAPH <urn:${AGENT}:worldview> { <${target.subject}> <${RDFS_LABEL}> "${EXTRA}" } }`);

    const report = await buildVaultExport(engine, { agentId: AGENT });
    expect(everything(report)).not.toContain(EXTRA);
  });

  it('does not export a label from the agent schema graph', async () => {
    const baseline = await buildVaultExport(engine, { agentId: AGENT });
    const target = baseline.notes[0];
    expect(target).toBeDefined();
    const schema = GraphUriResolver.getSchemaGraph(AGENT);
    await store.update(`INSERT DATA { GRAPH <${schema}> { <${target.subject}> <${RDFS_LABEL}> "${EXTRA}" } }`);

    const report = await buildVaultExport(engine, { agentId: AGENT });
    expect(everything(report)).not.toContain(EXTRA);
  });

  it('still uses a label that an accepted, vault-backed claim backs', async () => {
    const baseline = await buildVaultExport(engine, { agentId: AGENT });
    const target = baseline.notes[0];
    expect(target).toBeDefined();
    const before = target.content;
    expect(before).toMatch(/\nlabel: /);

    const report = await buildVaultExport(engine, { agentId: AGENT });
    const again = report.notes.find(n => n.subject === target.subject)!;
    expect(again.path).toBe(target.path);
    expect(again.content).toBe(before);
    const label = /\nlabel: (.*)\n/.exec(before)![1].replace(/^"|"$/g, '');
    expect(before).toContain(`# ${label}`);
    expect(target.path).toContain(label.replace(/[/\\:*?"<>|[\]#^]/g, '_'));
  });

  it('does not export a label backed by an accepted claim without vault evidence', async () => {
    const baseline = await buildVaultExport(engine, { agentId: AGENT });
    const target = baseline.notes[0];
    expect(target).toBeDefined();
    await insertLabelClaim(target.subject, EXTRA, 'accepted', 'https://example.org/chat/1');

    const report = await buildVaultExport(engine, { agentId: AGENT });
    expect(everything(report)).not.toContain(EXTRA);
  });

  it('does not export a worldview label whose subject was minted from another name', async () => {
    const baseline = await buildVaultExport(engine, { agentId: AGENT });
    const target = baseline.notes[0];
    expect(target).toBeDefined();
    const other = 'AAA_OTHER_NAME';
    expect(mintedEntityUri(other)).not.toBe(target.subject);
    await store.update(`INSERT DATA { GRAPH <urn:${AGENT}:worldview> { <${target.subject}> <${RDFS_LABEL}> "${other}" } }`);

    const report = await buildVaultExport(engine, { agentId: AGENT });
    expect(everything(report)).not.toContain(other);
  });

  it('mintedEntityUri matches the IRI the engine mints from a name', async () => {
    const name = '  Ho"stile\nlabel / x  ';
    expect(mintedEntityUri(name)).toBe('urn:ontofelia:entity:' + encodeURIComponent('Ho"stile_label_/_x'));
    await engine.storeFact({ subject: name, subjectType: 'Thing', predicate: 'note', object: 'x', objectType: 'literal',
      sourceKind: 'user', status: 'accepted' } as never, { agentId: AGENT, sessionId: 's', isOwner: true, userId: 'alice' });
    const rows = await engine.selectExplicitGraphs(
      `SELECT ?e WHERE { GRAPH <urn:${AGENT}:worldview> { ?e <${RDFS_LABEL}> ?l } }`);
    expect(rows.map(r => r.e.value)).toContain(mintedEntityUri(name));
  });
});
