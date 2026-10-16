import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
import { CognitiveConfig } from '../cognitive/CognitiveConfig.js';
import { GoalStack } from '../cognitive/GoalStack.js';
import {
  InitiativeService,
  INITIATIVE_JOB_PREFIX,
  type InitiativeScheduler,
  type InitiativeSessionPort,
} from '../cognitive/InitiativeService.js';
import type {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent, ToolCall,
  ChannelType, ChannelBinding, MessageEnvelope, TriplestoreAdapter,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog, ArmGoalTool, UpdateGoalStepTool } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import { OxigraphAdapter, KnowledgeEngine, GraphRegistry } from '@ontofelia/semantic-memory';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

// Follows docs/demo-initiative.md end to end. REAL: AgentRuntime (command path,
// CycleManager, tool loop, tool policy), the real arm_goal / update_goal_step
// tools wired exactly as the gateway wires them, GoalStack, InitiativeService,
// the embedded Oxigraph store, the session store. STUBBED: the LLM (a scripted
// provider that answers with fixed tool calls), the job scheduler (records jobs;
// the test calls onWake itself) and the clock of the InitiativeService.

const AGENT = 'ontofelia';

const mockConfig: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-demoflow-ws',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
};

/** Answers each chat() call with the next scripted response and records the requests. */
class ScriptedProvider implements ProviderAdapter {
  name = 'scripted';
  requests: ChatRequest[] = [];
  constructor(public script: Array<{ content?: string; toolCalls?: ToolCall[] }>) {}
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'scripted', checkedAt: new Date().toISOString() }; }
  async chat(r: ChatRequest): Promise<ChatResponse> {
    // Side calls without a tool list (the runtime's semantic parser shares this
    // provider) get an empty answer and do not consume the script.
    if (!r.tools) {
      return { id: 'side', content: '', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    }
    this.requests.push(r);
    const next = this.script.shift();
    if (!next) throw new Error('scripted provider ran out of responses');
    const toolCalls = next.toolCalls ?? [];
    return {
      id: `r${this.requests.length}`, content: next.content ?? '',
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop', toolCalls,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
  async *chatStream(r: ChatRequest): AsyncIterable<StreamEvent> { yield { type: 'done', response: await this.chat(r) }; }
}

class FakeScheduler implements InitiativeScheduler {
  jobs: Array<{ id: string; name: string; runAt: string; status: string }> = [];
  private seq = 0;
  async addOneTimeJob(job: { name: string; runAt: string; agentId: string; prompt: string }) {
    const id = `job-${++this.seq}`;
    this.jobs.push({ id, name: job.name, runAt: job.runAt, status: 'pending' });
    return { id };
  }
  async removeJob(id: string): Promise<boolean> {
    const i = this.jobs.findIndex((j) => j.id === id);
    if (i >= 0) this.jobs.splice(i, 1);
    return i >= 0;
  }
  listOneTimeJobs() { return this.jobs; }
}

const ownerEnv = (text: string): MessageEnvelope => ({
  id: Math.random().toString(36).slice(2), channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender: { id: 'u1', channelPrefix: 'webchat', isOwner: true },
  timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
} as MessageEnvelope);

describe('initiative demo flow (docs/demo-initiative.md)', () => {
  let store: TriplestoreAdapter;
  let ke: KnowledgeEngine;
  let sessionStore: SessionStore;
  let runtime: AgentRuntime;
  let provider: ScriptedProvider;
  let scheduler: FakeScheduler;
  let service: InitiativeService;
  let cfg: CognitiveConfig;
  let clockNow: Date;
  let dataDir: string;

  beforeEach(async () => {
    const sid = Math.random().toString(36).slice(2);
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `demoflow-store-${sid}-`));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    sessionStore = new SessionStore(await fs.mkdtemp(path.join(os.tmpdir(), `demoflow-sess-${sid}-`)));
    provider = new ScriptedProvider([]);
    scheduler = new FakeScheduler();
    cfg = new CognitiveConfig(store, AGENT);
    clockNow = new Date();

    const toolRegistry = new ToolRegistry();
    runtime = new AgentRuntime(
      AGENT, mockConfig, provider, sessionStore,
      toolRegistry, new ToolPolicyEngine({ allow: ['arm_goal', 'update_goal_step'], deny: [] }),
      new AuditLog(`/tmp/demoflow-ws-${sid}`), new SkillRegistry(),
      new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined, ke, undefined,
    );

    // The same session port and wiring as the gateway composition root.
    const origin = { channel: 'system', chatType: 'initiative', senderId: 'initiative', accountId: 'initiative' } as const;
    const session: InitiativeSessionPort = {
      async resolveGoalSession(goalKey: string) {
        return (await sessionStore.getOrCreateSessionByKey(AGENT, `initiative:${goalKey}`, origin)).sessionId;
      },
      async archiveGoalSession() {},
    };
    service = new InitiativeService({
      triplestore: store, registry: ke.registry, agentId: AGENT, scheduler, cognitiveConfig: cfg,
      dispatch: async (envelope) => { await runtime.handleMessage(envelope); },
      session, clock: () => clockNow,
    });
    toolRegistry.register(new ArmGoalTool({
      arm: async (req) => runtime.armGoal(req, (goal) => service.registerGoalWake(goal)),
    }));
    toolRegistry.register(new UpdateGoalStepTool({
      update: async (req) => runtime.updateGoalStep(req),
    }));
  });

  afterEach(async () => {
    await runtime.flushCognitiveWrites();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('arms a goal from a chat message, wakes it, and the unattended cycle records progress', async () => {
    // Steps 1-2 of the demo: the two owner switches.
    expect((await runtime.handleMessage(ownerEnv('/cog cycle on'))).text).toContain('flagCycleManager = true');
    await cfg.setEpisodicMemoryEnabled(true); // the mandate is an episode
    expect((await runtime.handleMessage(ownerEnv('/initiative on'))).text).toContain('flagInitiative = true');
    expect(await cfg.isCycleManagerEnabled()).toBe(true);
    expect(await cfg.isInitiativeEnabled()).toBe(true);
    expect(provider.requests).toHaveLength(0); // commands never reach the LLM

    // Step 3: the owner asks in plain words; the (scripted) model calls arm_goal.
    provider.script = [
      { toolCalls: [{ id: 'a1', name: 'arm_goal', arguments: JSON.stringify({ newGoal: 'Check the build status', priority: 0.7, wakeIn: 'PT1M' }) }] },
      { content: 'I will look into it in a minute.' },
    ];
    const armedAt = Date.now();
    const reply = await runtime.handleMessage(ownerEnv('Please check the build status in 1 minute.'));
    expect(reply.text).toBe('I will look into it in a minute.');
    // The model was offered arm_goal and update_goal_step as owner tools.
    expect(provider.requests[0].tools?.map((t) => t.name)).toEqual(expect.arrayContaining(['arm_goal', 'update_goal_step']));
    // The tool result the model saw reports success, not a refusal.
    const toolMsg = provider.requests[1].messages.find((m) => m.role === 'tool')!;
    expect(String(toolMsg.content)).toContain('Created and armed goal');

    // The goal is armed: long-term, active, valid mandate, wake ~1 minute out, job scheduled.
    const gs = new GoalStack(store, ke.registry, AGENT, 'any-session');
    const goals = await gs.list();
    const goal = goals.find((g) => g.goalLabel === 'Check the build status')!;
    expect(goal).toBeDefined();
    expect(goal.status).toBe('active');
    expect(goal.longTerm).toBe(true);
    expect(await gs.isMandateValid(goal.mandatedBy)).toBe(true);
    const wakeMs = Date.parse(goal.wakeAt!);
    expect(wakeMs).toBeGreaterThanOrEqual(armedAt + 60_000 - 1000);
    expect(wakeMs).toBeLessThanOrEqual(Date.now() + 60_000 + 1000);
    expect(scheduler.jobs).toHaveLength(1);
    expect(scheduler.jobs[0].name).toBe(`${INITIATIVE_JOB_PREFIX}${goal.uri}`);

    // /goals shows it with its wake.
    const goalsText = (await runtime.handleMessage(ownerEnv('/goals'))).text;
    expect(goalsText).toContain('Check the build status');
    expect(goalsText).toContain('waiting until');

    // Step 4: the wake is due; the initiative cycle's (scripted) model records progress.
    provider.script = [
      { toolCalls: [{ id: 'u1', name: 'update_goal_step', arguments: JSON.stringify({ currentStep: 'Read the build log', stepProgress: '1/2' }) }] },
      { content: 'Progress recorded.' },
    ];
    clockNow = new Date(wakeMs + 1000);
    expect(await service.onWake(goal.uri)).toEqual({ ran: true, reason: 'dispatched' });

    const cycleReq = provider.requests[provider.requests.length - 2];
    // The unattended cycle only gets the initiative allow-list: update_goal_step yes, arm_goal no.
    const offered = cycleReq.tools?.map((t) => t.name) ?? [];
    expect(offered).toContain('update_goal_step');
    expect(offered).not.toContain('arm_goal');

    const after = (await gs.get(goal.uri))!;
    expect(after.currentStep).toBe('Read the build log');
    expect(after.stepProgress).toBe('1/2');
    expect(after.mandatedBy).toBe(goal.mandatedBy);

    // Step 5: /initiative shows the cycle and the counter; /goals shows the step.
    // The cycle record is queued off the reply path: let it land first.
    await runtime.flushCognitiveWrites();
    const initiativeText = (await runtime.handleMessage(ownerEnv('/initiative'))).text;
    expect(initiativeText).toContain('Initiative: ON');
    expect(initiativeText).toContain('1/4');
    expect(initiativeText).toContain('Check the build status');
    expect(initiativeText).not.toContain('arm_goal needs /cog cycle on');
    const goalsAfter = (await runtime.handleMessage(ownerEnv('/goals'))).text;
    expect(goalsAfter).toContain('Read the build log');
  });

  it('without /cog cycle on, arm_goal refuses and names the missing step; nothing is armed', async () => {
    await runtime.handleMessage(ownerEnv('/initiative on'));
    provider.script = [
      { toolCalls: [{ id: 'a1', name: 'arm_goal', arguments: JSON.stringify({ newGoal: 'Check the build status', wakeIn: 'PT1M' }) }] },
      { content: 'Could not do that.' },
    ];
    await runtime.handleMessage(ownerEnv('Please check the build status in 1 minute.'));
    const toolMsg = provider.requests[1].messages.find((m) => m.role === 'tool')!;
    expect(String(toolMsg.content)).toContain('cycle manager is on');
    expect(String(toolMsg.content)).not.toContain('armed goal');
    expect(scheduler.jobs).toHaveLength(0);
    const goals = await new GoalStack(store, ke.registry, AGENT, 'any-session').list();
    expect(goals.find((g) => g.goalLabel === 'Check the build status')).toBeUndefined();
  });
});
