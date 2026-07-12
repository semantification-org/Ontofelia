import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
import { GoalStack } from '../cognitive/GoalStack.js';
import { CognitiveConfig } from '../cognitive/CognitiveConfig.js';
import type {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, MessageEnvelope, TriplestoreAdapter,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import {
  OxigraphAdapter, KnowledgeEngine, GraphRegistry, EpisodicMemory, GraphUriResolver,
} from '@ontofelia/semantic-memory';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

// The /goals and /initiative observability commands read grounded graph state
// (goal forest, episodes, persisted counters/flag) directly through the embedded
// Oxigraph store — no LLM. These tests seed real triples and assert the output.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';

const mockConfig: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-obs-ws',
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

describe('/goals and /initiative observability commands', () => {
  let store: TriplestoreAdapter;
  let ke: KnowledgeEngine;
  let sessionStore: SessionStore;
  let runtime: AgentRuntime;
  let sid: string;
  let dataDir: string;

  const makeRuntime = (withKe = true) => new AgentRuntime(
    AGENT, mockConfig, new StubProvider(), sessionStore,
    new ToolRegistry(), new ToolPolicyEngine({ allow: [], deny: [] }),
    new AuditLog(`/tmp/obs-ws-${sid}`), new SkillRegistry(),
    new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined,
    withKe ? ke : undefined, undefined,
  );

  beforeEach(async () => {
    sid = Math.random().toString(36).slice(2);
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `obs-store-${sid}-`));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    sessionStore = new SessionStore(await fs.mkdtemp(path.join(os.tmpdir(), `obs-sess-${sid}-`)));
    runtime = makeRuntime();
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  // Seed goals into the fixed long-term goal graph so they are visible from any
  // live session (the runtime reads session + long-term graphs).
  const seedGoals = async (now: Date) => {
    const gs = new GoalStack(store, ke.registry, AGENT, 'longterm');
    const driveUri = `urn:${AGENT}:self#curiosity`;
    await store.update(`INSERT DATA { GRAPH <${GraphUriResolver.getSelfGraph(AGENT)}> {
      <${driveUri}> <${COGT}driveLabel> "Curiosity" .
    } }`);
    const active = await gs.push({
      goalType: `${COGT}Task`, goalLabel: 'Write weekly report', priority: 0.8,
      currentStep: 'draft the intro', servesDrive: driveUri,
      wakeAt: new Date(now.getTime() + 3_600_000),
    }, now);
    const blocked = await gs.push({
      goalType: `${COGT}Task`, goalLabel: 'Deploy to prod', priority: 0.4,
    }, now);
    await gs.setStatus(blocked, 'blocked', 'waiting for approval', now);
    return { active, blocked, driveUri };
  };

  const seedInitiative = async (now: Date) => {
    const em = new EpisodicMemory(store, AGENT);
    await em.append({
      episodeType: 'initiative', occurredAt: new Date(now.getTime() - 600_000),
      actor: `urn:${AGENT}:self#${AGENT}`, outcome: 'success',
      payload: 'initiative skipped for goal "Write weekly report": within per-goal cooldown (30 min)',
    });
    await em.append({
      episodeType: 'notification', occurredAt: new Date(now.getTime() - 300_000),
      actor: `urn:${AGENT}:self#${AGENT}`, outcome: 'success',
      payload: JSON.stringify({ priority: 'high', reason: 'sent' }),
    });
    await em.append({
      episodeType: 'notification', occurredAt: new Date(now.getTime() - 120_000),
      actor: `urn:${AGENT}:self#${AGENT}`, outcome: 'success',
      payload: JSON.stringify({ priority: 'low', reason: 'daily-cap' }),
    });
    // Two run stamps within the last hour → runaway counter reads 2/4.
    const setup = GraphUriResolver.getSetupGraph(AGENT);
    const subj = `urn:${AGENT}:setup:initiative`;
    const stamp = (d: Date) => `<${subj}> <${COGT}initiativeRunAt> "${d.toISOString()}"^^<${XSD}dateTime> .`;
    await store.update(`INSERT DATA { GRAPH <${setup}> {
      ${stamp(new Date(now.getTime() - 900_000))}
      ${stamp(new Date(now.getTime() - 300_000))}
    } }`);
  };

  describe('/goals', () => {
    it('owner: lists goals with labels, statuses, wake times, blocked reason and drive', async () => {
      await seedGoals(new Date());
      const res = await runtime.handleMessage(env('/goals', true));
      expect(res.text).toContain('Write weekly report');
      expect(res.text).toContain('Deploy to prod');
      expect(res.text).toContain('active');
      expect(res.text).toContain('blocked');
      expect(res.text).toContain('waiting for approval');
      expect(res.text).toContain('Curiosity');
      expect(res.text).toContain('next wake');
      expect(res.text).toContain('draft the intro');
    });

    it('reports the empty case honestly', async () => {
      const res = await runtime.handleMessage(env('/goals', true));
      expect(res.text).toContain('No goals yet.');
    });

    it('non-owner: refused', async () => {
      await seedGoals(new Date());
      const res = await runtime.handleMessage(env('/goals', false));
      expect(res.text).toContain('owner-only');
      expect(res.text).not.toContain('Write weekly report');
    });
  });

  describe('/initiative', () => {
    it('owner: lists episodes with reasons, cap state and flag state', async () => {
      const now = new Date();
      await seedInitiative(now);
      const res = await runtime.handleMessage(env('/initiative', true));
      expect(res.text).toContain('flagInitiative');
      expect(res.text).toContain('OFF'); // default off
      expect(res.text).toContain('2/4'); // two run stamps in the last hour vs cap 4
      expect(res.text).toContain('within per-goal cooldown'); // initiative episode reason
      expect(res.text).toContain('sent'); // delivered notification
      expect(res.text).toContain('suppressed: daily-cap'); // suppressed notification reason
    });

    it('on/off flips flagInitiative (asserted via CognitiveConfig)', async () => {
      const cfg = new CognitiveConfig(store, AGENT);
      expect(await cfg.isInitiativeEnabled()).toBe(false);

      const on = await runtime.handleMessage(env('/initiative on', true));
      expect(on.text).toContain('enabled');
      expect(await cfg.isInitiativeEnabled()).toBe(true);

      const off = await runtime.handleMessage(env('/initiative off', true));
      expect(off.text).toContain('disabled');
      expect(await cfg.isInitiativeEnabled()).toBe(false);
    });

    it('non-owner: on/off refused and flag unchanged', async () => {
      const cfg = new CognitiveConfig(store, AGENT);
      const res = await runtime.handleMessage(env('/initiative on', false));
      expect(res.text).toContain('owner-only');
      expect(await cfg.isInitiativeEnabled()).toBe(false);
    });

    it('help: short usage', async () => {
      const res = await runtime.handleMessage(env('/initiative help', true));
      expect(res.text).toContain('Usage: /initiative');
    });
  });
});
