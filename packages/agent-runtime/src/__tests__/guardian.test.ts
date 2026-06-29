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
  sessionPolicy: { scope: 'main' }, enabledTools: ['exec'], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test'
};

class ExecProvider implements ProviderAdapter {
  name = 'dummy';
  callCount = 0;
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'dummy', checkedAt: new Date().toISOString() }; }
  async chat(_request: ChatRequest): Promise<ChatResponse> {
    this.callCount++;
    if (this.callCount === 1) {
      return {
        id: '1', content: '', finishReason: 'tool_calls',
        toolCalls: [{ id: 'tc1', name: 'exec', arguments: '{"command":"rm -rf /"}' }],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      };
    } else {
      return {
        id: '2', content: _request.messages[_request.messages.length - 1].content as string, finishReason: 'stop', toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
      };
    }
  }
  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.chat(request) };
  }
}

describe('AgentRuntime guardian', () => {
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
    toolPolicy = new ToolPolicyEngine({ allow: ['exec'], deny: [] });
    auditLog = new AuditLog(`/tmp/ontofelia-test-workspace-${sid}`);
    skillRegistry = new SkillRegistry();
    pluginRegistry = new PluginRegistry();
    skillExecutor = new SkillExecutor(skillRegistry);
    
    toolRegistry.register({
      name: 'exec',
      description: 'exec command',
      category: 'shell',
      inputSchema: {},
      permissions: [],
      execute: async (_input, _ctx) => ({ success: true, output: 'executed', auditEntry: {} as unknown as ToolAuditEntry })
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

  it('awaits guardian approval and denies execution if not approved', async () => {
    const runtime = new AgentRuntime('test', mockConfig, new ExecProvider(), sessionStore, toolRegistry, toolPolicy, auditLog, skillRegistry, skillExecutor, pluginRegistry);

    runtime.onDebug((event) => {
      const data = event.data as { callId?: string } | undefined;
      const callId = data?.callId;
      if (event.phase === 'guardian_confirm' && callId) {
        setTimeout(() => runtime.resolveGuardianApproval(callId, false), 0);
      }
    });

    const res = await runtime.handleMessage(createEnv('do something dangerous'));
    expect(res.text).toMatch(/GUARDIAN_DENIED/);
  });

  it('awaits guardian approval and allows execution if approved', async () => {
    const runtime = new AgentRuntime('test', mockConfig, new ExecProvider(), sessionStore, toolRegistry, toolPolicy, auditLog, skillRegistry, skillExecutor, pluginRegistry);

    runtime.onDebug((event) => {
      const data = event.data as { callId?: string } | undefined;
      const callId = data?.callId;
      if (event.phase === 'guardian_confirm' && callId) {
        setTimeout(() => runtime.resolveGuardianApproval(callId, true), 0);
      }
    });

    const res = await runtime.handleMessage(createEnv('do something dangerous'));
    expect(res.text).toMatch(/executed/);
  });
});
