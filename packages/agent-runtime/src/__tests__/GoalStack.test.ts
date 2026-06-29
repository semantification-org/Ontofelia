import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphRegistry } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { GoalStack, RESPOND_TO_USER } from '../cognitive/GoalStack.js';

// Like the other cognitive suites, GoalStack is a SPARQL projection, so these
// run against the embedded Oxigraph store rather than the SPARQL-less
// InMemoryAdapter.

const AGENT = 'ontofelia';
const SESS = 'sess_goal_1';
const COGT = 'urn:shared:ontology#cog/';
const ANSWER = `${COGT}AnswerQuestion`;

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/goal-test-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

describe('GoalStack', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let gs: GoalStack;

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    gs = new GoalStack(store, registry, AGENT, SESS);
  });

  it('targets the session and longterm goal graphs', () => {
    expect(gs.sessionGraphUri()).toBe(`urn:${AGENT}:cog:goals:${SESS}`);
    expect(gs.longtermGraphUri()).toBe(`urn:${AGENT}:cog:goals:longterm`);
  });

  it('pushes a goal with core fields and reads it back', async () => {
    const uri = await gs.push({
      goalType: ANSWER,
      goalLabel: 'Answer what oxigraph is',
      priority: 0.8,
      successCriterion: 'user acknowledges the answer',
      triggeredByUser: 'urn:entity:Alice',
      tags: ['qa', 'retrieval'],
    });
    const goal = await gs.get(uri);
    expect(goal).toBeTruthy();
    expect(goal!.goalType).toBe(ANSWER);
    expect(goal!.goalLabel).toBe('Answer what oxigraph is');
    expect(goal!.status).toBe('active'); // default
    expect(goal!.priority).toBeCloseTo(0.8);
    expect(goal!.successCriterion).toBe('user acknowledges the answer');
    expect(goal!.triggeredByUser).toBe('urn:entity:Alice');
    expect(goal!.tags.sort()).toEqual(['qa', 'retrieval']);
  });

  it('top() picks the highest-priority active goal across the forest', async () => {
    await gs.push({ goalType: RESPOND_TO_USER, goalLabel: 'respond', priority: 0.5 });
    const hi = await gs.push({ goalType: ANSWER, goalLabel: 'answer', priority: 0.9 });
    const top = await gs.top();
    expect(top!.uri).toBe(hi);
    expect(top!.priority).toBeCloseTo(0.9);
  });

  it('ensureImplicit pushes a RespondToUser goal only when nothing is active', async () => {
    const first = await gs.ensureImplicit();
    expect(first.goalType).toBe(RESPOND_TO_USER);
    expect(first.priority).toBeCloseTo(0.5);

    // A real goal supersedes it; ensureImplicit must NOT add a second implicit.
    await gs.push({ goalType: ANSWER, goalLabel: 'answer', priority: 0.9 });
    const top = await gs.ensureImplicit();
    expect(top.goalType).toBe(ANSWER);

    const active = await gs.active();
    expect(active.filter((g) => g.goalType === RESPOND_TO_USER)).toHaveLength(1);
  });

  it('setStatus transitions and stamps resolvedAt / abandonedAt / blockedReason', async () => {
    const a = await gs.push({ goalType: ANSWER, goalLabel: 'a', priority: 0.7 });
    await gs.setStatus(a, 'blocked', 'waiting on user reply');
    let goal = await gs.get(a);
    expect(goal!.status).toBe('blocked');
    expect(goal!.blockedReason).toBe('waiting on user reply');
    expect(goal!.resolvedAt).toBeUndefined();

    await gs.setStatus(a, 'resolved');
    goal = await gs.get(a);
    expect(goal!.status).toBe('resolved');
    expect(goal!.resolvedAt).toBeTruthy();

    // No longer active.
    const active = await gs.active();
    expect(active.find((g) => g.uri === a)).toBeUndefined();
  });

  it('setStep records currentStep and progress', async () => {
    const a = await gs.push({ goalType: ANSWER, goalLabel: 'a', priority: 0.7, plannedSteps: 'one→two' });
    await gs.setStep(a, 'two', '1/2');
    const goal = await gs.get(a);
    expect(goal!.currentStep).toBe('two');
    expect(goal!.stepProgress).toBe('1/2');
  });

  it('migrateLongterm moves resolved/longTerm goals and leaves active session goals', async () => {
    const resolved = await gs.push({ goalType: ANSWER, goalLabel: 'done', priority: 0.6 });
    await gs.setStatus(resolved, 'resolved');
    const durable = await gs.push({ goalType: ANSWER, goalLabel: 'durable', priority: 0.6, longTerm: true });
    const stillActive = await gs.push({ goalType: ANSWER, goalLabel: 'ongoing', priority: 0.6 });

    const moved = await gs.migrateLongterm();
    expect(moved).toBe(2);

    const resolvedGoal = await gs.get(resolved);
    const durableGoal = await gs.get(durable);
    const activeGoal = await gs.get(stillActive);
    expect(resolvedGoal!.graph).toBe(gs.longtermGraphUri());
    expect(durableGoal!.graph).toBe(gs.longtermGraphUri());
    expect(activeGoal!.graph).toBe(gs.sessionGraphUri());
  });
});
