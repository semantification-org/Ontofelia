import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRuntime } from '../index.js';
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
  OxigraphAdapter, KnowledgeEngine, GraphRegistry,
} from '@ontofelia/semantic-memory';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

// The /cog command family is owner-only; debug on|off and migrate additionally
// need a live human owner turn. The scheduler's owner envelope keeps retain,
// consolidate and scan working.

const AGENT = 'ontofelia';

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

const env = (text: string, isOwner: boolean, over: Partial<MessageEnvelope> = {}): MessageEnvelope => ({
  id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender: { id: 'u1', channelPrefix: 'webchat', isOwner },
  timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
  ...over,
} as MessageEnvelope);

describe('/cog owner gate', () => {
  let store: TriplestoreAdapter;
  let ke: KnowledgeEngine;
  let sessionStore: SessionStore;
  let runtime: AgentRuntime;
  let cc: CognitiveConfig;
  let sid: string;
  let dataDir: string;

  const schedulerEnv = (text: string): MessageEnvelope => env(text, true, {
    channel: 'cron' as ChannelType, chatType: 'cron',
    sender: { id: 'scheduler', channelPrefix: 'cron', isOwner: true },
  } as Partial<MessageEnvelope>);

  beforeEach(async () => {
    sid = Math.random().toString(36).slice(2);
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `cog-store-${sid}-`));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    sessionStore = new SessionStore(await fs.mkdtemp(path.join(os.tmpdir(), `cog-sess-${sid}-`)));
    runtime = new AgentRuntime(
      AGENT, mockConfig, new StubProvider(), sessionStore,
      new ToolRegistry(), new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(`/tmp/cog-ws-${sid}`), new SkillRegistry(),
      new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined,
      ke, undefined,
    );
    cc = new CognitiveConfig(store, AGENT);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  const subs = ['', 'health', 'retain', 'consolidate', 'scan', 'migrate', 'debug on', 'debug off', 'cycles', 'explain abc'];

  it('refuses every subcommand for a non-owner and changes nothing', async () => {
    const migrate = vi.spyOn(runtime as unknown as { migrateGoalsForSession: () => unknown }, 'migrateGoalsForSession');
    for (const sub of subs) {
      const res = await runtime.handleMessage(env(`/cog ${sub}`.trimEnd(), false));
      expect(res.text, sub).toBe('This command is owner-only.');
    }
    expect(migrate).not.toHaveBeenCalled();
    expect(await cc.isDebugPanelEnabled()).toBe(false);
  });

  it('lets a human owner turn set the debug flag', async () => {
    const on = await runtime.handleMessage(env('/cog debug on', true));
    expect(on.text).toContain('enabled');
    expect(await cc.isDebugPanelEnabled()).toBe(true);
    const off = await runtime.handleMessage(env('/cog debug off', true));
    expect(off.text).toContain('disabled');
    expect(await cc.isDebugPanelEnabled()).toBe(false);
  });

  it('keeps scheduler maintenance working', async () => {
    const res = await runtime.handleMessage(schedulerEnv('/cog retain'));
    expect(res.text).toContain('Retention:');
    expect(res.text).not.toContain('owner');
  });

  it('refuses debug and migrate on the scheduler envelope', async () => {
    const migrate = vi.spyOn(runtime as unknown as { migrateGoalsForSession: () => unknown }, 'migrateGoalsForSession');
    const dbg = await runtime.handleMessage(schedulerEnv('/cog debug on'));
    expect(dbg.text).toBe('This command needs a live owner turn.');
    const mig = await runtime.handleMessage(schedulerEnv('/cog migrate'));
    expect(mig.text).toBe('This command needs a live owner turn.');
    expect(migrate).not.toHaveBeenCalled();
    expect(await cc.isDebugPanelEnabled()).toBe(false);
  });
});
