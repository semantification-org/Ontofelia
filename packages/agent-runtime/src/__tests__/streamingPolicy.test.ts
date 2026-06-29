import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
import {
  AgentConfig,
  ChannelBinding,
  ChannelType,
  ChatResponse,
  ProviderAdapter,
  StreamEvent,
  ToolDefinition,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import * as fs from 'fs/promises';

const mockConfig: AgentConfig = {
  agentId: 'test',
  name: 'test',
  model: 'mock/mock',
  workspace: '/tmp/ontofelia-test-workspace',
  systemPrompt: 'You are a test',
  memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' },
  enabledTools: ['host_tool'],
  enabledSkills: [],
  channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' },
  mediaMaxMb: 8,
  owner: 'test',
};

class StreamingHostToolProvider implements ProviderAdapter {
  name = 'dummy';
  streamCalls = 0;

  async initialize() {}

  async healthCheck() {
    return { healthy: true, component: 'dummy', checkedAt: new Date().toISOString() };
  }

  async chat(): Promise<ChatResponse> {
    throw new Error('chat() is not used by this streaming test');
  }

  async *chatStream(): AsyncIterable<StreamEvent> {
    this.streamCalls++;
    if (this.streamCalls === 1) {
      yield {
        type: 'done',
        response: {
          id: '1',
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [{ id: 'tc-policy', name: 'host_tool', arguments: '{"value":"safe"}' }],
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        },
      };
      return;
    }

    yield { type: 'text_delta', content: 'finished' };
    yield {
      type: 'done',
      response: {
        id: '2',
        content: 'finished',
        finishReason: 'stop',
        toolCalls: [],
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    };
  }
}

describe('AgentRuntime streaming tool policy', () => {
  let sessionStore: SessionStore;
  let toolRegistry: ToolRegistry;
  let toolPolicy: ToolPolicyEngine;
  let auditLog: AuditLog;
  let skillRegistry: SkillRegistry;
  let pluginRegistry: PluginRegistry;
  let skillExecutor: SkillExecutor;
  let sid: string;
  let toolExecutionCount: number;

  beforeEach(() => {
    sid = Math.random().toString(36).slice(2);
    sessionStore = new SessionStore(`/tmp/ontofelia-test-sessions-${sid}`);
    toolRegistry = new ToolRegistry();
    toolPolicy = new ToolPolicyEngine({ allow: [], deny: [] });
    auditLog = new AuditLog(`/tmp/ontofelia-test-workspace-${sid}`);
    skillRegistry = new SkillRegistry();
    pluginRegistry = new PluginRegistry();
    skillExecutor = new SkillExecutor(skillRegistry);
    toolExecutionCount = 0;

    const hostTool: ToolDefinition = {
      name: 'host_tool',
      description: 'host-only tool',
      category: 'utility',
      inputSchema: {},
      permissions: [],
      hostOnly: true,
      execute: async (input) => {
        toolExecutionCount++;
        return {
          success: true,
          output: 'executed',
          auditEntry: {
            toolName: 'host_tool',
            timestamp: new Date().toISOString(),
            duration: 0,
            input,
            output: 'executed',
            success: true,
            permissions: [],
          },
        };
      },
    };
    toolRegistry.register(hostTool);
  });

  afterEach(async () => {
    await fs.rm(`/tmp/ontofelia-test-sessions-${sid}`, { recursive: true, force: true }).catch(() => {});
    await fs.rm(`/tmp/ontofelia-test-workspace-${sid}`, { recursive: true, force: true }).catch(() => {});
  });

  const createEnv = (text: string) => ({
    id: '1',
    channel: 'webchat' as ChannelType,
    accountId: 'none',
    chatType: 'dm' as const,
    sender: { id: 'u1', channelPrefix: 'webchat', isOwner: true },
    timestamp: new Date().toISOString(),
    text,
    mentions: [],
    attachments: [],
  });

  it('requires approval for host-only tools during streaming responses', async () => {
    const runtime = new AgentRuntime(
      'test',
      mockConfig,
      new StreamingHostToolProvider(),
      sessionStore,
      toolRegistry,
      toolPolicy,
      auditLog,
      skillRegistry,
      skillExecutor,
      pluginRegistry,
    );

    let capturedCallId: string | undefined;
    runtime.onDebug((event) => {
      const data = event.data as { callId?: string } | undefined;
      const callId = data?.callId;
      if (event.phase === 'guardian_confirm' && callId) {
        capturedCallId = callId;
        setTimeout(() => runtime.resolveGuardianApproval(callId, false), 0);
      }
    });

    const chunks = [];
    for await (const chunk of runtime.handleMessageStream(createEnv('use host tool'))) {
      chunks.push(chunk);
    }

    const deniedToolResult = chunks.find((chunk) => chunk.type === 'tool_result');
    expect(capturedCallId).toBe('tc-policy');
    expect(toolExecutionCount).toBe(0);
    expect(deniedToolResult).toMatchObject({
      type: 'tool_result',
      name: 'host_tool',
      success: false,
    });
    expect(JSON.stringify(deniedToolResult)).toContain('GUARDIAN_DENIED');
  });
});
