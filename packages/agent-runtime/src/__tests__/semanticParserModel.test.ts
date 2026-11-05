import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRuntime } from '../index.js';
import type {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, MessageEnvelope, TriplestoreAdapter, ProviderConfig,
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

// Proves two things about the parser model, see the agent-runtime/semantic-memory
// change this test accompanies:
//   1. the parser is constructed with the model resolved through the same
//      alias table as the chat path (not the raw providerConfig.defaultModel);
//   2. a parser-side provider failure is surfaced through the runtime logger,
//      not swallowed silently.

const AGENT = 'ontofelia';

// Recognizable fragment of SemanticParser's system prompt (see
// buildParserSystemPrompt in SemanticParser.ts) — used to tell the parser's
// own provider.chat() call apart from the main answer-LLM call, since both
// go through the same mock provider instance.
const PARSER_PROMPT_MARKER = 'semantic parser';

class RecordingProvider implements ProviderAdapter {
  name = 'recording';
  requests: ChatRequest[] = [];
  /** When set, any chat() call whose system message matches the parser prompt rejects with this error. */
  failParserWith?: Error;

  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'recording', checkedAt: new Date().toISOString() }; }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    const systemContent = String(request.messages[0]?.content ?? '');
    if (this.failParserWith && systemContent.toLowerCase().includes(PARSER_PROMPT_MARKER)) {
      throw this.failParserWith;
    }
    return {
      id: 'x', content: 'ok', toolCalls: [], finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.chat(request) };
  }

  /** The request this provider received for the semantic parser's own call, if any. */
  parserRequest(): ChatRequest | undefined {
    return this.requests.find(r => String(r.messages[0]?.content ?? '').toLowerCase().includes(PARSER_PROMPT_MARKER));
  }
}

const env = (text: string): MessageEnvelope => ({
  id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender: { id: 'u1', channelPrefix: 'webchat', isOwner: true },
  timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
} as MessageEnvelope);

describe('semantic parser model resolution and failure visibility', () => {
  let tmpRoot: string;
  let store: TriplestoreAdapter;
  let ke: KnowledgeEngine;
  let provider: RecordingProvider;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `parser-model-${process.pid}-`));
    store = new OxigraphAdapter();
    await store.initialize({
      backend: 'oxigraph', type: 'embedded',
      dataDir: path.join(tmpRoot, 'oxigraph'), port: 0, endpoint: '',
    });
    ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    provider = new RecordingProvider();
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  const buildRuntime = (providerConfig?: ProviderConfig): AgentRuntime => {
    const config: AgentConfig = {
      agentId: AGENT, name: 'test', model: 'mock/mock',
      workspace: path.join(tmpRoot, 'workspace'),
      systemPrompt: 'You are a test',
      memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
      sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [],
      channelBindings: {} as Record<ChannelType, ChannelBinding>,
      sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
    };
    return new AgentRuntime(
      AGENT, config, provider,
      new SessionStore(path.join(tmpRoot, 'sessions')),
      new ToolRegistry(),
      new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(path.join(tmpRoot, 'audit')),
      new SkillRegistry(), new SkillExecutor(new SkillRegistry()), new PluginRegistry(),
      providerConfig, ke,
    );
  };

  it('constructs the parser with the alias-resolved model, not the raw alias name', async () => {
    const providerConfig: ProviderConfig = {
      name: 'openrouter',
      defaultModel: 'fast',
      aliases: { fast: 'vendor/real-model' },
    };
    const runtime = buildRuntime(providerConfig);

    await runtime.handleMessage(env('My name is Alice and I live in Berlin.'));

    const parserRequest = provider.parserRequest();
    expect(parserRequest).toBeDefined();
    expect(parserRequest?.model).toBe('vendor/real-model');
    expect(parserRequest?.model).not.toBe('fast');
  });

  it('logs a warning through the runtime logger when the parser provider call fails', async () => {
    const providerConfig: ProviderConfig = {
      name: 'openrouter',
      defaultModel: 'broken-model',
      aliases: {},
    };
    provider.failParserWith = new Error('400 broken-model is not a valid model ID');
    const runtime = buildRuntime(providerConfig);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const warnSpy = vi.spyOn((runtime as any).logger, 'warn');

    await runtime.handleMessage(env('My name is Alice and I live in Berlin.'));

    expect(warnSpy).toHaveBeenCalled();
    const calledWithText = warnSpy.mock.calls.some(call =>
      call.some(arg =>
        typeof arg === 'string'
          ? arg.includes('broken-model') && arg.includes('not a valid model ID')
          : JSON.stringify(arg).includes('broken-model')
      )
    );
    expect(calledWithText).toBe(true);

    const stats = runtime.getSemanticParserStats();
    expect(stats?.failures).toBe(1);
    expect(stats?.lastFailedModel).toBe('broken-model');
  });
});
