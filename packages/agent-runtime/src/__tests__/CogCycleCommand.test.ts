import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { OxigraphAdapter, KnowledgeEngine, GraphRegistry } from '@ontofelia/semantic-memory';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

// `/cog cycle on|off` is the supported way to switch the cycle manager flag
// (cog.flagCycleManager). It is owner-only AND needs a live human owner turn:
// scheduler / cron envelopes claim isOwner but are not the owner speaking.

const AGENT = 'ontofelia';

const mockConfig: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-cogcycle-ws',
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

const env = (text: string, over: Partial<MessageEnvelope> & { sender?: MessageEnvelope['sender'] } = {}): MessageEnvelope => ({
  id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender: { id: 'u1', channelPrefix: 'webchat', isOwner: true },
  timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
  ...over,
} as MessageEnvelope);

describe('/cog cycle on|off', () => {
  let store: TriplestoreAdapter;
  let runtime: AgentRuntime;
  let cfg: CognitiveConfig;
  let dataDir: string;

  beforeEach(async () => {
    const sid = Math.random().toString(36).slice(2);
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `cogcycle-store-${sid}-`));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    const ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    const sessionStore = new SessionStore(await fs.mkdtemp(path.join(os.tmpdir(), `cogcycle-sess-${sid}-`)));
    runtime = new AgentRuntime(
      AGENT, mockConfig, new StubProvider(), sessionStore,
      new ToolRegistry(), new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(`/tmp/cogcycle-ws-${sid}`), new SkillRegistry(),
      new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined, ke, undefined,
    );
    cfg = new CognitiveConfig(store, AGENT);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  it('the owner in a live conversation switches the flag on and off', async () => {
    expect(await cfg.isCycleManagerEnabled()).toBe(false);
    const on = await runtime.handleMessage(env('/cog cycle on'));
    expect(on.text).toContain('enabled');
    expect(await cfg.isCycleManagerEnabled()).toBe(true);
    const off = await runtime.handleMessage(env('/cog cycle off'));
    expect(off.text).toContain('disabled');
    expect(await cfg.isCycleManagerEnabled()).toBe(false);
  });

  it('a non-owner is refused and the flag is unchanged', async () => {
    const res = await runtime.handleMessage(env('/cog cycle on', { sender: { id: 'stranger', channelPrefix: 'webchat', isOwner: false } }));
    expect(res.text).toContain('owner-only');
    expect(await cfg.isCycleManagerEnabled()).toBe(false);
  });

  it('a non-owner cannot switch it off either', async () => {
    await cfg.setCycleManagerEnabled(true);
    const res = await runtime.handleMessage(env('/cog cycle off', { sender: { id: 'stranger', channelPrefix: 'webchat', isOwner: false } }));
    expect(res.text).toContain('owner-only');
    expect(await cfg.isCycleManagerEnabled()).toBe(true);
  });

  it('synthetic owner senders (scheduler, cron envelope) are refused and the flag is unchanged', async () => {
    const scheduler = env('/cog cycle on', {
      channel: 'cron' as ChannelType, chatType: 'cron' as MessageEnvelope['chatType'],
      sender: { id: 'scheduler', channelPrefix: 'cron', isOwner: true },
    });
    const res = await runtime.handleMessage(scheduler);
    expect(res.text).toContain('live conversation');
    expect(await cfg.isCycleManagerEnabled()).toBe(false);

    await cfg.setCycleManagerEnabled(true);
    const off = await runtime.handleMessage({ ...scheduler, text: '/cog cycle off' });
    expect(off.text).toContain('live conversation');
    expect(await cfg.isCycleManagerEnabled()).toBe(true);
  });

  it('/cog health shows the flag, /initiative says arm_goal needs it while it is off, /help lists the command', async () => {
    const health = await runtime.handleMessage(env('/cog health'));
    expect(health.text).toContain('"cycleManager": false');
    expect((await runtime.handleMessage(env('/initiative'))).text).toContain('arm_goal needs /cog cycle on');
    expect((await runtime.handleMessage(env('/help'))).text).toContain('/cog cycle on|off');

    await runtime.handleMessage(env('/cog cycle on'));
    expect((await runtime.handleMessage(env('/cog health'))).text).toContain('"cycleManager": true');
    expect((await runtime.handleMessage(env('/initiative'))).text).not.toContain('arm_goal needs /cog cycle on');
  });
});
