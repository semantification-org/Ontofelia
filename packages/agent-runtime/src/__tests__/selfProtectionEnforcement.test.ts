import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ToolExecutor } from '../executor/ToolExecutor.js';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { ToolAuditEntry, ToolContext } from '@ontofelia/core';

// The ToolExecutor is the chokepoint EVERY tool dispatch passes through — and
// it runs AFTER Guardian approval. These tests prove the self-protection hard
// blocks fire there, so a Guardian approve-all session cannot override them.

let base: string;
let root: string;      // protected installation root
let workspace: string; // agent workspace

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ontofelia-selfprot-exec-'));
  root = path.join(base, 'install');
  workspace = path.join(base, 'workspace');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const context: ToolContext = {
  agentId: 'a1', sessionId: 's1', workspacePath: '', channelType: 'cli',
  senderId: 'u1', isOwner: true,
};

function makeExecutor(opts: { allowSelfSourceWrites?: boolean } = {}) {
  const registry = new ToolRegistry();
  const writeSpy = vi.fn(async () => ({
    success: true, output: 'written', auditEntry: {
      toolName: 'fs_write', timestamp: new Date().toISOString(), duration: 0,
      input: {}, output: {}, success: true, permissions: ['fs:write'],
    } as ToolAuditEntry,
  }));
  const execSpy = vi.fn(async () => ({
    success: true, output: 'ran', auditEntry: {
      toolName: 'exec', timestamp: new Date().toISOString(), duration: 0,
      input: {}, output: {}, success: true, permissions: ['shell:exec'],
    } as ToolAuditEntry,
  }));
  registry.register({
    name: 'fs_write', description: 't', category: 'filesystem', inputSchema: {},
    permissions: ['fs:write'], execute: writeSpy,
  });
  registry.register({
    name: 'exec', description: 't', category: 'shell', inputSchema: {},
    permissions: ['shell:exec'], execute: execSpy,
  });
  const policy = new ToolPolicyEngine({
    // Both tools explicitly allowed — the hard block must still win.
    allow: ['fs_write', 'exec'],
    deny: [],
    selfProtection: {
      protectedRoots: [root],
      dataDir: path.join(base, 'data'),
      allowSelfSourceWrites: opts.allowSelfSourceWrites,
    },
  });
  const auditLog = new AuditLog(path.join(base, 'audit'));
  return { executor: new ToolExecutor(registry, policy, auditLog), writeSpy, execSpy };
}

describe('ToolExecutor self-protection enforcement (post-approval chokepoint)', () => {
  beforeAll(() => { context.workspacePath = workspace; });

  it('hard-denies fs_write into the protected root; the tool never runs', async () => {
    const { executor, writeSpy } = makeExecutor();
    const res = await executor.execute(
      { id: 't1', name: 'fs_write', arguments: JSON.stringify({ path: path.join(root, 'index.ts'), content: 'x' }) },
      context,
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/self-source-write/);
    expect((res.output as { blockedBy?: string }).blockedBy).toBe('self-source-write');
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('hard-denies exec source mutation and git-state destruction; the tool never runs', async () => {
    const { executor, execSpy } = makeExecutor();
    const rm = await executor.execute(
      { id: 't2', name: 'exec', arguments: JSON.stringify({ command: `rm -rf ${root}/packages` }) },
      context,
    );
    expect(rm.success).toBe(false);
    expect(rm.error).toMatch(/self-source-write/);

    const git = await executor.execute(
      { id: 't3', name: 'exec', arguments: JSON.stringify({ command: 'git reset --hard', cwd: root }) },
      context,
    );
    expect(git.success).toBe(false);
    expect(git.error).toMatch(/self-git-protection/);
    expect(execSpy).not.toHaveBeenCalled();
  });

  it('still executes benign invocations (workspace writes, read-only exec)', async () => {
    const { executor, writeSpy, execSpy } = makeExecutor();
    const w = await executor.execute(
      { id: 't4', name: 'fs_write', arguments: JSON.stringify({ path: 'notes.md', content: 'x' }) },
      context,
    );
    expect(w.success).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);

    const e = await executor.execute(
      { id: 't5', name: 'exec', arguments: JSON.stringify({ command: `cat ${root}/README.md` }) },
      context,
    );
    expect(e.success).toBe(true);
    expect(execSpy).toHaveBeenCalledTimes(1);
  });

  it('owner config override (security.allowSelfSourceWrites) lifts the block', async () => {
    const { executor, writeSpy } = makeExecutor({ allowSelfSourceWrites: true });
    const res = await executor.execute(
      { id: 't6', name: 'fs_write', arguments: JSON.stringify({ path: path.join(root, 'index.ts'), content: 'x' }) },
      context,
    );
    expect(res.success).toBe(true);
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });
});
