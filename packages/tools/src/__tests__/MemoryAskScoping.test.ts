/**
 * memory_ask templates must read only the acting user's graph and the agent
 * worldview, and resolve labels only from allowed graphs (own graphs, shared
 * ontology, schema) — never from another user's private graph.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '@ontofelia/core';
import { OxigraphAdapter } from '@ontofelia/semantic-memory';
import { MemoryAskTool } from '../memory/memory_ask.js';

const AGENT = 'ontofelia';
const E = 'urn:ontofelia:entity:';
const LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const KNOWS = 'urn:ontofelia:core#knows';
const CLAIM = 'urn:shared:ontology#';

let store: OxigraphAdapter;
let tool: MemoryAskTool;

async function insert(graph: string, triples: string) {
  await store.update(`INSERT DATA { GRAPH <${graph}> { ${triples} } }`);
}

function ctx(senderId: string): ToolContext {
  return { agentId: AGENT, sessionId: 's', workspacePath: '/tmp', channelType: 'cli',
    senderId, isOwner: false } as unknown as ToolContext;
}

async function ask(sender: string, input: { template: string; entity?: string; confidence?: string }) {
  const res = await tool.execute(input, ctx(sender));
  expect(res.success).toBe(true);
  return (res.output as { results: Array<Record<string, { value: string }>> }).results;
}

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'ask-scoping-')), port: 0, endpoint: '' } as never);
  tool = new MemoryAskTool(store as never);

  // Alice and Bob each know Zed privately; the worldview knows Zed too.
  await insert(`urn:${AGENT}:user:alice`,
    `<${E}Anna> <urn:ontofelia:core#livesIn> <${E}Hamburg> . <${E}Anna> <${KNOWS}> <${E}Alice2> .
     <${E}Hamburg> <${LABEL}> "Hamburg (Alice)" .`);
  await insert(`urn:${AGENT}:user:bob`,
    `<${E}Anna> <urn:ontofelia:core#livesIn> <${E}Bremen> . <${E}Anna> <${KNOWS}> <${E}Bob2> .
     <${E}Hamburg> <${LABEL}> "BOBS-PRIVATE-NAME" .`);
  await insert(`urn:${AGENT}:worldview`, `<${E}Anna> <urn:ontofelia:core#age> "30" .`);
  await insert(`urn:${AGENT}:schema`,
    `<urn:ontofelia:core#livesIn> <${LABEL}> "lives in" . <${KNOWS}> <${LABEL}> "knows" .`);
  // Claims: subject label only in Bob's graph, predicate label in the schema.
  await insert(`urn:${AGENT}:claims`,
    `<urn:c:1> a <${CLAIM}Claim> ; <${CLAIM}claimSubject> <${E}Hamburg> ;
       <${CLAIM}claimPredicate> <urn:ontofelia:core#livesIn> ; <${CLAIM}claimObject> <${E}X> ;
       <${CLAIM}learnedAt> "2026-01-01T00:00:00Z" ; <${CLAIM}confidenceLabel> "high" ;
       <${CLAIM}status> "accepted" .`);
});

describe('memory_ask scoping', () => {
  it('what_do_i_know_about excludes another user\'s rows and labels, keeps own + worldview + schema labels', async () => {
    const rows = await ask('alice', { template: 'what_do_i_know_about', entity: 'Anna' });
    const values = rows.map(r => r.value.value);
    expect(values).toContain(`${E}Hamburg`);
    expect(values).toContain('30');
    expect(values).not.toContain(`${E}Bremen`);
    expect(values).not.toContain(`${E}Bob2`);
    const living = rows.find(r => r.value.value === `${E}Hamburg`)!;
    expect(living.propertyLabel?.value).toBe('lives in');
    const hamburg = await ask('alice', { template: 'what_do_i_know_about', entity: 'Hamburg' });
    expect(JSON.stringify(hamburg)).not.toContain('BOBS-PRIVATE-NAME');
  });

  it('what_do_i_know_about resolves the value label from the user\'s own graph', async () => {
    const rows = await ask('alice', { template: 'what_do_i_know_about', entity: 'Anna' });
    const living = rows.find(r => r.value.value === `${E}Hamburg`)!;
    expect(living.valueLabel?.value).toBe('Hamburg (Alice)');
    const bobRows = await ask('bob', { template: 'what_do_i_know_about', entity: 'Anna' });
    expect(bobRows.find(r => r.value.value === `${E}Hamburg`)).toBeUndefined();
    expect(bobRows.map(r => r.value.value)).toContain(`${E}Bremen`);
  });

  it('who_knows_whom excludes another user\'s rows and shows schema labels where relevant', async () => {
    const rows = await ask('alice', { template: 'who_knows_whom' });
    const p2 = rows.map(r => r.person2.value);
    expect(p2).toContain(`${E}Alice2`);
    expect(p2).not.toContain(`${E}Bob2`);
  });

  it('recent_facts / facts_by_confidence resolve labels without using another user\'s graph', async () => {
    for (const input of [{ template: 'recent_facts' }, { template: 'facts_by_confidence', confidence: 'high' }]) {
      const rows = await ask('alice', input);
      expect(rows).toHaveLength(1);
      expect(rows[0].pLabel?.value).toBe('lives in');
      expect(rows[0].sLabel?.value).toBe('Hamburg (Alice)');
      const bobRows = await ask('bob', input);
      expect(bobRows[0].sLabel?.value).toBe('BOBS-PRIVATE-NAME');
      expect(JSON.stringify(rows)).not.toContain('BOBS-PRIVATE-NAME');
    }
  });
});
