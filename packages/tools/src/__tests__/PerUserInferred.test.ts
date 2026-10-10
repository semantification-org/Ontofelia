/**
 * memory_retract recomputes the inferred graph of the graph it retracted
 * from, and memory_reflect never surfaces another user's derivations.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '@ontofelia/core';
import { OxigraphAdapter, KnowledgeEngine, GraphUriResolver } from '@ontofelia/semantic-memory';
import { MemoryRetractTool } from '../memory/memory_retract.js';
import { MemoryReflectTool } from '../memory/memory_reflect.js';

const AGENT = 'ontofelia';
const CORE = 'urn:ontofelia:core#';
const BOB_INF = GraphUriResolver.getUserInferredGraph(AGENT, 'bob');
let store: OxigraphAdapter;

const ctx = (senderId: string): ToolContext => ({
  agentId: AGENT, sessionId: 's', workspacePath: '/tmp', channelType: 'cli', senderId, isOwner: false,
}) as unknown as ToolContext;

async function graphText(graph: string): Promise<string> {
  const r = await store.query(`SELECT ?s ?p ?o WHERE { GRAPH <${graph}> { ?s ?p ?o } }`);
  return (r.bindings ?? []).map(b => `${b.s.value} ${b.p.value} ${b.o.value}`).join('\n');
}

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'pui-tools-')), port: 0, endpoint: '' } as never);
  await store.update(`INSERT DATA { GRAPH <urn:shared:ontology> {
    <${CORE}likes> <http://www.w3.org/2000/01/rdf-schema#subPropertyOf> <${CORE}enjoys> . } }`);
  await new KnowledgeEngine(store as never).storeFact(
    { subject: 'User', subjectType: 'Person', predicate: 'likes', object: 'SecretBobThing', objectType: 'literal', sourceKind: 'user' },
    { agentId: AGENT, userId: 'bob', sessionId: 's', isOwner: false },
  );
});

describe('private derivations', () => {
  it('exist for Bob and are not shown to Alice by memory_reflect', async () => {
    expect(await graphText(BOB_INF)).toContain('SecretBobThing');
    const res = await new MemoryReflectTool(store as never).execute({}, ctx('alice'));
    expect(String(res.output)).not.toContain('SecretBobThing');
  });

  it('memory_retract by Bob removes the fact and its derivation', async () => {
    const res = await new MemoryRetractTool(store as never).execute({
      subject: 'urn:ontofelia:entity:user:bob', predicate: `${CORE}likes`,
      graph: GraphUriResolver.getUserGraph(AGENT, 'bob'),
    }, ctx('bob'));
    expect(res.success).toBe(true);
    expect(await graphText(BOB_INF)).not.toContain('SecretBobThing');
  });
});
