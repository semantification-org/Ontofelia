/**
 * memory_explain shows what replaced a superseded claim and when, under the
 * same read scoping as every other claim reader. Real round-trips.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '@ontofelia/core';
import { OxigraphAdapter, KnowledgeEngine } from '@ontofelia/semantic-memory';
import { MemoryExplainTool } from '../memory/memory_explain.js';

const AGENT = 'ontofelia';
const LIVES = 'urn:ontofelia:core#livesIn';
const ANNA = 'urn:ontofelia:entity:Anna';

let store: OxigraphAdapter;
let engine: KnowledgeEngine;
let explain: MemoryExplainTool;

function ctx(senderId: string): ToolContext {
  return { agentId: AGENT, sessionId: 's', workspacePath: '/tmp', channelType: 'cli',
    senderId, isOwner: false } as unknown as ToolContext;
}

const livesIn = (user: string, place: string, subject = 'Anna') => engine.storeFact(
  { subject, subjectType: 'Person', predicate: 'livesIn', object: place,
    objectType: 'literal', sourceKind: 'user' },
  { agentId: AGENT, userId: user, sessionId: 's', isOwner: false } as never,
);

async function explainFor(user: string, entity = ANNA) {
  const res = await explain.execute({ entity }, ctx(user));
  expect(res.success).toBe(true);
  return (res.output as { provenance: Array<Record<string, string | undefined>> }).provenance;
}

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'explain-superseded-')), port: 0, endpoint: '' } as never);
  engine = new KnowledgeEngine(store as never);
  explain = new MemoryExplainTool(store as never);
  await store.update(`INSERT DATA { GRAPH <urn:shared:ontology> {
    <${LIVES}> a <http://www.w3.org/2002/07/owl#FunctionalProperty> . } }`);
});

describe('memory_explain on a superseded claim', () => {
  it('says what replaced it and when', async () => {
    await livesIn('alice', 'Hamburg');
    await livesIn('alice', 'Berlin');
    const prov = await explainFor('alice');
    const old = prov.find(p => p.object === 'Hamburg')!;
    const current = prov.find(p => p.object === 'Berlin')!;
    expect(old.status).toBe('superseded');
    expect(old.supersededByObject).toBe('Berlin');
    expect(old.supersededBy).toMatch(/^urn:claim:/);
    expect(Number.isNaN(Date.parse(old.supersededAt!))).toBe(false);
    expect(old.explanation).toBe(`superseded by Berlin at ${old.supersededAt}`);
    expect(current.status).toBe('accepted');
    expect(current.explanation).toBeUndefined();
  });

  it('shows nothing of the replacement to a user who may not read the claim', async () => {
    // "User" denotes the speaker, so these claims live in Bob's private graph.
    const BOB = 'urn:ontofelia:entity:user:bob';
    await livesIn('bob', 'Hamburg', 'User');
    await livesIn('bob', 'Berlin', 'User');
    const own = await explainFor('bob', BOB);
    expect(own.find(p => p.object === 'Hamburg')?.supersededByObject).toBe('Berlin');
    const prov = await explainFor('alice', BOB);
    expect(prov).toEqual([]);
  });
});
