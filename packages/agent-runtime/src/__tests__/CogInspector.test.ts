import { describe, it, expect, beforeEach } from 'vitest';
import type { TriplestoreAdapter } from '@ontofelia/core';
import {
  OxigraphAdapter,
  GraphRegistry,
  GraphUriResolver,
  EpisodicMemory,
} from '@ontofelia/semantic-memory';
import { WorkingMemory } from '../cognitive/WorkingMemory.js';
import { GoalStack } from '../cognitive/GoalStack.js';
import { CogInspector } from '../cognitive/CogInspector.js';

const AGENT = 'ontofelia';
const SESSION = 'sess1';
const COGT = 'urn:shared:ontology#cog/';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/cog-inspector-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

const dt = (iso: string) => `"${iso}"^^<${XSD}dateTime>`;

describe('CogInspector', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let inspector: CogInspector;
  let goalUri: string;
  let episodeUri: string;

  const CYCLES_GRAPH = GraphUriResolver.getCogCyclesGraph(AGENT, SESSION);
  const META_GRAPH = GraphUriResolver.getCogMetaGraph(AGENT);
  const CYCLE_URI = `urn:${AGENT}:cog:cycle:cyc1`;

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    inspector = new CogInspector(store, registry, AGENT);

    // Two cycles + their phases, written in the CycleManager format.
    await store.update(`INSERT DATA { GRAPH <${CYCLES_GRAPH}> {
      <${CYCLE_URI}> <${RDF_TYPE}> <${COGT}Cycle> ; <${COGT}cycleStatus> "completed" ;
        <${COGT}startedAt> ${dt('2026-06-01T11:00:00.000Z')} ; <${COGT}endedAt> ${dt('2026-06-01T11:00:00.400Z')} .
      <${CYCLE_URI}_1> <${RDF_TYPE}> <${COGT}Phase> ; <${COGT}partOfCycle> <${CYCLE_URI}> ;
        <${COGT}phaseKind> "perception" ; <${COGT}ordinal> "1"^^<${XSD}integer> ;
        <${COGT}startedAt> ${dt('2026-06-01T11:00:00.000Z')} ; <${COGT}endedAt> ${dt('2026-06-01T11:00:00.000Z')} .
      <${CYCLE_URI}_3> <${RDF_TYPE}> <${COGT}Phase> ; <${COGT}partOfCycle> <${CYCLE_URI}> ;
        <${COGT}phaseKind> "deliberation" ; <${COGT}ordinal> "3"^^<${XSD}integer> ;
        <${COGT}startedAt> ${dt('2026-06-01T11:00:00.000Z')} ; <${COGT}endedAt> ${dt('2026-06-01T11:00:00.400Z')} .
      <urn:${AGENT}:cog:cycle:cyc2> <${RDF_TYPE}> <${COGT}Cycle> ; <${COGT}cycleStatus> "completed" ;
        <${COGT}startedAt> ${dt('2026-06-01T11:30:00.000Z')} ; <${COGT}endedAt> ${dt('2026-06-01T11:30:01.000Z')} .
    } }`);

    // A reflective marker reflecting on cyc1 with an impasse flag.
    await store.update(`INSERT DATA { GRAPH <${META_GRAPH}> {
      <urn:m:1> <${RDF_TYPE}> <${COGT}ReflectiveMarker> ; <${COGT}reflectsOn> <${CYCLE_URI}> ;
        <${COGT}flaggedImpasse> "tool-error" ; <${COGT}noted> "cyc1 hit an impasse" ;
        <${COGT}createdAt> ${dt('2026-06-01T11:00:00.400Z')} .
    } }`);

    // An episode written during cyc1, referencing an entity.
    const em = new EpisodicMemory(store, AGENT);
    episodeUri = await em.append({
      episodeType: 'message-received',
      occurredAt: new Date('2026-06-01T10:59:00.000Z'),
      sessionId: SESSION,
      cycleId: 'cyc1',
      about: ['urn:entity:weather'],
      payload: 'user asked about the weather',
    });

    // A goal triggered by that episode.
    const gs = new GoalStack(store, registry, AGENT, SESSION);
    goalUri = await gs.push(
      {
        goalType: 'urn:goaltype:answer',
        goalLabel: 'Answer the weather question',
        priority: 0.8,
        triggeredByEpisode: episodeUri,
      },
      new Date('2026-06-01T10:59:30.000Z'),
    );

    // Working-memory entries for cyc1: a retrieval pulling the episode and an
    // action serving the goal.
    const wm = new WorkingMemory(store, registry, AGENT, SESSION, 'cyc1');
    const goalPhase = `${CYCLE_URI}_3`;
    await wm.write(
      { buffer: 'retrievalBuffer', entryKind: 'episode-ref', payload: 'recalled weather episode', salience: 0.6, refersTo: episodeUri },
      `${CYCLE_URI}_2`,
    );
    await wm.write(
      { buffer: 'actionBuffer', entryKind: 'action-proposal', payload: 'reply with forecast', salience: 0.9, forGoal: goalUri },
      goalPhase,
    );
  });

  it('lists cycles newest-first', async () => {
    const cycles = await inspector.listCycles(SESSION);
    expect(cycles.map((c) => c.cycleId)).toEqual(['cyc2', 'cyc1']);
    const c1 = cycles.find((c) => c.cycleId === 'cyc1')!;
    expect(c1.status).toBe('completed');
    expect(c1.durationMs).toBe(400);
  });

  it('returns full cycle detail: phases, buffer, episodes, marker', async () => {
    const d = await inspector.getCycle(SESSION, 'cyc1');
    expect(d).toBeDefined();
    expect(d!.phases.map((p) => p.ordinal)).toEqual([1, 3]);
    expect(d!.phases[0].phaseKind).toBe('perception');
    expect(d!.buffer.length).toBe(2);
    expect(d!.episodes.map((e) => e.uri)).toEqual([episodeUri]);
    expect(d!.marker?.flaggedImpasse).toEqual(['tool-error']);
  });

  it('returns undefined for an unknown cycle', async () => {
    expect(await inspector.getCycle(SESSION, 'nope')).toBeUndefined();
  });

  it('lists goals and recent episodes', async () => {
    const goals = await inspector.listGoals(SESSION);
    expect(goals.map((g) => g.uri)).toContain(goalUri);

    const all = await inspector.listEpisodes();
    expect(all.map((e) => e.uri)).toContain(episodeUri);

    const byEntity = await inspector.listEpisodes('urn:entity:weather');
    expect(byEntity.map((e) => e.uri)).toEqual([episodeUri]);
  });

  it('explains the response chain: action → goal → episode', async () => {
    const exp = await inspector.explainResponse(SESSION, 'cyc1');
    expect(exp.found).toBe(true);
    expect(exp.actions.length).toBe(1);
    const a = exp.actions[0];
    expect(a.forGoal).toBe(goalUri);
    expect(a.goal?.uri).toBe(goalUri);
    expect(a.triggeringEpisode?.uri).toBe(episodeUri);
    expect(exp.retrievals.length).toBe(1);
    expect(exp.retrievals[0].episode?.uri).toBe(episodeUri);
  });

  it('reports not-found for a cycle with no working memory', async () => {
    const exp = await inspector.explainResponse(SESSION, 'cyc2');
    expect(exp.found).toBe(false);
    expect(exp.actions).toEqual([]);
  });
});
