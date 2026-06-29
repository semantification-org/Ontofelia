import { describe, it, expect } from 'vitest';
import { FsReadTool } from '../fs_read.js';
import { ToolContext } from '@ontofelia/core';

describe('FsReadTool path validation', () => {
  it('rejects path traversal attempts', async () => {
    const tool = new FsReadTool();
    const context: ToolContext = {
      agentId: 'a', sessionId: 's', workspacePath: '/test/workspace',
      channelType: 'cli', senderId: 'u', isOwner: true
    };
    
    // Test basic traversal
    let res = await tool.execute({ path: '../secret.txt' }, context);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Path traversal detected/);

    // Test absolute path outside workspace
    res = await tool.execute({ path: '/etc/passwd' }, context);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Path traversal detected/);

    // Test tricky path that starts with workspace string but is outside
    res = await tool.execute({ path: '../workspace-secret/foo.txt' }, context);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Path traversal detected/);
  });
});
