import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
import { AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent, ChannelType, ChannelBinding, ModelInfo, ProviderConfig } from '@ontofelia/core';
import { loadConfig } from '@ontofelia/config';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const mockConfig: AgentConfig = {
  agentId: 'test', name: 'test', model: 'configured-model', workspace: '/tmp/ontofelia-model-workspace',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test'
};

/** Records the model id of every chat request, so a switch can be observed. */
class RecordingProvider implements ProviderAdapter {
  name = 'openai-codex';
  requestedModels: string[] = [];
  constructor(private models: ModelInfo[] | Error = []) {}
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'dummy', checkedAt: new Date().toISOString() }; }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requestedModels.push(request.model);
    return { id: 'r', content: 'ok', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.chat(request) };
  }
  async listModels(): Promise<ModelInfo[]> {
    if (this.models instanceof Error) throw this.models;
    return this.models;
  }
}

/** Provider adapter that does not implement the optional listModels(). */
class NoListProvider implements ProviderAdapter {
  name = 'openai-codex';
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'dummy', checkedAt: new Date().toISOString() }; }
  async chat(): Promise<ChatResponse> {
    return { id: 'r', content: 'ok', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async *chatStream(): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.chat() };
  }
}

const HAND_WRITTEN_CONFIG = `{
  // Ontofelia configuration — hand maintained, comments matter.
  version: 1,
  provider: {
    name: 'openai-codex',
    // The '//' in this URL is what the old hand-rolled comment stripper broke.
    baseUrl: 'https://api.example.test/v1',
    defaultModel: 'old-model',
    aliases: {},
    autoFallback: true,
  },
  gateway: {
    port: 18780,
  },
}
`;

describe('AgentRuntime /model command', () => {
  let sessionStore: SessionStore;
  let toolRegistry: ToolRegistry;
  let toolPolicy: ToolPolicyEngine;
  let auditLog: AuditLog;
  let skillRegistry: SkillRegistry;
  let pluginRegistry: PluginRegistry;
  let skillExecutor: SkillExecutor;
  let sid: string;
  let homeDir: string;
  let configPath: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    sid = Math.random().toString(36).slice(2);
    sessionStore = new SessionStore(`/tmp/ontofelia-model-sessions-${sid}`);
    toolRegistry = new ToolRegistry();
    toolPolicy = new ToolPolicyEngine({ allow: [], deny: [] });
    auditLog = new AuditLog(`/tmp/ontofelia-model-workspace-${sid}`);
    skillRegistry = new SkillRegistry();
    pluginRegistry = new PluginRegistry();
    skillExecutor = new SkillExecutor(skillRegistry);
    // os.homedir() reads $HOME on POSIX, so the command writes into a temp home.
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-model-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = homeDir;
    configPath = path.join(homeDir, '.ontofelia', 'ontofelia.json5');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, HAND_WRITTEN_CONFIG, 'utf-8');
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(`/tmp/ontofelia-model-sessions-${sid}`, { recursive: true, force: true }).catch(() => {});
    await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
  });

  const createEnv = (text: string, isOwner = true) => ({
    id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm' as const,
    sender: { id: isOwner ? 'owner' : 'guest', channelPrefix: 'webchat', isOwner },
    timestamp: new Date().toISOString(), text, mentions: [], attachments: []
  });

  const providerConfig = (): ProviderConfig => ({
    name: 'openai-codex', defaultModel: 'old-model', aliases: {}, autoFallback: true
  });

  const createRuntime = (provider: ProviderAdapter, cfg: ProviderConfig = providerConfig()) =>
    new AgentRuntime('test', { ...mockConfig }, provider, sessionStore, toolRegistry, toolPolicy, auditLog, skillRegistry, skillExecutor, pluginRegistry, cfg);

  it('persists the switch without destroying the rest of the config file', async () => {
    const runtime = createRuntime(new RecordingProvider([]));
    const res = await runtime.handleMessage(createEnv('/model brand-new-model'));

    expect(res.text).toContain('Model switched');
    expect(res.text).not.toContain('Not saved');

    const raw = await fs.readFile(configPath, 'utf-8');
    // The URL used to be truncated at '//' before JSON.parse and the write was
    // then skipped silently.
    expect(raw).toContain('https://api.example.test/v1');

    const written = await loadConfig(configPath);
    expect(written.provider.defaultModel).toBe('brand-new-model');
    expect(written.provider.name).toBe('openai-codex');
    expect(written.provider.baseUrl).toBe('https://api.example.test/v1');
    expect(written.provider.autoFallback).toBe(true);
    expect(written.gateway.port).toBe(18780);
    expect(written.version).toBe(1);

    // The untouched original stays available next to the file.
    const backup = await fs.readFile(configPath + '.bak', 'utf-8');
    expect(backup).toBe(HAND_WRITTEN_CONFIG);
  });

  it('reports honestly when the config file cannot be written', async () => {
    // A directory where the config file is expected: the write must fail.
    await fs.rm(configPath, { force: true });
    await fs.mkdir(configPath, { recursive: true });

    const runtime = createRuntime(new RecordingProvider([]));
    const res = await runtime.handleMessage(createEnv('/model brand-new-model'));

    expect(res.text).toContain('Not saved to the config file');
    expect(res.text).toContain('lost on restart');
    // The in-memory switch still applied.
    expect(res.model).toBe('brand-new-model');
  });

  it('actually routes the next call to the new model', async () => {
    const provider = new RecordingProvider([]);
    const runtime = createRuntime(provider);

    await runtime.handleMessage(createEnv('/model brand-new-model'));
    await runtime.handleMessage(createEnv('hello'));

    expect(provider.requestedModels).toEqual(['brand-new-model']);
  });

  it('refuses the switch for non-owners but still lists models', async () => {
    const provider = new RecordingProvider([{ id: 'model-a', name: 'Model A' }]);
    const cfg = providerConfig();
    const runtime = createRuntime(provider, cfg);

    const refused = await runtime.handleMessage(createEnv('/model brand-new-model', false));
    expect(refused.text).toContain('owner-only');
    expect(cfg.defaultModel).toBe('old-model');
    expect(await fs.readFile(configPath, 'utf-8')).toBe(HAND_WRITTEN_CONFIG);

    const listing = await runtime.handleMessage(createEnv('/model', false));
    expect(listing.text).toContain('model-a');
    expect(listing.inlineButtons?.length).toBe(1);
  });

  it('builds the listing from the provider models and marks the active one', async () => {
    const provider = new RecordingProvider([
      { id: 'configured-model', name: 'Configured' },
      { id: 'other-model', name: 'Other' },
    ]);
    const runtime = createRuntime(provider);

    const res = await runtime.handleMessage(createEnv('/model'));
    expect(res.text).toContain('👉 configured-model');
    expect(res.text).toContain('other-model');
    expect(res.inlineButtons).toEqual([
      { text: '✅ Configured', callbackData: '/model configured-model' },
      { text: 'Other', callbackData: '/model other-model' },
    ]);
  });

  it('says so honestly when the provider cannot list models', async () => {
    const withoutListing = createRuntime(new NoListProvider());
    const noList = await withoutListing.handleMessage(createEnv('/model'));
    expect(noList.text).toContain('Could not determine the available models');
    expect(noList.inlineButtons).toBeUndefined();

    const empty = createRuntime(new RecordingProvider([]));
    const emptyRes = await empty.handleMessage(createEnv('/model'));
    expect(emptyRes.text).toContain('Could not determine the available models');

    const failing = createRuntime(new RecordingProvider(new Error('models endpoint unreachable')));
    const failingRes = await failing.handleMessage(createEnv('/model'));
    expect(failingRes.text).toContain('Could not determine the available models');
    expect(failingRes.text).toContain('models endpoint unreachable');
  });

  it('offers no foreign model ids in the listing', async () => {
    const runtime = createRuntime(new RecordingProvider([{ id: 'only-real-model', name: 'Only Real' }]));
    const res = await runtime.handleMessage(createEnv('/model'));
    expect(res.text).not.toMatch(/:free|openai\/|anthropic\/|google\//);
  });

  it('marks the switching form as owner-only in /help', async () => {
    const runtime = createRuntime(new RecordingProvider([]));
    const res = await runtime.handleMessage(createEnv('/help', false));
    expect(res.text).toContain('/model');
    expect(res.text).toContain('owner-only');
  });
});
