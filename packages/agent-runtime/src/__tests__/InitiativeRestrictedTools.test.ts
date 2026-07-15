import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
import {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, ToolDefinition, ToolContext, ToolResult,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog, NotifyOwnerTool, type OwnerNotifier } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import * as fs from 'fs/promises';

const mockConfig: AgentConfig = {
  agentId: 'test', name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-restricted-workspace',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
};

/** Captures the tool set handed to the provider on each chat. */
class CapturingProvider implements ProviderAdapter {
  name = 'dummy';
  lastRequest?: ChatRequest;
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'dummy', checkedAt: new Date().toISOString() }; }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.lastRequest = request;
    return { id: '1', content: 'ok', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.chat(request) };
  }
}

/**
 * Provider that replays a scripted list of responses (one per chat() call), so
 * a test can force the "LLM" to emit a tool call the runtime never advertised.
 */
class ScriptedProvider implements ProviderAdapter {
  name = 'scripted';
  private i = 0;
  constructor(private readonly script: ChatResponse[]) {}
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'scripted', checkedAt: new Date().toISOString() }; }
  async chat(): Promise<ChatResponse> {
    const r = this.script[Math.min(this.i, this.script.length - 1)];
    this.i++;
    return r;
  }
  async *chatStream(): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.chat() };
  }
}

/** Minimal ToolDefinition stand-in — the tool-set filter only reads name/flags. */
function fakeTool(name: string, category: ToolDefinition['category'], opts: { hostOnly?: boolean } = {}): ToolDefinition {
  return {
    name,
    description: name,
    category,
    inputSchema: { type: 'object', properties: {} },
    permissions: [],
    hostOnly: opts.hostOnly,
    async execute(): Promise<ToolResult> {
      return { success: true, output: '', auditEntry: { toolName: name, timestamp: '', duration: 0, input: {}, output: '', success: true, permissions: [] } };
    },
  };
}

/** A tool that records whether its execute() actually ran (proves hard-deny). */
function spyTool(name: string, category: ToolDefinition['category']): { tool: ToolDefinition; ran: () => boolean } {
  let didRun = false;
  const tool: ToolDefinition = {
    name, description: name, category, inputSchema: { type: 'object', properties: {} }, permissions: [],
    async execute(): Promise<ToolResult> {
      didRun = true;
      return { success: true, output: `${name} ran`, auditEntry: { toolName: name, timestamp: '', duration: 0, input: {}, output: '', success: true, permissions: [] } };
    },
  };
  return { tool, ran: () => didRun };
}

const fakeNotifier: OwnerNotifier = {
  async deliver() { return { sent: true, reason: 'sent', target: 'owner' }; },
};

function toolNames(p: CapturingProvider): string[] {
  return (p.lastRequest?.tools ?? []).map((t) => t.name);
}

describe('initiative restricted tool set (getAllowedTools)', () => {
  let runtime: AgentRuntime;
  let provider: CapturingProvider;
  let sid: string;

  beforeEach(() => {
    sid = Math.random().toString(36).slice(2);
    const sessionStore = new SessionStore(`/tmp/ontofelia-restricted-sessions-${sid}`);
    const toolRegistry = new ToolRegistry();
    // A representative mix: dangerous/host + read-only + notify_owner.
    toolRegistry.register(fakeTool('datetime', 'utility'));
    toolRegistry.register(fakeTool('memory_ask', 'memory'));
    toolRegistry.register(fakeTool('memory_query', 'memory')); // default-deny; dead in initiative
    toolRegistry.register(fakeTool('fs_read', 'filesystem'));
    toolRegistry.register(fakeTool('exec', 'shell'));
    toolRegistry.register(fakeTool('fs_write', 'filesystem'));
    toolRegistry.register(fakeTool('cron_manage', 'shell', { hostOnly: true }));
    toolRegistry.register(fakeTool('memory_retract', 'memory'));
    toolRegistry.register(new NotifyOwnerTool(fakeNotifier));
    const toolPolicy = new ToolPolicyEngine({ allow: [], deny: [] });
    const auditLog = new AuditLog(`/tmp/ontofelia-restricted-workspace-${sid}`);
    const skillRegistry = new SkillRegistry();
    const pluginRegistry = new PluginRegistry();
    const skillExecutor = new SkillExecutor(skillRegistry);
    provider = new CapturingProvider();
    runtime = new AgentRuntime('test', mockConfig, provider, sessionStore, toolRegistry, toolPolicy, auditLog, skillRegistry, skillExecutor, pluginRegistry);
  });

  afterEach(async () => {
    await fs.rm(`/tmp/ontofelia-restricted-sessions-${sid}`, { recursive: true, force: true }).catch(() => {});
  });

  const convEnv = (isOwner = true) => ({
    id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm' as const,
    sender: { id: 'u1', channelPrefix: 'webchat', isOwner },
    timestamp: new Date().toISOString(), text: 'hello', mentions: [], attachments: [],
  });

  const initiativeEnv = () => ({
    id: '2', channel: 'system' as ChannelType, accountId: 'initiative', chatType: 'initiative' as const,
    sender: { id: 'initiative', channelPrefix: 'system', isOwner: true },
    timestamp: new Date().toISOString(), text: 'initiative wake', mentions: [], attachments: [],
    routingHints: { sessionId: undefined },
  });

  it('conversational cycle keeps the full (dangerous-inclusive) tool set', async () => {
    await runtime.handleMessage(convEnv());
    const names = toolNames(provider);
    // A known dangerous tool is still present for owner conversational use.
    expect(names).toContain('exec');
    expect(names).toContain('fs_write');
    expect(names).toContain('cron_manage');
    expect(names).toContain('memory_retract');
    expect(names).toContain('notify_owner');
    expect(names).toContain('datetime');
  });

  it('initiative cycle is narrowed to notify_owner + read-only tools', async () => {
    await runtime.handleMessage(initiativeEnv());
    const names = toolNames(provider);
    expect(names).toContain('notify_owner');
    expect(names).toContain('memory_ask');
    expect(names).toContain('fs_read');
    expect(names).toContain('datetime');
    // Destructive/host tools are excluded entirely (not merely approval-gated).
    expect(names).not.toContain('exec');
    expect(names).not.toContain('fs_write');
    expect(names).not.toContain('cron_manage');
    expect(names).not.toContain('memory_retract');
    // L2: memory_query is default-deny (dead unattended) and removed from the set.
    expect(names).not.toContain('memory_query');
  });

  it('H2: notify_owner is hidden from a non-owner conversational caller', async () => {
    await runtime.handleMessage(convEnv(false));
    const names = toolNames(provider);
    expect(names).not.toContain('notify_owner');
    // Other tools remain available to the non-owner conversational cycle.
    expect(names).toContain('datetime');
  });
});

describe('B1: initiative execution gate (ToolExecutor)', () => {
  let sid: string;
  let toolRegistry: ToolRegistry;
  let memoryStore: { tool: ToolDefinition; ran: () => boolean };

  function makeRuntime(provider: ProviderAdapter): AgentRuntime {
    const sessionStore = new SessionStore(`/tmp/ontofelia-b1-sessions-${sid}`);
    const toolPolicy = new ToolPolicyEngine({ allow: [], deny: [] });
    const auditLog = new AuditLog(`/tmp/ontofelia-b1-workspace-${sid}`);
    const skillRegistry = new SkillRegistry();
    const skillExecutor = new SkillExecutor(skillRegistry);
    return new AgentRuntime('test', mockConfig, provider, sessionStore, toolRegistry, toolPolicy, auditLog, skillRegistry, skillExecutor, new PluginRegistry());
  }

  const memStoreCall = (): ChatResponse => ({
    id: 'r1', content: '', finishReason: 'tool_calls',
    toolCalls: [{ id: 'c1', name: 'memory_store', arguments: '{"subject":"x","predicate":"y","object":"z"}' }],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
  const stop = (): ChatResponse => ({
    id: 'r2', content: 'done', finishReason: 'stop', toolCalls: [],
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });

  beforeEach(() => {
    sid = Math.random().toString(36).slice(2);
    toolRegistry = new ToolRegistry();
    memoryStore = spyTool('memory_store', 'memory'); // NOT in the initiative allowlist
    toolRegistry.register(memoryStore.tool);
    toolRegistry.register(fakeTool('exec', 'shell'));
    toolRegistry.register(fakeTool('fs_write', 'filesystem'));
  });

  afterEach(async () => {
    await fs.rm(`/tmp/ontofelia-b1-sessions-${sid}`, { recursive: true, force: true }).catch(() => {});
  });

  const initiativeEnv = () => ({
    id: 'i1', channel: 'system' as ChannelType, accountId: 'initiative', chatType: 'initiative' as const,
    sender: { id: 'initiative', channelPrefix: 'system', isOwner: true },
    timestamp: new Date().toISOString(), text: 'wake', mentions: [], attachments: [],
    routingHints: { sessionId: undefined },
  });
  const convEnv = () => ({
    id: 'c1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm' as const,
    sender: { id: 'u1', channelPrefix: 'webchat', isOwner: true },
    timestamp: new Date().toISOString(), text: 'store this', mentions: [], attachments: [],
  });

  it('hard-denies an UNADVERTISED memory_store call in an initiative context; the tool never runs', async () => {
    const provider = new ScriptedProvider([memStoreCall(), stop()]);
    const runtime = makeRuntime(provider);
    await runtime.handleMessage(initiativeEnv());
    // The execution chokepoint denied it — execute() was never reached.
    expect(memoryStore.ran()).toBe(false);
  });

  it('executes memory_store normally in a conversational context', async () => {
    const provider = new ScriptedProvider([memStoreCall(), stop()]);
    const runtime = makeRuntime(provider);
    await runtime.handleMessage(convEnv());
    expect(memoryStore.ran()).toBe(true);
  });
});

describe('NotifyOwnerTool.execute', () => {
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    agentId: 'test', sessionId: 's1', workspacePath: '/tmp', channelType: 'system',
    senderId: 'initiative', isOwner: true, unattended: true, ...over,
  });

  it('reports sent when the service delivers (initiative/unattended)', async () => {
    const tool = new NotifyOwnerTool({ async deliver() { return { sent: true, reason: 'sent' }; } });
    const res = await tool.execute({ message: 'progress update', priority: 'normal' }, ctx());
    expect(res.success).toBe(true);
    expect(String(res.output)).toMatch(/sent to the owner/i);
  });

  it('reports suppressed + reason when the service defers', async () => {
    const tool = new NotifyOwnerTool({ async deliver() { return { sent: false, reason: 'quiet-hours' }; } });
    const res = await tool.execute({ message: 'ping', priority: 'low' }, ctx());
    expect(res.success).toBe(true);
    expect(String(res.output)).toMatch(/NOT sent/);
    expect(String(res.output)).toMatch(/quiet-hours/);
  });

  it('does not double-send when the owner is the current chat', async () => {
    let called = false;
    const tool = new NotifyOwnerTool({ async deliver() { called = true; return { sent: true, reason: 'sent' }; } });
    const res = await tool.execute({ message: 'hi', priority: 'normal' }, ctx({ channelType: 'webchat', unattended: false, isOwner: true }));
    expect(called).toBe(false);
    expect(res.success).toBe(true);
    expect(String(res.output)).toMatch(/already talking to the owner/i);
  });

  it('L1: a cron caller (system channel, NOT unattended) is treated as owner-in-chat, not initiative', async () => {
    let called = false;
    const tool = new NotifyOwnerTool({ async deliver() { called = true; return { sent: true, reason: 'sent' }; } });
    // channelType 'system' but unattended:false + isOwner (the /api/cron-trigger shape).
    const res = await tool.execute({ message: 'hi', priority: 'normal' }, ctx({ channelType: 'system', unattended: false, isOwner: true }));
    expect(called).toBe(false);
    expect(res.success).toBe(true);
    expect(String(res.output)).toMatch(/already talking to the owner/i);
  });

  it('H2: refuses a NON-owner conversational caller and never delivers', async () => {
    let called = false;
    const tool = new NotifyOwnerTool({ async deliver() { called = true; return { sent: true, reason: 'sent' }; } });
    const res = await tool.execute({ message: 'harass the owner', priority: 'high' }, ctx({ channelType: 'webchat', unattended: false, isOwner: false, senderId: 'attacker' }));
    expect(called).toBe(false); // service NEVER called → no digest, no cap consumed
    expect(res.success).toBe(false);
    expect(String(res.output)).toMatch(/only available to the owner/i);
  });
});
