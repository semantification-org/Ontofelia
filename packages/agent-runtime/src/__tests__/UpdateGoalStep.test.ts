import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphRegistry } from '@ontofelia/semantic-memory';
import type { ToolContext, TriplestoreAdapter } from '@ontofelia/core';
import { UpdateGoalStepTool } from '@ontofelia/tools';
import { GoalStack } from '../cognitive/GoalStack.js';
import { updateGoalStep } from '../cognitive/updateGoalStep.js';
import { INITIATIVE_ALLOWED_TOOLS } from '../initiativeTools.js';

const AGENT = 'ontofelia';
const SESS = 'sess-step';
const COGT = 'urn:shared:ontology#cog/';
const NOW = new Date('2026-06-01T12:00:00.000Z');

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/goalstep-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

const ctx = (over: Partial<ToolContext>): ToolContext =>
  ({
    agentId: AGENT,
    sessionId: SESS,
    workspacePath: '/tmp',
    channelType: 'webchat',
    senderId: 'owner1',
    isOwner: true,
    ownerPresent: true,
    ...over,
  }) as ToolContext;

describe('update_goal_step', () => {
  let store: TriplestoreAdapter;
  let gs: GoalStack;
  let tool: UpdateGoalStepTool;
  let own: string; // the goal the initiative cycle was woken for
  let other: string;

  beforeEach(async () => {
    store = await makeStore();
    const registry = GraphRegistry.create([AGENT]);
    gs = new GoalStack(store, registry, AGENT, SESS);
    tool = new UpdateGoalStepTool({
      update: async (req) => updateGoalStep({ goalStack: new GoalStack(store, registry, AGENT, req.sessionId), now: NOW }, req),
    });
    own = await gs.push({ goalType: `${COGT}Task`, goalLabel: 'Own goal', priority: 0.5, wakeAt: new Date('2026-07-01T00:00:00Z'), mandatedBy: 'urn:x:mandate' });
    other = await gs.push({ goalType: `${COGT}Task`, goalLabel: 'Other goal', priority: 0.4 });
  });

  it('an owner turn updates step, progress, plan and status of any open goal', async () => {
    const res = await tool.execute(
      { goal: 'other goal', currentStep: 'Read the spec', stepProgress: '3/8', plannedSteps: '1 read, 2 write', status: 'resolved' },
      ctx({}),
    );
    expect(res.success).toBe(true);
    const g = (await gs.get(other))!;
    expect(g.currentStep).toBe('Read the spec');
    expect(g.stepProgress).toBe('3/8');
    expect(g.plannedSteps).toBe('1 read, 2 write');
    expect(g.status).toBe('resolved');
    expect(g.priority).toBe(0.4);
  });

  it('blocks with a reason and unblocks', async () => {
    expect((await tool.execute({ goal: other, status: 'blocked', blockedReason: 'waiting for access' }, ctx({}))).success).toBe(true);
    const g = (await gs.get(other))!;
    expect(g.status).toBe('blocked');
    expect(g.blockedReason).toBe('waiting for access');
    expect((await tool.execute({ goal: other, status: 'active' }, ctx({}))).success).toBe(true);
    expect((await gs.get(other))!.status).toBe('active');
  });

  it('an initiative cycle updates its own goal, by IRI or by default, and never touches mandate, wake or priority', async () => {
    const before = (await gs.get(own))!;
    const c = ctx({ unattended: true, initiativeGoalUri: own });
    expect((await tool.execute({ goal: own, currentStep: 'Step A' }, c)).success).toBe(true);
    expect((await tool.execute({ currentStep: 'Step B', stepProgress: '2/3' }, c)).success).toBe(true);
    const g = (await gs.get(own))!;
    expect(g.currentStep).toBe('Step B');
    expect(g.stepProgress).toBe('2/3');
    expect(g.mandatedBy).toBe(before.mandatedBy);
    expect(g.wakeAt).toBe(before.wakeAt);
    expect(g.priority).toBe(before.priority);
  });

  it('an initiative cycle cannot update a different goal, by IRI or label; nothing is written', async () => {
    const c = ctx({ unattended: true, initiativeGoalUri: own });
    for (const ref of [other, 'Other goal']) {
      const res = await tool.execute({ goal: ref, currentStep: 'Hijack', status: 'resolved' }, c);
      expect(res.success).toBe(false);
      expect(String(res.output)).toContain('woken for');
    }
    const g = (await gs.get(other))!;
    expect(g.currentStep).toBeUndefined();
    expect(g.status).toBe('active');
  });

  it('an unattended context without a known goal is refused', async () => {
    const res = await tool.execute({ goal: own, currentStep: 'x' }, ctx({ unattended: true }));
    expect(res.success).toBe(false);
    expect((await gs.get(own))!.currentStep).toBeUndefined();
  });

  it('a non-owner is refused and nothing is written', async () => {
    const res = await tool.execute({ goal: other, currentStep: 'x' }, ctx({ isOwner: false }));
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain('owner-only');
    expect((await gs.get(other))!.currentStep).toBeUndefined();
  });

  it('refuses in a scheduled/system turn (owner not present, no woken goal) and writes nothing', async () => {
    const res = await tool.execute({ goal: other, currentStep: 'x' }, ctx({ ownerPresent: false }));
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain('owner present');
    expect((await gs.get(other))!.currentStep).toBeUndefined();
  });

  it('refuses abandoned, proposed and unknown statuses', async () => {
    for (const status of ['abandoned', 'proposed', 'nonsense']) {
      const res = await tool.execute({ goal: other, status }, ctx({}));
      expect(res.success).toBe(false);
    }
    expect((await gs.get(other))!.status).toBe('active');
  });

  it('refuses to reopen a resolved or abandoned goal', async () => {
    await gs.setStatus(other, 'resolved', undefined, NOW);
    const res = await tool.execute({ goal: other, status: 'active', currentStep: 'again' }, ctx({}));
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain('not reopened');
    const g = (await gs.get(other))!;
    expect(g.status).toBe('resolved');
    expect(g.currentStep).toBeUndefined();

    await gs.setStatus(own, 'abandoned', undefined, NOW);
    const res2 = await tool.execute({ currentStep: 'again' }, ctx({ unattended: true, initiativeGoalUri: own }));
    expect(res2.success).toBe(false);
    expect((await gs.get(own))!.status).toBe('abandoned');
  });

  it('refuses blocked without a reason and writes nothing', async () => {
    const res = await tool.execute({ goal: other, status: 'blocked', currentStep: 'x' }, ctx({}));
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain('blockedReason');
    const g = (await gs.get(other))!;
    expect(g.status).toBe('active');
    expect(g.currentStep).toBeUndefined();
  });

  it('refuses an empty update', async () => {
    expect((await tool.execute({ goal: other }, ctx({}))).success).toBe(false);
  });

  it('is in the initiative allow-list', () => {
    expect(INITIATIVE_ALLOWED_TOOLS.has('update_goal_step')).toBe(true);
  });
});
