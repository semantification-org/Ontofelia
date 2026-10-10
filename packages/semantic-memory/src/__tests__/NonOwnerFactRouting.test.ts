/**
 * Privacy routing: a non-owner's facts must never reach the shared worldview
 * through the model-chosen `sourceKind`. Real round-trips on the embedded
 * OxigraphAdapter.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import type { FactInput } from '../types.js';

const AGENT = 'ontofelia';
const ALICE_GRAPH = `urn:${AGENT}:user:alice`;
const OWNER_GRAPH = `urn:${AGENT}:user:boss`;
const WORLDVIEW = `urn:${AGENT}:worldview`;
const CLAIMS = `urn:${AGENT}:claims`;

const aliceCtx = { agentId: AGENT, userId: 'alice', sessionId: 's-a', isOwner: false };
const ownerCtx = { agentId: AGENT, userId: 'boss', sessionId: 's-o', isOwner: true };

type Kind = FactInput['sourceKind'];
const KINDS: Kind[] = ['user', 'agent', 'tool', undefined];

let store: OxigraphAdapter;
let engine: KnowledgeEngine;

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'nonowner-routing-')), port: 0, endpoint: '',
  } as never);
  engine = new KnowledgeEngine(store as never);
});

function selfFact(kind: Kind): FactInput {
  return { subject: 'user', predicate: 'hasDiagnosis', object: `Secret-${kind ?? 'none'}`,
    objectType: 'literal', ...(kind ? { sourceKind: kind } : {}) };
}

async function inGraph(graph: string, o: string): Promise<boolean> {
  return store.ask(`ASK { GRAPH <${graph}> { ?s ?p "${o}" } }`);
}

describe('non-owner self-facts stay private, whatever the sourceKind', () => {
  for (const kind of KINDS) {
    it(`sourceKind ${kind}: lands in the user graph, not the worldview`, async () => {
      const res = await engine.storeFact(selfFact(kind), aliceCtx);
      expect(res.success).toBe(true);
      const o = `Secret-${kind ?? 'none'}`;
      expect(await inGraph(ALICE_GRAPH, o)).toBe(true);
      expect(await inGraph(WORLDVIEW, o)).toBe(false);
      expect(await store.ask(
        `ASK { GRAPH <${CLAIMS}> { ?c <urn:shared:ontology#claimObject> "${o}" ;
           <urn:shared:ontology#assertedInGraph> <${ALICE_GRAPH}> } }`)).toBe(true);
    });
  }

  it('Bob sees none of them, Alice sees all', async () => {
    for (const kind of KINDS) await engine.storeFact(selfFact(kind), aliceCtx);
    const bob = await engine.getRecentFacts(AGENT, 50, 'bob');
    const alice = await engine.getRecentFacts(AGENT, 50, 'alice');
    for (const kind of KINDS) {
      const o = `Secret-${kind ?? 'none'}`;
      expect(bob).not.toContain(o);
      expect(alice).toContain(o);
    }
  });
});

describe('non-owner agent/tool/missing source never opens a path into the worldview', () => {
  for (const kind of ['agent', 'tool', undefined] as Kind[]) {
    it(`third-party fact with sourceKind ${kind} goes to Alice's graph`, async () => {
      const res = await engine.storeFact(
        { subject: 'Anna', subjectType: 'Person', predicate: 'livesIn', object: 'Cologne',
          objectType: 'literal', ...(kind ? { sourceKind: kind } : {}) },
        aliceCtx,
      );
      expect(res.success).toBe(true);
      expect(await inGraph(ALICE_GRAPH, 'Cologne')).toBe(true);
      expect(await inGraph(WORLDVIEW, 'Cologne')).toBe(false);
      expect(await engine.getRecentFacts(AGENT, 50, 'bob')).not.toContain('Cologne');
      expect(await engine.getRecentFacts(AGENT, 50, 'alice')).toContain('Cologne');
    });
  }

  it('previewFacts and isDuplicate follow the same routing', async () => {
    const fact: FactInput = { subject: 'Anna', subjectType: 'Person', predicate: 'livesIn',
      object: 'Cologne', objectType: 'literal', sourceKind: 'agent' };
    const [before] = await engine.previewFacts([fact], aliceCtx);
    expect(before.targetGraph).toBe(ALICE_GRAPH);
    expect(before.duplicate).toBe(false);
    await engine.storeFact(fact, aliceCtx);
    const [after] = await engine.previewFacts([fact], aliceCtx);
    expect(after.targetGraph).toBe(ALICE_GRAPH);
    expect(after.duplicate).toBe(true);
  });

  it('a later conflicting agent fact supersedes only inside Alice\'s graph', async () => {
    const f = (o: string): FactInput => ({ subject: 'user', predicate: 'livesIn', object: o,
      objectType: 'literal', sourceKind: 'agent' });
    await engine.storeFact(f('Cologne'), aliceCtx);
    await engine.storeFact(f('Berlin'), aliceCtx);
    expect(await inGraph(ALICE_GRAPH, 'Berlin')).toBe(true);
    expect(await inGraph(WORLDVIEW, 'Berlin')).toBe(false);
  });
});

describe('unchanged behaviour (asserted so the change stays deliberate)', () => {
  it('owner: an agent-sourced world fact still goes to the worldview', async () => {
    await engine.storeFact(
      { subject: 'Anna', subjectType: 'Person', predicate: 'livesIn', object: 'Cologne',
        objectType: 'literal', sourceKind: 'agent' }, ownerCtx);
    expect(await inGraph(WORLDVIEW, 'Cologne')).toBe(true);
    expect(await inGraph(OWNER_GRAPH, 'Cologne')).toBe(false);
  });

  it('owner: a self-fact still goes to the owner\'s user graph', async () => {
    for (const kind of ['agent', 'user'] as Kind[]) {
      await engine.storeFact(
        { ...selfFact(kind) }, ownerCtx);
      expect(await inGraph(OWNER_GRAPH, `Secret-${kind}`)).toBe(true);
      expect(await inGraph(WORLDVIEW, `Secret-${kind}`)).toBe(false);
    }
  });

  it('non-owner: a sourceKind user third-party fact still goes to the worldview', async () => {
    await engine.storeFact(
      { subject: 'Anna', subjectType: 'Person', predicate: 'livesIn', object: 'Cologne',
        objectType: 'literal', sourceKind: 'user' }, aliceCtx);
    expect(await inGraph(WORLDVIEW, 'Cologne')).toBe(true);
    expect(await inGraph(ALICE_GRAPH, 'Cologne')).toBe(false);
  });

  it('no userId: an agent-sourced fact still goes to the worldview', async () => {
    await engine.storeFact(
      { subject: 'Anna', subjectType: 'Person', predicate: 'livesIn', object: 'Cologne',
        objectType: 'literal', sourceKind: 'agent' },
      { agentId: AGENT, sessionId: 's', isOwner: false });
    expect(await inGraph(WORLDVIEW, 'Cologne')).toBe(true);
  });
});
