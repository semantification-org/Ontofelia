import { describe, it, expect } from 'vitest';
import { ToolPolicyEngine } from '../ToolPolicy.js';
import { ToolDefinition, ToolContext, ToolAuditEntry } from '@ontofelia/core';

describe('ToolPolicyEngine', () => {
  const mockContext: ToolContext = {
    agentId: 'a1', sessionId: 's1', workspacePath: '/w', channelType: 'cli', senderId: 'u1', isOwner: true
  };

  const createTool = (name: string, hostOnly = false, sandboxOnly = false): ToolDefinition => ({
    name,
    description: '',
    category: 'utility',
    inputSchema: {},
    permissions: [],
    hostOnly,
    sandboxOnly,
    execute: async () => ({ success: true, output: '', auditEntry: {} as unknown as ToolAuditEntry })
  });

  it('blocks DEFAULT_DENY tools without allow-list', () => {
    const engine = new ToolPolicyEngine({ allow: [], deny: [] });
    const tool = createTool('exec');
    const res = engine.isAllowed(tool, mockContext);
    expect(res.allowed).toBe(false);
    expect(res.requiresApproval).toBe(true);
    expect(res.reason).toMatch(/dangerous and requires explicit approval/);
  });

  it('allows DEFAULT_DENY tools if in allow-list', () => {
    const engine = new ToolPolicyEngine({ allow: ['exec'], deny: [] });
    const tool = createTool('exec');
    const res = engine.isAllowed(tool, mockContext);
    expect(res.allowed).toBe(true);
  });

  it('denies tool if in both allow-list and deny-list', () => {
    const engine = new ToolPolicyEngine({ allow: ['exec'], deny: ['exec'] });
    const tool = createTool('exec');
    const res = engine.isAllowed(tool, mockContext);
    expect(res.allowed).toBe(false);
    expect(res.reason).toMatch(/deny list/);
  });

  it('allows safe tool without config', () => {
    const engine = new ToolPolicyEngine({ allow: [], deny: [] });
    const tool = createTool('safe_tool');
    const res = engine.isAllowed(tool, mockContext);
    expect(res.allowed).toBe(true);
  });

  it('denies hostOnly tool without allow', () => {
    const engine = new ToolPolicyEngine({ allow: [], deny: [] });
    const tool = createTool('custom_host', true, false);
    const res = engine.isAllowed(tool, mockContext);
    expect(res.allowed).toBe(false);
    expect(res.requiresApproval).toBe(true);
    expect(res.reason).toMatch(/hostOnly/);
  });
});
