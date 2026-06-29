import { SandboxAdapter, SandboxInstance, ExecOptions, ExecResult, SandboxConfig } from '../SandboxAdapter.js';
import { HealthResult } from '@ontofelia/core';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';

const execFileAsync = promisify(execFile);

export class NoopSandboxAdapter implements SandboxAdapter {
  readonly backend = 'none';
  private instances = new Map<string, SandboxInstance>();

  async healthCheck(): Promise<HealthResult> {
    return {
      healthy: true,
      component: 'sandbox',
      message: 'No-op sandbox adapter running',
      checkedAt: new Date().toISOString()
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async getOrCreate(agentId: string, sessionId: string, config: SandboxConfig, _workspaceHostPath: string): Promise<SandboxInstance> {
    const key = config.scope === 'agent' ? agentId : `${agentId}:${sessionId}`;
    let instance = this.instances.get(key);

    if (!instance) {
      instance = {
        id: key,
        containerId: `noop-${crypto.randomBytes(4).toString('hex')}`,
        agentId,
        sessionId: config.scope === 'session' ? sessionId : undefined,
        scope: config.scope as 'agent' | 'session',
        workspaceAccess: config.workspaceAccess,
        status: 'running',
        createdAt: new Date().toISOString(),
        lastActivity: new Date().toISOString()
      };
      this.instances.set(key, instance);
    }
    
    instance.lastActivity = new Date().toISOString();
    return instance;
  }

  async exec(instance: SandboxInstance, command: string, options?: ExecOptions): Promise<ExecResult> {
    instance.lastActivity = new Date().toISOString();
    const timeoutMs = options?.timeoutMs || 30000;
    const cwd = options?.cwd || process.cwd();
    
    const startTime = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync('/bin/sh', ['-c', command], { 
        timeout: timeoutMs, 
        cwd,
        env: { ...process.env, ...options?.env }
      });
      
      return {
        exitCode: 0,
        stdout,
        stderr,
        durationMs: Date.now() - startTime,
        timedOut: false
      };
    } catch (e: unknown) {
      const err = e as { code?: number | string, stdout?: string, stderr?: string, killed?: boolean, message: string };
      return {
        exitCode: typeof err.code === 'number' ? err.code : 1,
        stdout: err.stdout || '',
        stderr: err.stderr || err.message,
        durationMs: Date.now() - startTime,
        timedOut: err.killed || false
      };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async copyTo(instance: SandboxInstance, _hostPath: string, _containerPath: string): Promise<void> {
    instance.lastActivity = new Date().toISOString();
    // no-op
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async copyFrom(instance: SandboxInstance, _containerPath: string, _hostPath: string): Promise<void> {
    instance.lastActivity = new Date().toISOString();
    // no-op
  }

  async destroy(instanceId: string): Promise<void> {
    this.instances.delete(instanceId);
  }

  list(): SandboxInstance[] {
    return Array.from(this.instances.values());
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async prune(_config: { idleHours?: number; maxAgeDays?: number }): Promise<number> {
    let removed = 0;
    for (const id of this.instances.keys()) {
      this.instances.delete(id);
      removed++;
    }
    return removed;
  }
}
