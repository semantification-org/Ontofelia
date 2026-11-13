/**
 * Repro: retracting a worldview fact leaves user inferences that depended on it.
 *
 * A user's inferences are derived from the worldview plus that user's graph
 * (`GraphUriResolver.getInferenceScope`). `memory_retract` rebuilds only the
 * inferred graph of the graph it deleted from (and of the caller's own
 * consolidated copy). Retracting a WORLDVIEW fact therefore leaves the user's
 * inferred graph untouched, and a triple that was derived from the retracted
 * fact stays behind.
 *
 * Real OxigraphAdapter, real KnowledgeEngine with the real reasoner, and the
 * real memory_retract tool; nothing is mocked. The derivation uses a transitive
 * property: worldview `B p C` and user `A p B` give the user `A p C`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ToolContext } from '@ontofelia/core';
import { OxigraphAdapter, KnowledgeEngine } from '@ontofelia/semantic-memory';
import { MemoryRetractTool } from '../memory/memory_retract.js';

const AGENT = 'ontofelia';
const ONTOLOGY = 'urn:shared:ontology';
const WORLDVIEW = `urn:${AGENT}:worldview`;
const USER = 'anna';
const USER_GRAPH = `urn:${AGENT}:user:${USER}`;
const USER_INFERRED = `urn:${AGENT}:inferred:user:${USER}`;
const P = 'urn:repro:chain';
const A = 'urn:repro:A';
const B = 'urn:repro:B';
const C = 'urn:repro:C';

let store: OxigraphAdapter;
let engine: KnowledgeEngine;
let retract: MemoryRetractTool;

const ctx = (senderId: string): ToolContext =>
  ({ agentId: AGENT, sessionId: 's', workspacePath: '/tmp', channelType: 'cli', senderId, isOwner: false }) as unknown as ToolContext;

const holds = (graph: string, s: string, o: string) =>
  store.ask(`ASK { GRAPH <${graph}> { <${s}> <${P}> <${o}> } }`);

beforeEach(async () => {
  store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph', type: 'embedded',
    dataDir: mkdtempSync(join(tmpdir(), 'wv-retract-')), port: 0, endpoint: '',
  } as never);
  engine = new KnowledgeEngine(store as never);
  retract = new MemoryRetractTool(store as never);

  await store.update(`INSERT DATA {
    GRAPH <${ONTOLOGY}> { <${P}> a <http://www.w3.org/2002/07/owl#TransitiveProperty> . }
    GRAPH <${WORLDVIEW}> { <${B}> <${P}> <${C}> . }
    GRAPH <${USER_GRAPH}> { <${A}> <${P}> <${B}> . }
  }`);
  await engine.rebuildInferredGraphFor(AGENT, USER_GRAPH);
  // Setup check shared by both tests: the user's inference exists, derived across both graphs.
  expect(await holds(USER_INFERRED, A, C)).toBe(true);
});

describe('memory_retract and the inferences of a user graph', () => {
  it('control: retracting the USER fact removes the inference from the user\'s inferred graph', async () => {
    const res = await retract.execute({ subject: A, predicate: P, object: B, graph: USER_GRAPH }, ctx(USER));
    expect(res.success).toBe(true);
    expect(await holds(USER_GRAPH, A, B)).toBe(false);
    expect(await holds(USER_INFERRED, A, C)).toBe(false);
  });

  it('control: retracting the worldview fact removes the fact itself and leaves the user fact', async () => {
    const res = await retract.execute({ subject: B, predicate: P, object: C }, ctx(USER));
    expect(res.success).toBe(true);
    expect(await holds(WORLDVIEW, B, C)).toBe(false);
    expect(await holds(USER_GRAPH, A, B)).toBe(true);
  });

  it.fails('retracting a worldview fact removes the user inferences that depended on it', async () => {
    const res = await retract.execute({ subject: B, predicate: P, object: C }, ctx(USER));
    expect(res.success).toBe(true);
    expect(await holds(WORLDVIEW, B, C)).toBe(false);
    // `A p C` was derived from the retracted `B p C`; it must not outlive it.
    expect(await holds(USER_INFERRED, A, C)).toBe(false);
  });
});
