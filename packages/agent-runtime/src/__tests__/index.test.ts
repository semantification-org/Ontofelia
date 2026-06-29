import { describe, it, expect } from 'vitest';
import { AgentRuntime } from '../index.js';
import { AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent, ChannelType, ChannelBinding } from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';

const mockConfig: AgentConfig = {
  agentId: 'test',
  name: 'test',
  model: 'mock/mock',
  workspace: '/tmp/ontofelia-test-workspace',
  systemPrompt: 'You are a test',
  memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' },
  enabledTools: [],
  enabledSkills: [],
  channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' },
  mediaMaxMb: 8,
  owner: 'test'
};

class DummyProvider implements ProviderAdapter {
  name = 'dummy';
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'dummy', checkedAt: new Date().toISOString() }; }
   
  async chat(_request: ChatRequest): Promise<ChatResponse> {
    return {
      id: '123',
      content: 'test response',
      toolCalls: [],
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
    };
  }
  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.chat(request) };
  }
}

describe('agent-runtime', () => {
  it('AgentRuntime initializes', async () => {
    const id = Math.random().toString(36).slice(2);
    const sessionStore = new SessionStore(`/tmp/ontofelia-test-sessions-${id}`);
    const toolRegistry = new ToolRegistry();
    const toolPolicy = new ToolPolicyEngine({ allow: [], deny: [] });
    const auditLog = new AuditLog(`/tmp/ontofelia-test-workspace-${id}`);
    const skillRegistry = new SkillRegistry();
    const pluginRegistry = new PluginRegistry();
    const skillExecutor = new SkillExecutor(skillRegistry);
    const runtime = new AgentRuntime('test', mockConfig, new DummyProvider(), sessionStore, toolRegistry, toolPolicy, auditLog, skillRegistry, skillExecutor, pluginRegistry);
    expect(runtime.lifecycle).toBe('created');
  });

  it('AgentRuntime /new command creates a new session', async () => {
    const id = Math.random().toString(36).slice(2);
    const sessionStore = new SessionStore(`/tmp/ontofelia-test-sessions-${id}`);
    const toolRegistry = new ToolRegistry();
    const toolPolicy = new ToolPolicyEngine({ allow: [], deny: [] });
    const auditLog = new AuditLog(`/tmp/ontofelia-test-workspace-${id}`);
    const skillRegistry = new SkillRegistry();
    const pluginRegistry = new PluginRegistry();
    const skillExecutor = new SkillExecutor(skillRegistry);
    const runtime = new AgentRuntime('test', mockConfig, new DummyProvider(), sessionStore, toolRegistry, toolPolicy, auditLog, skillRegistry, skillExecutor, pluginRegistry);
    
    // Send normal message
    const env1 = {
      id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm' as const,
      sender: { id: 'u1', channelPrefix: 'webchat', isOwner: true },
      timestamp: new Date().toISOString(), text: 'Hello', mentions: [], attachments: []
    };
    const res1 = await runtime.handleMessage(env1);
    
    // Send /new
    const env2 = { ...env1, text: '/new', routingHints: { sessionId: res1.sessionId } };
    const res2 = await runtime.handleMessage(env2);
    
    expect(res2.sessionId).not.toBe(res1.sessionId);
    expect(res2.text).toBe('Neue Session gestartet.');
  });
});
