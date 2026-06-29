import { SandboxAdapter, SandboxInstance, ExecOptions, ExecResult, SandboxConfig } from '../SandboxAdapter.js';
import { HealthResult } from '@ontofelia/core';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as crypto from 'crypto';

const execFileAsync = promisify(execFile);

export class DockerSandboxAdapter implements SandboxAdapter {
  readonly backend = 'docker';
  private instances = new Map<string, SandboxInstance>();

  constructor(private imageName: string = 'ontofelia-sandbox') {}

  async healthCheck(): Promise<HealthResult> {
    try {
      await execFileAsync('docker', ['info']);
      return {
        healthy: true,
        component: 'sandbox',
        checkedAt: new Date().toISOString()
      };
    } catch (e: unknown) {
      return {
        healthy: false,
        component: 'sandbox',
        message: `Docker is not available: ${(e as Error).message}`,
        checkedAt: new Date().toISOString()
      };
    }
  }

  async getOrCreate(agentId: string, sessionId: string, config: SandboxConfig, workspaceHostPath: string): Promise<SandboxInstance> {
    const key = config.scope === 'agent' ? agentId : `${agentId}:${sessionId}`;
    let instance = this.instances.get(key);

    if (instance && instance.status === 'running') {
      try {
        await execFileAsync('docker', ['inspect', instance.containerId!]);
        instance.lastActivity = new Date().toISOString();
        return instance;
      } catch {
        // Container doesn't exist anymore or stopped
        this.instances.delete(key);
      }
    }

    const containerName = `ontofelia-sandbox-${agentId}-${sessionId}-${crypto.randomBytes(4).toString('hex')}`;

    instance = {
      id: key,
      agentId,
      sessionId: config.scope === 'session' ? sessionId : undefined,
      scope: config.scope as 'agent' | 'session',
      workspaceAccess: config.workspaceAccess,
      status: 'creating',
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    };

    this.instances.set(key, instance);

    try {
      const args = [
        'run', '-d',
        '--name', containerName,
        '--network', 'none',
        '--memory', '512m',
        '--cpus', '1',
        '--user', 'sandbox'
      ];

      if (config.workspaceAccess === 'ro') {
        args.push('-v', `${workspaceHostPath}:/workspace:ro`);
      } else if (config.workspaceAccess === 'rw') {
        args.push('-v', `${workspaceHostPath}:/workspace:rw`);
      }

      args.push(this.imageName);

      const { stdout } = await execFileAsync('docker', args);
      instance.containerId = stdout.trim();
      instance.status = 'running';
      return instance;
    } catch (e: unknown) {
      instance.status = 'error';
      throw new Error(`Failed to create sandbox: ${(e as Error).message}`, { cause: e });
    }
  }

  async exec(instance: SandboxInstance, command: string, options?: ExecOptions): Promise<ExecResult> {
    if (!instance.containerId || instance.status !== 'running') {
      throw new Error(`Sandbox ${instance.id} is not running.`);
    }
    
    instance.lastActivity = new Date().toISOString();

    const timeoutMs = options?.timeoutMs || 30000;
    const cwd = options?.cwd || '/workspace';
    const user = options?.user || 'sandbox';

    const args = [
      'exec',
      '-u', user,
      '-w', cwd,
    ];

    if (options?.env) {
      for (const [k, v] of Object.entries(options.env)) {
        args.push('-e', `${k}=${v}`);
      }
    }

    args.push(instance.containerId, '/bin/sh', '-c', command);

    const startTime = Date.now();
    try {
      const { stdout, stderr } = await execFileAsync('docker', args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 10 });
      return {
        exitCode: 0,
        stdout: stdout,
        stderr: stderr,
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

  async copyTo(instance: SandboxInstance, hostPath: string, containerPath: string): Promise<void> {
    if (!instance.containerId || instance.status !== 'running') {
      throw new Error(`Sandbox ${instance.id} is not running.`);
    }
    instance.lastActivity = new Date().toISOString();
    await execFileAsync('docker', ['cp', hostPath, `${instance.containerId}:${containerPath}`]);
  }

  async copyFrom(instance: SandboxInstance, containerPath: string, hostPath: string): Promise<void> {
    if (!instance.containerId || instance.status !== 'running') {
      throw new Error(`Sandbox ${instance.id} is not running.`);
    }
    instance.lastActivity = new Date().toISOString();
    await execFileAsync('docker', ['cp', `${instance.containerId}:${containerPath}`, hostPath]);
  }

  async destroy(instanceId: string): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance) return;

    if (instance.containerId) {
      try {
        await execFileAsync('docker', ['rm', '-f', instance.containerId]);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (_e) {
        // Ignore errors if container already removed
      }
    }
    this.instances.delete(instanceId);
  }

  list(): SandboxInstance[] {
    return Array.from(this.instances.values());
  }

  async prune(config: { idleHours?: number; maxAgeDays?: number }): Promise<number> {
    const now = Date.now();
    let removed = 0;

    for (const [id, instance] of this.instances.entries()) {
      const idleTime = now - new Date(instance.lastActivity).getTime();
      const age = now - new Date(instance.createdAt).getTime();

      let shouldRemove = false;
      if (config.idleHours && idleTime > config.idleHours * 3600000) {
        shouldRemove = true;
      }
      if (config.maxAgeDays && age > config.maxAgeDays * 86400000) {
        shouldRemove = true;
      }

      if (shouldRemove) {
        await this.destroy(id);
        removed++;
      }
    }
    return removed;
  }
}
