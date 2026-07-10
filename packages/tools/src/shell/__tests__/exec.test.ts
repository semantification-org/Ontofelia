import { describe, it, expect, vi } from 'vitest';
import { ExecTool } from '../exec.js';
import { ToolContext } from '@ontofelia/core';

describe('ExecTool', () => {
  it('uses context.sandboxConfig if provided', async () => {
    const sandboxMock = {
      getOrCreate: vi.fn().mockResolvedValue('sandbox-id'),
      exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'ok', stderr: '' })
    } as unknown as ConstructorParameters<typeof ExecTool>[0];
    
    const tool = new ExecTool(sandboxMock);
    
    const context: ToolContext = {
      agentId: 'a1',
      sessionId: 's1',
      workspacePath: '/ws',
      channelType: 'cli',
      senderId: 'usr',
      isOwner: true,
      sandboxConfig: { scope: 'agent', workspaceAccess: 'ro' }
    };

    await tool.execute({ command: 'echo hello' }, context);
    
    expect(sandboxMock.getOrCreate).toHaveBeenCalledWith(
      'a1', 's1', { scope: 'agent', workspaceAccess: 'ro' }, '/ws'
    );
    expect(sandboxMock.exec).toHaveBeenCalledWith(
      'sandbox-id', 'echo hello', expect.anything()
    );
  });

  describe('self-restart guardrail', () => {
    const forbidden = [
      'node apps/cli/dist/index.js gateway restart',
      'cd /home/user/Ontofelia && bash run-gateway.sh gateway restart',
      'run-gateway.sh gateway stop',
      'gateway start',
      'bash ~/ontofelia-docker/run.sh',
      'docker restart ontofelia-gateway',
      'docker stop ontofelia-gateway',
      'pkill -f node',
      'killall node',
      'kill -9 1',
      'systemctl restart ontofelia',
    ];
    for (const cmd of forbidden) {
      it(`refuses self-destructive command: ${cmd}`, async () => {
        const sandboxMock = { getOrCreate: vi.fn(), exec: vi.fn() } as unknown as ConstructorParameters<typeof ExecTool>[0];
        const tool = new ExecTool(sandboxMock);
        const ctx: ToolContext = {
          agentId: 'a1', sessionId: 's1', workspacePath: '/ws', channelType: 'cli',
          senderId: 'usr', isOwner: true,
        } as ToolContext;
        const res = await tool.execute({ command: cmd }, ctx);
        expect(res.success).toBe(false);
        expect((res.output as { exitCode?: number }).exitCode).toBe(126);
        // the command must NOT have reached the sandbox
        expect(sandboxMock.getOrCreate).not.toHaveBeenCalled();
        expect(sandboxMock.exec).not.toHaveBeenCalled();
      });
    }

    const allowed = [
      'echo hello',
      'grep -rn "gateway" packages/',          // mentions gateway but not a lifecycle verb
      'node build.js',
      'git status',
      'pnpm --filter @ontofelia/eval test',
    ];
    for (const cmd of allowed) {
      it(`allows benign command: ${cmd}`, async () => {
        const sandboxMock = {
          getOrCreate: vi.fn().mockResolvedValue('sb'),
          exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
        } as unknown as ConstructorParameters<typeof ExecTool>[0];
        const tool = new ExecTool(sandboxMock);
        const ctx: ToolContext = {
          agentId: 'a1', sessionId: 's1', workspacePath: '/ws', channelType: 'cli',
          senderId: 'usr', isOwner: true,
        } as ToolContext;
        await tool.execute({ command: cmd }, ctx);
        expect(sandboxMock.exec).toHaveBeenCalled();
      });
    }
  });

  describe('timeout handling (BUG-B)', () => {
    const ctx: ToolContext = {
      agentId: 'a1', sessionId: 's1', workspacePath: '/ws', channelType: 'cli',
      senderId: 'usr', isOwner: true,
    } as ToolContext;
    const mkSandbox = (result: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean }) => ({
      getOrCreate: vi.fn().mockResolvedValue('sb'),
      exec: vi.fn().mockResolvedValue(result),
    } as unknown as ConstructorParameters<typeof ExecTool>[0]);

    it('defaults the per-command timeout when none is given', async () => {
      const sandboxMock = mkSandbox({ exitCode: 0, stdout: '', stderr: '' });
      await new ExecTool(sandboxMock).execute({ command: 'echo hi' }, ctx);
      const opts = (sandboxMock.exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(opts.timeoutMs).toBe(ExecTool.DEFAULT_TIMEOUT_MS);
    });

    it('passes a caller timeout through and clamps it to the max', async () => {
      const sandboxMock = mkSandbox({ exitCode: 0, stdout: '', stderr: '' });
      const tool = new ExecTool(sandboxMock);
      await tool.execute({ command: 'pnpm build', timeout: 600_000 }, ctx);
      let opts = (sandboxMock.exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2];
      expect(opts.timeoutMs).toBe(600_000); // honored, not capped at 30s

      await tool.execute({ command: 'pnpm build', timeout: 99_999_999 }, ctx);
      opts = (sandboxMock.exec as unknown as ReturnType<typeof vi.fn>).mock.calls[1][2];
      expect(opts.timeoutMs).toBe(ExecTool.MAX_TIMEOUT_MS); // clamped
    });

    it('exposes an executor-level ceiling above the max command timeout', () => {
      // ToolExecutor times out at `tool.timeoutMs`; it must exceed MAX so exec's
      // own timeout always fires first and returns a clean timedOut result.
      const tool = new ExecTool(mkSandbox({ exitCode: 0, stdout: '', stderr: '' }));
      expect(tool.timeoutMs).toBeGreaterThan(ExecTool.MAX_TIMEOUT_MS);
    });

    it('returns an actionable, non-crashing result on timeout', async () => {
      const sandboxMock = mkSandbox({ exitCode: 124, stdout: 'partial', stderr: 'boom', timedOut: true });
      const res = await new ExecTool(sandboxMock).execute({ command: 'pnpm build' }, ctx);
      expect(res.success).toBe(false);
      const out = res.output as { timedOut?: boolean; stderr?: string };
      expect(out.timedOut).toBe(true);
      expect(out.stderr).toMatch(/timed out/i);
      expect(out.stderr).toMatch(/larger `?timeout`?/i);
    });
  });
});
