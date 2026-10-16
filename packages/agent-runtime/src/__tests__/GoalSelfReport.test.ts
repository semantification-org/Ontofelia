import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
import { INITIATIVE_ALLOWED_TOOLS } from '../initiativeTools.js';
import { GoalStack, type Goal } from '../cognitive/GoalStack.js';
import {
  summarizeGoal, orderGoals, isOpenGoal, nextAction, parsePlannedSteps, stepsDone,
} from '../cognitive/goalSummary.js';
import type {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, MessageEnvelope, TriplestoreAdapter, ToolContext,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog, ListGoalsTool } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import { OxigraphAdapter, KnowledgeEngine, GraphRegistry } from '@ontofelia/semantic-memory';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

// The /goals command and the list_goals tool must report the same facts, derived
// from the GoalStack read API through one shared summarizeGoal function.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const HOUR = 3_600_000;

const mockConfig: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-gsr-ws',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
};

class StubProvider implements ProviderAdapter {
  name = 'stub';
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; }
  async chat(_r: ChatRequest): Promise<ChatResponse> {
    return { id: 'x', content: '', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async *chatStream(r: ChatRequest): AsyncIterable<StreamEvent> { yield { type: 'done', response: await this.chat(r) }; }
}

const env = (text: string, isOwner: boolean): MessageEnvelope => ({
  id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender: { id: 'u1', channelPrefix: 'webchat', isOwner },
  timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
} as MessageEnvelope);

const toolCtx = (isOwner: boolean, sessionId: string): ToolContext => ({
  agentId: AGENT, sessionId, channelType: 'webchat', senderId: 'u1', isOwner,
} as unknown as ToolContext);

const mkGoal = (over: Partial<Goal>): Goal => ({
  uri: 'urn:g:1', goalId: '1', goalType: `${COGT}Task`, goalLabel: 'g', status: 'active', priority: 0.5,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', graph: 'urn:graph', tags: [],
  ...over,
});

describe('summarizeGoal', () => {
  const now = new Date('2026-10-05T12:00:00.000Z');

  it('derives the next action from plannedSteps and stepProgress', () => {
    const g = mkGoal({ plannedSteps: 'Outline → Draft → Review', stepProgress: '1/3', currentStep: 'Outline' });
    expect(summarizeGoal(g, now).nextAction).toBe('Draft');
    expect(nextAction({ ...g, stepProgress: '0/3' })).toBe('Outline');
    expect(nextAction({ ...g, stepProgress: '2 of 3' })).toBe('Review');
  });

  it('falls back to currentStep when the plan is absent, exhausted or the progress is not understood', () => {
    expect(nextAction(mkGoal({ currentStep: 'ping Anna' }))).toBe('ping Anna');
    expect(nextAction(mkGoal({ plannedSteps: 'a → b', stepProgress: '2/2', currentStep: 'wrap up' }))).toBe('wrap up');
    expect(nextAction(mkGoal({ plannedSteps: 'a → b', stepProgress: 'going well', currentStep: 'b' }))).toBe('b');
    expect(nextAction(mkGoal({ plannedSteps: 'a → b', stepProgress: '2/2' }))).toBeNull();
    expect(nextAction(mkGoal({}))).toBeNull();
  });

  it('parses plans split by arrows or lines, with list markers stripped', () => {
    expect(parsePlannedSteps('1. one\n- two\n3) three')).toEqual(['one', 'two', 'three']);
    expect(parsePlannedSteps('a -> b→c')).toEqual(['a', 'b', 'c']);
    expect(stepsDone('3')).toBe(3);
    expect(stepsDone('n/a')).toBeUndefined();
  });

  it('labels an active goal with a future wake as waiting, and nothing else', () => {
    const future = new Date(now.getTime() + HOUR).toISOString();
    const past = new Date(now.getTime() - HOUR).toISOString();
    expect(summarizeGoal(mkGoal({ wakeAt: future }), now)).toMatchObject({ waitingUntil: future, nextWake: future });
    expect(summarizeGoal(mkGoal({ wakeAt: past }), now)).toMatchObject({ waitingUntil: null, nextWake: past });
    expect(summarizeGoal(mkGoal({ status: 'proposed', wakeAt: future }), now).waitingUntil).toBeNull();
    expect(summarizeGoal(mkGoal({}), now)).toMatchObject({ waitingUntil: null, nextWake: null });
  });

  it('carries the blocked reason only for blocked goals', () => {
    expect(summarizeGoal(mkGoal({ status: 'blocked', blockedReason: 'needs approval' }), now).blockedReason).toBe('needs approval');
    expect(summarizeGoal(mkGoal({ status: 'active', blockedReason: 'stale' }), now).blockedReason).toBeNull();
  });

  it('orders active, proposed, blocked, closed; priority desc within a status', () => {
    const goals = [
      mkGoal({ goalLabel: 'blocked', status: 'blocked' }),
      mkGoal({ goalLabel: 'low', priority: 0.1 }),
      mkGoal({ goalLabel: 'done', status: 'resolved', priority: 1 }),
      mkGoal({ goalLabel: 'proposed', status: 'proposed', priority: 0.9 }),
      mkGoal({ goalLabel: 'high', priority: 0.9 }),
    ];
    expect(orderGoals(goals).map((g) => g.goalLabel)).toEqual(['high', 'low', 'proposed', 'blocked', 'done']);
    expect(goals.filter(isOpenGoal)).toHaveLength(4);
  });
});

describe('/goals and list_goals agree with the GoalStack', () => {
  let store: TriplestoreAdapter;
  let ke: KnowledgeEngine;
  let sessionStore: SessionStore;
  let runtime: AgentRuntime;
  let registry: ToolRegistry;
  let tool: ListGoalsTool;
  let sid: string;
  let dataDir: string;
  let gs: GoalStack;

  beforeEach(async () => {
    sid = Math.random().toString(36).slice(2);
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `gsr-store-${sid}-`));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    sessionStore = new SessionStore(await fs.mkdtemp(path.join(os.tmpdir(), `gsr-sess-${sid}-`)));
    registry = new ToolRegistry();
    runtime = new AgentRuntime(
      AGENT, mockConfig, new StubProvider(), sessionStore,
      registry, new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(`/tmp/gsr-ws-${sid}`), new SkillRegistry(),
      new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined, ke, undefined,
    );
    tool = new ListGoalsTool({ openGoals: ({ sessionId }) => runtime.openGoalSummaries(sessionId) });
    registry.register(tool);
    gs = new GoalStack(store, ke.registry, AGENT, 'longterm');
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  const seed = async () => {
    const t0 = Date.now() - 10 * HOUR;
    const at = (i: number) => new Date(t0 + i * 60_000);
    const plan = await gs.push({
      goalType: `${COGT}Task`, goalLabel: 'Write the report', priority: 0.8, currentStep: 'Outline',
      plannedSteps: 'Outline → Draft → Review', wakeAt: new Date(Date.now() + 2 * HOUR),
    }, at(1));
    await gs.setStep(plan, 'Outline', '1/3', at(1));
    await gs.push({ goalType: `${COGT}Task`, goalLabel: 'Tidy the notes', priority: 0.3, currentStep: 'sort the inbox' }, at(2));
    await gs.push({
      goalType: `${COGT}Task`, goalLabel: 'Overdue review', priority: 0.6, wakeAt: new Date(Date.now() - HOUR),
    }, at(3));
    await gs.push({ goalType: `${COGT}Task`, goalLabel: 'Maybe learn Rust', priority: 0.7, status: 'proposed', plannedSteps: 'pick a book → read ch.1' }, at(4));
    const blocked = await gs.push({ goalType: `${COGT}Task`, goalLabel: 'Deploy to prod', priority: 0.4, currentStep: 'run the migration' }, at(5));
    await gs.setStatus(blocked, 'blocked', 'waiting for approval', at(5));
    const done = await gs.push({ goalType: `${COGT}Task`, goalLabel: 'Old finished thing', priority: 0.9 }, at(6));
    await gs.setStatus(done, 'resolved', undefined, at(6));
    const dropped = await gs.push({ goalType: `${COGT}Task`, goalLabel: 'Dropped idea', priority: 0.9 }, at(7));
    await gs.setStatus(dropped, 'abandoned', 'no longer relevant', at(7));
  };

  // Read through a stack on a different session id: seeding stack and runtime
  // each see the session graph plus the long-term graph, and a session literally
  // named 'longterm' would read the same graph twice.
  const expectedOpen = async () => {
    const reader = new GoalStack(store, ke.registry, AGENT, 'reader-session');
    return orderGoals((await reader.list()).filter(isOpenGoal));
  };

  it('list_goals returns exactly the open goals, in order, with the GoalStack facts', async () => {
    await seed();
    const expected = await expectedOpen();
    expect(expected.length).toBe(5);

    const res = await tool.execute({}, toolCtx(true, 'live-session'));
    expect(res.success).toBe(true);
    const out = JSON.parse(res.output as string);
    expect(out.count).toBe(expected.length);
    expect(out.goals.map((g: { label: string }) => g.label)).toEqual(expected.map((g) => g.goalLabel));
    out.goals.forEach((s: Record<string, unknown>, i: number) => {
      const g = expected[i];
      expect(s.status).toBe(g.status);
      expect(s.nextAction).toBe(nextAction(g));
      expect(s.nextWake).toBe(g.wakeAt ?? null);
      expect(s.blockedReason).toBe(g.status === 'blocked' ? g.blockedReason ?? null : null);
    });
    // The seeded plan is derived from plan + progress, not from the stale currentStep.
    const report = out.goals.find((g: { label: string }) => g.label === 'Write the report');
    expect(report.nextAction).toBe('Draft');
    expect(report.waitingUntil).toBe(report.nextWake);
    expect(out.goals.find((g: { label: string }) => g.label === 'Overdue review').waitingUntil).toBeNull();
    expect(res.output).not.toContain('Old finished thing');
    expect(res.output).not.toContain('Dropped idea');
  });

  it('/goals lists the same open goals, next actions and wakes in the same order', async () => {
    await seed();
    const expected = await expectedOpen();
    const res = await runtime.handleMessage(env('/goals', true));
    const lines = res.text.split('\n');

    // Same open goals in the same order (closed ones are listed separately, last).
    const bullets = lines.filter((l) => l.startsWith('• ')).map((l) => l.slice(2).split(' — ')[0]);
    expect(bullets.slice(0, expected.length)).toEqual(expected.map((g) => g.goalLabel));
    expect(bullets.slice(expected.length).sort()).toEqual(['Dropped idea', 'Old finished thing']);
    expect(res.text).toContain('*Proposed*');
    expect(res.text).toContain('*Closed*');

    expected.forEach((g, i) => {
      const start = lines.findIndex((l) => l.startsWith(`• ${g.goalLabel} — `));
      const end = i + 1 < expected.length ? lines.findIndex((l) => l.startsWith(`• ${expected[i + 1].goalLabel} — `)) : lines.length;
      const block = lines.slice(start, end).join('\n');
      expect(block).toContain(`next: ${nextAction(g) ?? 'none planned'}`);
      if (g.wakeAt) expect(block).toContain(g.wakeAt);
      else expect(block).not.toContain('wake');
      const waiting = summarizeGoal(g, new Date()).waitingUntil;
      if (waiting) expect(block).toContain('waiting until');
      else expect(block).not.toContain('waiting until');
      if (g.status === 'blocked') expect(block).toContain(`blocked: ${g.blockedReason}`);
    });
  });

  it('list_goals reports no open goals as an empty result', async () => {
    const res = await tool.execute({}, toolCtx(true, 'live-session'));
    expect(JSON.parse(res.output as string)).toMatchObject({ count: 0, goals: [], note: 'No open goals.' });
  });

  it('non-owner: /goals, list_goals and the advertised tool list reveal nothing', async () => {
    await seed();
    const cmd = await runtime.handleMessage(env('/goals', false));
    expect(cmd.text).toContain('owner-only');
    expect(cmd.text).not.toContain('Write the report');

    const res = await tool.execute({}, toolCtx(false, 'live-session'));
    expect(res.success).toBe(false);
    expect(String(res.output)).toContain('owner-only');
    expect(JSON.stringify(res)).not.toContain('Write the report');
    expect(JSON.stringify(res)).not.toContain('Deploy to prod');

    const nonOwnerTools = await runtime.handleMessage(env('/tools', false));
    expect(nonOwnerTools.text).not.toContain('list_goals');
    const ownerTools = await runtime.handleMessage(env('/tools', true));
    expect(ownerTools.text).toContain('list_goals');
  });

  it('list_goals is read-only and allowed in unattended initiative cycles', () => {
    expect(INITIATIVE_ALLOWED_TOOLS.has('list_goals')).toBe(true);
    expect(tool.permissions).toEqual(['memory:read']);
  });
});
