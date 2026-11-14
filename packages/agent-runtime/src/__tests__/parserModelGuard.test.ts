import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRuntime } from '../index.js';
import type {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, MessageEnvelope, TriplestoreAdapter, ProviderConfig, ModelInfo,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import { OxigraphAdapter, KnowledgeEngine, GraphRegistry } from '@ontofelia/semantic-memory';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// The semantic parser must use the same model as the chat path, and must never
// send a model id that the provider is known not to offer.

const AGENT = 'ontofelia';
const PARSER_PROMPT_MARKER = 'semantic parser';

class RecordingProvider implements ProviderAdapter {
  name = 'recording';
  requests: ChatRequest[] = [];
  listModels?: () => Promise<ModelInfo[]>;

  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'recording', checkedAt: new Date().toISOString() }; }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    return {
      id: 'x', content: 'ok', toolCalls: [], finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.chat(request) };
  }

  private isParser(r: ChatRequest): boolean {
    return String(r.messages[0]?.content ?? '').toLowerCase().includes(PARSER_PROMPT_MARKER);
  }
  parserRequests(): ChatRequest[] { return this.requests.filter(r => this.isParser(r)); }
  chatRequests(): ChatRequest[] { return this.requests.filter(r => !this.isParser(r)); }
}

const env = (text: string): MessageEnvelope => ({
  id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender: { id: 'u1', channelPrefix: 'webchat', isOwner: true },
  timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
} as MessageEnvelope);

const MESSAGE = 'My name is Alice and I live in Berlin.';

describe('semantic parser model guard', () => {
  let tmpRoot: string;
  let store: TriplestoreAdapter;
  let ke: KnowledgeEngine;
  let provider: RecordingProvider;
  let previousHome: string | undefined;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `parser-guard-${process.pid}-`));
    // /model persists into the home directory: point it at the temp dir.
    previousHome = process.env.HOME;
    process.env.HOME = tmpRoot;
    store = new OxigraphAdapter();
    await store.initialize({
      backend: 'oxigraph', type: 'embedded',
      dataDir: path.join(tmpRoot, 'oxigraph'), port: 0, endpoint: '',
    });
    ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    provider = new RecordingProvider();
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  const buildRuntime = async (providerConfig: ProviderConfig, agentModel = 'provider/model') => {
    const config: AgentConfig = {
      agentId: AGENT, name: 'test', model: agentModel,
      workspace: path.join(tmpRoot, 'workspace'),
      systemPrompt: 'You are a test',
      memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
      sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [],
      channelBindings: {} as Record<ChannelType, ChannelBinding>,
      sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
    };
    const runtime = new AgentRuntime(
      AGENT, config, provider,
      new SessionStore(path.join(tmpRoot, 'sessions')),
      new ToolRegistry(),
      new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(path.join(tmpRoot, 'audit')),
      new SkillRegistry(), new SkillExecutor(new SkillRegistry()), new PluginRegistry(),
      providerConfig, ke,
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const logger = (runtime as any).logger;
    const errorSpy = vi.spyOn(logger, 'error');
    const warnSpy = vi.spyOn(logger, 'warn');
    await runtime.initialize();
    return { runtime, errorSpy, warnSpy };
  };

  const mentions = (spy: { mock: { calls: unknown[][] } }, text: string): boolean =>
    spy.mock.calls.some(call => call.some(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg)).includes(text)));

  const listing = (...ids: string[]) => async (): Promise<ModelInfo[]> => ids.map(id => ({ id, name: id }));

  it('a) never sends an unknown parser model (list from provider) and logs an error', async () => {
    provider.listModels = listing('real-model');
    const { runtime, errorSpy } = await buildRuntime({ name: 'recording', aliases: {}, defaultModel: 'new-model' });

    const response = await runtime.handleMessage(env(MESSAGE));

    expect(response.text).toBeTruthy();
    expect(provider.parserRequests()).toHaveLength(0);
    expect(mentions(errorSpy, 'new-model')).toBe(true);
    expect(runtime.getSemanticParserStats()?.skippedUnknownModel).toBe(1);
  });

  it('b) never sends an unknown parser model (explicit models list, no listModels)', async () => {
    const { runtime, errorSpy } = await buildRuntime({ name: 'recording', aliases: {}, defaultModel: 'new-model', models: ['real-model'] });

    const response = await runtime.handleMessage(env(MESSAGE));

    expect(response.text).toBeTruthy();
    expect(provider.parserRequests()).toHaveLength(0);
    expect(mentions(errorSpy, 'new-model')).toBe(true);
    expect(runtime.getSemanticParserStats()?.skippedUnknownModel).toBe(1);
  });

  it('c) uses a known fallback model for the parser and says so as a warning', async () => {
    provider.listModels = listing('real-model');
    const { runtime, errorSpy, warnSpy } = await buildRuntime({
      name: 'recording', aliases: {}, defaultModel: 'new-model', fallbackModels: ['real-model'],
    });

    await runtime.handleMessage(env(MESSAGE));

    const parserRequests = provider.parserRequests();
    expect(parserRequests).toHaveLength(1);
    expect(parserRequests[0].model).toBe('real-model');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(mentions(warnSpy, 'real-model')).toBe(true);
  });

  it('d) a known model is used as is without any error', async () => {
    provider.listModels = listing('real-model', 'other-model');
    const { runtime, errorSpy } = await buildRuntime({ name: 'recording', aliases: {}, defaultModel: 'real-model' });

    await runtime.handleMessage(env(MESSAGE));

    const parserRequests = provider.parserRequests();
    expect(parserRequests).toHaveLength(1);
    expect(parserRequests[0].model).toBe('real-model');
    expect(errorSpy).not.toHaveBeenCalled();
    expect(runtime.getSemanticParserStats()?.skippedUnknownModel).toBe(0);
  });

  it('e) without any known model list the request is sent and one warning is logged', async () => {
    const { runtime, errorSpy, warnSpy } = await buildRuntime({ name: 'recording', aliases: {}, defaultModel: 'new-model' });

    await runtime.handleMessage(env(MESSAGE));

    const parserRequests = provider.parserRequests();
    expect(parserRequests).toHaveLength(1);
    expect(parserRequests[0].model).toBe('new-model');
    expect(errorSpy).not.toHaveBeenCalled();
    const unverified = warnSpy.mock.calls.filter(call => call.some(a => typeof a === 'string' && a.includes('could not be verified')));
    expect(unverified).toHaveLength(1);
  });

  it('f) the parser uses the same model id as the chat request', async () => {
    const { runtime } = await buildRuntime(
      { name: 'recording', defaultModel: 'default-model', aliases: { fast: 'vendor/fast-model' } },
      'fast',
    );

    await runtime.handleMessage(env(MESSAGE));

    const parserRequests = provider.parserRequests();
    const chatRequests = provider.chatRequests();
    expect(parserRequests).toHaveLength(1);
    expect(chatRequests.length).toBeGreaterThan(0);
    expect(parserRequests[0].model).toBe('vendor/fast-model');
    expect(parserRequests[0].model).toBe(chatRequests[0].model);
  });

  it('g) switching to a known model with /model re-enables the parser', async () => {
    provider.listModels = listing('real-model');
    const { runtime } = await buildRuntime({ name: 'recording', aliases: {}, defaultModel: 'new-model' });

    await runtime.handleMessage(env(MESSAGE));
    expect(provider.parserRequests()).toHaveLength(0);

    await runtime.handleMessage(env('/model real-model'));
    provider.requests.length = 0;
    await runtime.handleMessage(env(MESSAGE));

    const parserRequests = provider.parserRequests();
    expect(parserRequests).toHaveLength(1);
    expect(parserRequests[0].model).toBe('real-model');
  });
});
