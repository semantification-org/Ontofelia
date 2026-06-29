import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
import { AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent, ChannelType, ChannelBinding, ToolAuditEntry } from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import * as fs from 'fs/promises';

const mockConfig: AgentConfig = {
  agentId: 'test', name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-test-workspace',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' }, enabledTools: ['test_tool'], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test'
};

class LoopProvider implements ProviderAdapter {
  name = 'dummy';
  callCount = 0;
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'dummy', checkedAt: new Date().toISOString() }; }
  async chat(_request: ChatRequest): Promise<ChatResponse> {
    this.callCount++;
    if (this.callCount === 1) {
      return {
        id: '1', content: '', finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc1', name: 'test_tool', arguments: '{"input":"test"}' }],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      };
    } else if (this.callCount === 2) {
      return {
        id: '2', content: 'tool was called', finishReason: 'stop', toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      };
    } else {
      return { id: '3', content: 'infinite', finishReason: 'tool_calls', toolCalls: [{ id: 'tc2', name: 'test_tool', arguments: '{}' }], usage: { promptTokens:0, completionTokens:0, totalTokens:0 } };
    }
  }
  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.chat(request) };
  }
}

class InfiniteLoopProvider implements ProviderAdapter {
  name = 'dummy';
  callCount = 0;
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'dummy', checkedAt: new Date().toISOString() }; }
  async chat(_request: ChatRequest): Promise<ChatResponse> {
    this.callCount++;
    return { id: '1', content: 'infinite', finishReason: 'tool_calls', toolCalls: [{ id: 'tc', name: 'test_tool', arguments: '{}' }], usage: { promptTokens:0, completionTokens:0, totalTokens:0 } };
  }
  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.chat(request) };
  }
}

describe('AgentRuntime toolLoop', () => {
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
    toolPolicy = new ToolPolicyEngine({ allow: ['test_tool'], deny: [] });
    auditLog = new AuditLog(`/tmp/ontofelia-test-workspace-${sid}`);
    skillRegistry = new SkillRegistry();
    pluginRegistry = new PluginRegistry();
    skillExecutor = new SkillExecutor(skillRegistry);
    
    toolRegistry.register({
      name: 'test_tool',
      description: 'test',
      category: 'utility',
      inputSchema: {},
      permissions: [],
      execute: async (_input, _ctx) => ({ success: true, output: 'tool_success', auditEntry: {} as unknown as ToolAuditEntry })
    });
  });

  afterEach(async () => {
    await fs.rm(`/tmp/ontofelia-test-sessions-${sid}`, { recursive: true, force: true }).catch(() => {});
  });

  const createEnv = (text: string) => ({
    id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm' as const,
    sender: { id: 'u1', channelPrefix: 'webchat', isOwner: true },
    timestamp: new Date().toISOString(), text, mentions: [], attachments: []
  });

  it('executes tool call and continues loop', async () => {
    const runtime = new AgentRuntime('test', mockConfig, new LoopProvider(), sessionStore, toolRegistry, toolPolicy, auditLog, skillRegistry, skillExecutor, pluginRegistry);
    const res = await runtime.handleMessage(createEnv('call tool'));
    expect(res.text).toBe('tool was called');
  });

  it('aborts loop after max iterations', async () => {
    const provider = new InfiniteLoopProvider();
    const runtime = new AgentRuntime('test', mockConfig, provider, sessionStore, toolRegistry, toolPolicy, auditLog, skillRegistry, skillExecutor, pluginRegistry);
    const res = await runtime.handleMessage(createEnv('call tool'));
    expect(res.text).toBe('infinite');
    expect(provider.callCount).toBe(101); // 1 initial + 100 iterations
  });
});
