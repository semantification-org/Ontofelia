import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphRegistry, GraphUriResolver } from '@ontofelia/semantic-memory';
import type { MessageEnvelope, TriplestoreAdapter } from '@ontofelia/core';
import { CycleManager } from '../cognitive/CycleManager.js';
import { GoalStack, RESPOND_TO_USER } from '../cognitive/GoalStack.js';

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const ANSWER = `${COGT}AnswerQuestion`;

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/cminit-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

function initiativeEnvelope(text: string, goalUri: string, sessionId: string): MessageEnvelope {
  return {
    id: 'init1',
    channel: 'system',
    accountId: 'initiative',
    chatType: 'initiative',
    sender: { id: 'initiative', channelPrefix: 'system', isOwner: true },
    timestamp: new Date().toISOString(),
    text,
    mentions: [],
    attachments: [],
    routingHints: { sessionId, initiativeGoalId: goalUri },
  };
}

describe('CycleManager — initiative mode', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let cm: CycleManager;

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    cm = new CycleManager(store, registry, AGENT);
  });

  it('does NOT seed RESPOND_TO_USER and records an initiative episode', async () => {
    const SESS = 'sessInit1';
    const gs = new GoalStack(store, registry, AGENT, SESS);
    const goalUri = await gs.push({
      goalType: ANSWER,
      goalLabel: 'keep working on the report',
      priority: 0.8,
      mandatedBy: 'urn:ontofelia:cog:ep:mandate-1',
    });

    await cm.runCycle(
      initiativeEnvelope('Initiative wake for the report goal', goalUri, SESS),
      async (_recordTool, prepareGoals) => {
        await prepareGoals(SESS);
        return { text: 'made progress', sessionId: SESS };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { goalsEnabled: true, mode: 'initiative', initiativeGoalUri: goalUri },
    );

    // No implicit RESPOND_TO_USER goal was created in the session goal graph.
    const goalsGraph = GraphUriResolver.getCogGoalsSessionGraph(AGENT, SESS);
    const respond = await store.query(
      `SELECT ?g WHERE { GRAPH <${goalsGraph}> { ?g <${COGT}goalType> <${RESPOND_TO_USER}> } }`,
    );
    expect(respond.bindings ?? []).toHaveLength(0);

    // An initiative episode was recorded, linked to the triggering goal.
    const epGraph = GraphUriResolver.getCogEpisodicGraph(AGENT);
    const eps = await store.query(
      `SELECT ?e ?p WHERE { GRAPH <${epGraph}> {
         ?e <${COGT}episodeType> "initiative" ; <${COGT}payload> ?p ;
            <${COGT}partOfGoal> <${goalUri}> } }`,
    );
    expect((eps.bindings ?? []).length).toBeGreaterThanOrEqual(1);
    expect(eps.bindings![0].p.value).toContain('outcome:');
  });

  it('conversational mode still seeds RESPOND_TO_USER on an empty stack', async () => {
    const SESS = 'sessConv1';
    await cm.runCycle(
      {
        id: 'm1',
        channel: 'webchat',
        accountId: 'a',
        chatType: 'web',
        sender: { id: 'u1', channelPrefix: 'webchat', isOwner: true },
        timestamp: new Date().toISOString(),
        text: 'hello',
        mentions: [],
        attachments: [],
      },
      async (_recordTool, prepareGoals) => {
        await prepareGoals(SESS);
        return { text: 'hi', sessionId: SESS };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { goalsEnabled: true },
    );
    const goalsGraph = GraphUriResolver.getCogGoalsSessionGraph(AGENT, SESS);
    const respond = await store.query(
      `SELECT ?g WHERE { GRAPH <${goalsGraph}> { ?g <${COGT}goalType> <${RESPOND_TO_USER}> } }`,
    );
    expect((respond.bindings ?? []).length).toBeGreaterThanOrEqual(1);
    // And no initiative episode in conversational mode.
    const epGraph = GraphUriResolver.getCogEpisodicGraph(AGENT);
    const eps = await store.query(
      `SELECT ?e WHERE { GRAPH <${epGraph}> { ?e <${COGT}episodeType> "initiative" } }`,
    );
    expect(eps.bindings ?? []).toHaveLength(0);
  });
});
