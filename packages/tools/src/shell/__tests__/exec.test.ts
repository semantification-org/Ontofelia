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
});
