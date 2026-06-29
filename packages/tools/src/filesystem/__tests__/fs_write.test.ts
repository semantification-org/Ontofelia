import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FsWriteTool } from '../fs_write.js';
import { ToolContext } from '@ontofelia/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('FsWriteTool', () => {
  const tool = new FsWriteTool();
  let tempDir: string;
  let context: ToolContext;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-fs-write-test-'));
    context = {
      agentId: 'test',
      sessionId: 'test',
      workspacePath: tempDir,
      channelType: 'cli',
      senderId: 'u',
      isOwner: true
    };
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('writes content to a file', async () => {
    const res = await tool.execute({ path: 'test.txt', content: 'hello world' }, context);
    expect(res.success).toBe(true);

    const content = await fs.readFile(path.join(tempDir, 'test.txt'), 'utf-8');
    expect(content).toBe('hello world');
  });

  it('appends content to a file', async () => {
    await tool.execute({ path: 'append.txt', content: 'hello' }, context);
    const res = await tool.execute({ path: 'append.txt', content: ' world', append: true }, context);
    expect(res.success).toBe(true);

    const content = await fs.readFile(path.join(tempDir, 'append.txt'), 'utf-8');
    expect(content).toBe('hello world');
  });

  it('blocks path traversal (../)', async () => {
    const res = await tool.execute({ path: '../secret.txt', content: 'hacked' }, context);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Path traversal detected/);
  });

  it('blocks absolute paths outside workspace', async () => {
    const res = await tool.execute({ path: '/tmp/evil.txt', content: 'hacked' }, context);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Path traversal detected/);
  });
});
