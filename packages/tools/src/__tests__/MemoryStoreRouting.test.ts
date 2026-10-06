/**
 * memory_store: the model-chosen `source` argument must never route a
 * non-owner's fact into the shared worldview.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '@ontofelia/core';
import { OxigraphAdapter, KnowledgeEngine } from '@ontofelia/semantic-memory';
import { MemoryStoreTool } from '../memory/memory_store.js';

const AGENT = 'ontofelia';
const ALICE_GRAPH = `urn:${AGENT}:user:alice`;
const WORLDVIEW = `urn:${AGENT}:worldview`;

let store: OxigraphAdapter;
let engine: KnowledgeEngine;
let tool: MemoryStoreTool;

function ctx(senderId: string, isOwner: boolean): ToolContext {
  return { agentId: AGENT, sessionId: 's', workspacePath: '/tmp', channelType: 'cli',
    senderId, isOwner } as unknown as ToolContext;
}

async function inGraph(graph: string, o: string): Promise<boolean> {
  return store.ask(`ASK { GRAPH <${graph}> { ?s ?p "${o}" } }`);
}

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'store-routing-')), port: 0, endpoint: '' } as never);
  engine = new KnowledgeEngine(store as never);
  tool = new MemoryStoreTool(engine);
});

describe('memory_store as a non-owner', () => {
  for (const source of [undefined, 'agent', 'tool']) {
    it(`source ${source ?? 'omitted'}: self-fact and third-party fact stay out of the worldview`, async () => {
      const tag = source ?? 'omitted';
      const self = await tool.execute(
        { subject: 'user', subjectType: 'Person', predicate: 'hasDiagnosis',
          object: `Secret-${tag}`, objectType: 'literal', ...(source ? { source } : {}) },
        ctx('alice', false));
      const other = await tool.execute(
        { subject: 'Anna', subjectType: 'Person', predicate: 'livesIn',
          object: `City-${tag}`, objectType: 'literal', ...(source ? { source } : {}) },
        ctx('alice', false));
      expect(self.success).toBe(true);
      expect(other.success).toBe(true);
      expect(await inGraph(ALICE_GRAPH, `Secret-${tag}`)).toBe(true);
      expect(await inGraph(ALICE_GRAPH, `City-${tag}`)).toBe(true);
      expect(await inGraph(WORLDVIEW, `Secret-${tag}`)).toBe(false);
      expect(await inGraph(WORLDVIEW, `City-${tag}`)).toBe(false);
      const bob = await engine.getRecentFacts(AGENT, 50, 'bob');
      expect(bob).not.toContain(`Secret-${tag}`);
      expect(bob).not.toContain(`City-${tag}`);
    });
  }

  it('owner: an agent-sourced world fact still goes to the worldview', async () => {
    const res = await tool.execute(
      { subject: 'Anna', subjectType: 'Person', predicate: 'livesIn',
        object: 'OwnerCity', objectType: 'literal' }, ctx('boss', true));
    expect(res.success).toBe(true);
    expect(await inGraph(WORLDVIEW, 'OwnerCity')).toBe(true);
  });
});
