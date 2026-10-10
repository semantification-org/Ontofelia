/**
 * Claims live in one agent-wide graph, including the provenance of facts that
 * are stored in a user's private graph. Every user-facing reader must only
 * see (and retract) claims asserted in the worldview or the acting user's own
 * graph. Real round-trips: KnowledgeEngine.storeFact on an embedded store.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '@ontofelia/core';
import { OxigraphAdapter, KnowledgeEngine } from '@ontofelia/semantic-memory';
import { MemoryAskTool } from '../memory/memory_ask.js';
import { MemoryExplainTool } from '../memory/memory_explain.js';
import { MemoryRetractTool } from '../memory/memory_retract.js';

const AGENT = 'ontofelia';
const BOB_GRAPH = `urn:${AGENT}:user:bob`;
const ALICE_GRAPH = `urn:${AGENT}:user:alice`;
const CLAIMS = `urn:${AGENT}:claims`;
const BOB_NODE = 'urn:ontofelia:entity:user:bob';
const SECRET = 'SecretBobThing';

let store: OxigraphAdapter;
let engine: KnowledgeEngine;
let ask: MemoryAskTool;
let explain: MemoryExplainTool;
let retract: MemoryRetractTool;

function ctx(senderId: string): ToolContext {
  return { agentId: AGENT, sessionId: 's', workspacePath: '/tmp', channelType: 'cli',
    senderId, isOwner: false } as unknown as ToolContext;
}

async function storeAs(user: string, subject: string, subjectType: string | undefined,
  predicate: string, object: string) {
  const res = await engine.storeFact(
    { subject, subjectType: subjectType as never, predicate, object, objectType: 'literal',
      sourceKind: 'user', confidenceLabel: 'high' },
    { agentId: AGENT, userId: user, sessionId: `s-${user}`, isOwner: false } as never,
  );
  expect(res.success).toBe(true);
  return res;
}

async function rows(tool: MemoryAskTool, user: string, input: Record<string, string>) {
  const res = await tool.execute(input, ctx(user));
  expect(res.success).toBe(true);
  return JSON.stringify((res.output as { results: unknown[] }).results);
}

async function graphHas(graph: string, o: string): Promise<boolean> {
  return store.ask(`ASK { GRAPH <${graph}> { ?s ?p "${o}" } }`);
}

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'claim-scoping-')), port: 0, endpoint: '' } as never);
  engine = new KnowledgeEngine(store as never);
  ask = new MemoryAskTool(store as never);
  explain = new MemoryExplainTool(store as never);
  retract = new MemoryRetractTool(store as never);

  await storeAs('bob', 'User', undefined, 'likes', SECRET);
  await storeAs('alice', 'User', undefined, 'likes', 'AliceOwnThing');
  await storeAs('alice', 'Anna', 'Person', 'hasNickname', 'WorldviewThing');
});

describe('memory_ask claim templates', () => {
  it('precondition: the fixture really put the claim in the claims graph, tagged with Bob\'s graph', async () => {
    expect(await store.ask(
      `ASK { GRAPH <${CLAIMS}> { ?c <urn:shared:ontology#claimObject> "${SECRET}" ;
         <urn:shared:ontology#assertedInGraph> <${BOB_GRAPH}> } }`)).toBe(true);
  });

  for (const [name, input] of [
    ['recent_facts', { template: 'recent_facts' }],
    ['facts_by_confidence', { template: 'facts_by_confidence', confidence: 'high' }],
  ] as const) {
    it(`${name}: Alice does not see Bob's private fact, still sees her own and the worldview's`, async () => {
      const out = await rows(ask, 'alice', input);
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(BOB_NODE);
      expect(out).toContain('AliceOwnThing');
      expect(out).toContain('WorldviewThing');
    });

    it(`${name}: Bob sees his own fact, not Alice's`, async () => {
      const out = await rows(ask, 'bob', input);
      expect(out).toContain(SECRET);
      expect(out).toContain('WorldviewThing');
      expect(out).not.toContain('AliceOwnThing');
    });

    it(`${name}: without a sender only worldview claims show`, async () => {
      const res = await ask.execute(input, { ...ctx("x"), senderId: undefined } as unknown as ToolContext);
      const out = JSON.stringify((res.output as { results: unknown[] }).results);
      expect(out).toContain('WorldviewThing');
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain('AliceOwnThing');
    });
  }
});

describe('memory_explain', () => {
  const explainOf = async (user: string) => {
    const res = await explain.execute({ entity: BOB_NODE }, ctx(user));
    expect(res.success).toBe(true);
    return (res.output as { provenance: Array<{ object: string }> }).provenance;
  };

  it('Alice gets nothing for Bob\'s entity', async () => {
    expect(await explainOf('alice')).toEqual([]);
  });

  it('Bob gets the provenance of his own fact', async () => {
    const prov = await explainOf('bob');
    expect(prov.map(p => p.object)).toContain(SECRET);
  });
});

describe('memory_retract', () => {
  async function bobPredicate(): Promise<string> {
    const r = await store.query(
      `SELECT ?p WHERE { GRAPH <${CLAIMS}> { ?c <urn:shared:ontology#claimObject> "${SECRET}" ;
         <urn:shared:ontology#claimPredicate> ?p } }`);
    return (r as unknown as { bindings: Array<{ p: { value: string } }> }).bindings[0].p.value;
  }
  const claimCount = async () => {
    const r = await store.query(
      `SELECT (COUNT(?c) AS ?n) WHERE { GRAPH <${CLAIMS}> { ?c <urn:shared:ontology#claimObject> "${SECRET}" } }`);
    return Number((r as unknown as { bindings: Array<{ n: { value: string } }> }).bindings[0].n.value);
  };

  it('Alice naming Bob\'s graph is refused with a clear message and nothing changes', async () => {
    const predicate = await bobPredicate();
    const res = await retract.execute(
      { subject: BOB_NODE, predicate, object: SECRET, graph: BOB_GRAPH }, ctx('alice'));
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Refused/);
    expect(res.error).toMatch(/Nothing was changed/);
    expect(await graphHas(BOB_GRAPH, SECRET)).toBe(true);
    expect(await claimCount()).toBe(1);
  });

  it('Alice retracting the same subject from the worldview (default graph) does not touch Bob\'s claim', async () => {
    const predicate = await bobPredicate();
    await retract.execute({ subject: BOB_NODE, predicate, object: SECRET }, ctx('alice'));
    expect(await graphHas(BOB_GRAPH, SECRET)).toBe(true);
    expect(await claimCount()).toBe(1);
  });

  it('Bob can retract his own fact: triple and claim are gone', async () => {
    const predicate = await bobPredicate();
    const res = await retract.execute(
      { subject: BOB_NODE, predicate, object: SECRET, graph: BOB_GRAPH }, ctx('bob'));
    expect(res.success).toBe(true);
    expect(await graphHas(BOB_GRAPH, SECRET)).toBe(false);
    expect(await claimCount()).toBe(0);
  });

  it('a user can still retract from the worldview, and Alice\'s own graph stays untouched', async () => {
    const res = await retract.execute(
      { subject: 'urn:ontofelia:entity:Anna', predicate: 'urn:ontofelia:core#hasNickname',
        object: 'WorldviewThing' }, ctx('alice'));
    expect(res.success).toBe(true);
    expect(await graphHas(ALICE_GRAPH, 'AliceOwnThing')).toBe(true);
  });
});
