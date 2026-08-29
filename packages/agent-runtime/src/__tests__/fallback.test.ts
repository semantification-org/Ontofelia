import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AgentRuntime } from '../index.js';
import { AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent, ChannelType, ChannelBinding } from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import * as fs from 'fs/promises';

const mockConfig: AgentConfig = {
  agentId: 'test', name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-test-workspace',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test'
};

class FailingProvider implements ProviderAdapter {
  name = 'failing';
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'dummy', checkedAt: new Date().toISOString() }; }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    if (request.model === 'mock/mock') {
      throw new Error('Primary model failed');
    } else if (request.model === 'google/gemma-3-27b-it:free') {
      return { id: 'fallback', content: 'fallback success', toolCalls: [], finishReason: 'stop', usage: { promptTokens:0, completionTokens:0, totalTokens:0 } };
    }
    throw new Error('Fallback failed too');
  }
  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.chat(request) };
  }
}

/** The primary model reports a stream error; the fallback model streams content. */
class StreamFailingProvider implements ProviderAdapter {
  name = 'stream-failing';
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'dummy', checkedAt: new Date().toISOString() }; }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    return { id: 'x', content: request.model === 'mock/mock' ? '' : 'fallback success', toolCalls: [], finishReason: 'stop', usage: { promptTokens:0, completionTokens:0, totalTokens:0 } };
  }
  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    if (request.model === 'mock/mock') {
      yield { type: 'error', error: 'Primary model failed' };
      return;
    }
    yield { type: 'text_delta', content: 'fallback success' };
    yield { type: 'done', response: await this.chat(request) };
  }
}

describe('AgentRuntime fallback', () => {
  let sessionStore: SessionStore;
  let toolRegistry: ToolRegistry;
  let toolPolicy: ToolPolicyEngine;
  let auditLog: AuditLog;
  let skillRegistry: SkillRegistry;
  let pluginRegistry: PluginRegistry;
  let skillExecutor: SkillExecutor;
  let sid: string;

  beforeEach(() => {
    sid = Math.random().toString(36).slice(2);
    sessionStore = new SessionStore(`/tmp/ontofelia-test-sessions-${sid}`);
    toolRegistry = new ToolRegistry();
    toolPolicy = new ToolPolicyEngine({ allow: [], deny: [] });
    auditLog = new AuditLog(`/tmp/ontofelia-test-workspace-${sid}`);
    skillRegistry = new SkillRegistry();
    pluginRegistry = new PluginRegistry();
    skillExecutor = new SkillExecutor(skillRegistry);
  });

  afterEach(async () => {
    await fs.rm(`/tmp/ontofelia-test-sessions-${sid}`, { recursive: true, force: true }).catch(() => {});
  });

  const createEnv = (text: string) => ({
    id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm' as const,
    sender: { id: 'u1', channelPrefix: 'webchat', isOwner: true },
    timestamp: new Date().toISOString(), text, mentions: [], attachments: []
  });

  it('falls back to configured models if primary fails', async () => {
    const runtime = new AgentRuntime('test', mockConfig, new FailingProvider(), sessionStore, toolRegistry, toolPolicy, auditLog, skillRegistry, skillExecutor, pluginRegistry, {
      name: 'test', defaultModel: 'mock/mock', aliases: {}, autoFallback: true, fallbackModels: ['google/gemma-3-27b-it:free']
    });
    const res = await runtime.handleMessage(createEnv('hello'));
    expect(res.fallbackModel).toBe('google/gemma-3-27b-it:free');
    expect(res.text).toBe('fallback success');
  });

  it('exposes and logs a used fallback (non-streaming)', async () => {
    const runtime = new AgentRuntime('test', mockConfig, new FailingProvider(), sessionStore, toolRegistry, toolPolicy, auditLog, skillRegistry, skillExecutor, pluginRegistry, {
      name: 'test', defaultModel: 'mock/mock', aliases: {}, autoFallback: true, fallbackModels: ['google/gemma-3-27b-it:free']
    });
    expect(runtime.getLastFallback()).toBeNull();

    const warnSpy = vi.spyOn((runtime as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn');
    await runtime.handleMessage(createEnv('hello'));

    const record = runtime.getLastFallback();
    expect(record).not.toBeNull();
    expect(record!.requestedModel).toBe('mock/mock');
    expect(record!.usedModel).toBe('google/gemma-3-27b-it:free');
    expect(record!.reason).toContain('Primary model failed');
    expect(new Date(record!.at).toISOString()).toBe(record!.at);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Model fallback'));
  });

  it('exposes and logs a used fallback (streaming)', async () => {
    const runtime = new AgentRuntime('test', mockConfig, new StreamFailingProvider(), sessionStore, toolRegistry, toolPolicy, auditLog, skillRegistry, skillExecutor, pluginRegistry, {
      name: 'test', defaultModel: 'mock/mock', aliases: {}, autoFallback: true, fallbackModels: ['google/gemma-3-27b-it:free']
    });
    const warnSpy = vi.spyOn((runtime as unknown as { logger: { warn: (msg: string) => void } }).logger, 'warn');

    for await (const _chunk of runtime.handleMessageStream(createEnv('hello'))) { /* drain */ }

    const record = runtime.getLastFallback();
    expect(record).not.toBeNull();
    expect(record!.requestedModel).toBe('mock/mock');
    expect(record!.usedModel).toBe('google/gemma-3-27b-it:free');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Model fallback'));
  });

  it('does not fall back when no fallback models are configured', async () => {
    const runtime = new AgentRuntime('test', mockConfig, new FailingProvider(), sessionStore, toolRegistry, toolPolicy, auditLog, skillRegistry, skillExecutor, pluginRegistry, {
      name: 'test', defaultModel: 'mock/mock', aliases: {}, autoFallback: true
    });
    const res = await runtime.handleMessage(createEnv('hello'));
    expect(res.text).toMatch(/No models responded/);
    expect(runtime.getLastFallback()).toBeNull();
  });

  it('returns error if all fallbacks fail', async () => {
    const runtime = new AgentRuntime('test', mockConfig, new FailingProvider(), sessionStore, toolRegistry, toolPolicy, auditLog, skillRegistry, skillExecutor, pluginRegistry, {
      name: 'test', defaultModel: 'mock/mock', aliases: {}, autoFallback: true, fallbackModels: ['unsupported-model']
    });
    const res = await runtime.handleMessage(createEnv('hello'));
    expect(res.text).toMatch(/No models responded/);
  });
});
