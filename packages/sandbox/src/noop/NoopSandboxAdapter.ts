import { SandboxAdapter, SandboxInstance, ExecOptions, ExecResult, SandboxConfig } from '../SandboxAdapter.js';
import { HealthResult } from '@ontofelia/core';
import { spawn } from 'child_process';
import * as crypto from 'crypto';

// Cap captured output so a chatty long-runner (e.g. a build) can't exhaust
// memory. execFile's default was 1 MB (and threw ERR_CHILD_PROCESS_STDIO_MAXBUFFER);
// we keep the last-known behaviour of a bounded buffer but larger and non-fatal.
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
// Grace between SIGTERM and SIGKILL when tearing down a timed-out/aborted tree.
const KILL_GRACE_MS = 3000;
// Exit code reported for a timed-out/aborted command (matches the common
// timeout(1) convention).
const TIMEOUT_EXIT_CODE = 124;

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

    return await new Promise<ExecResult>((resolve) => {
      // `detached: true` puts the child in its OWN process group (pgid = pid),
      // so on timeout/abort we can signal the WHOLE tree — sh AND its
      // descendants (pnpm → node → cargo …). execFile only ever signalled the
      // direct /bin/sh, leaving grandchildren running detached (orphans that
      // stacked up across the agent's retries).
      const child = spawn('/bin/sh', ['-c', command], {
        cwd,
        env: { ...process.env, ...options?.env },
        detached: true,
      });

      let stdout = '';
      let stderr = '';
      let outBytes = 0;
      let errBytes = 0;
      const append = (chunk: Buffer, which: 'out' | 'err') => {
        if (which === 'out') {
          if (outBytes >= MAX_OUTPUT_BYTES) return;
          outBytes += chunk.length;
          stdout += chunk.toString();
          if (outBytes >= MAX_OUTPUT_BYTES) stdout += '\n…[output truncated]';
        } else {
          if (errBytes >= MAX_OUTPUT_BYTES) return;
          errBytes += chunk.length;
          stderr += chunk.toString();
          if (errBytes >= MAX_OUTPUT_BYTES) stderr += '\n…[output truncated]';
        }
      };
      child.stdout?.on('data', (d: Buffer) => append(d, 'out'));
      child.stderr?.on('data', (d: Buffer) => append(d, 'err'));

      let timedOut = false;
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;

      const killTree = (signal: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          // Negative pid → signal the whole process group.
          process.kill(-child.pid, signal);
        } catch {
          // Group already gone, or (no pgid) fall back to the direct child.
          try { child.kill(signal); } catch { /* already dead */ }
        }
      };

      const teardown = () => {
        if (timedOut) return; // idempotent: a second trigger must not re-arm SIGKILL
        timedOut = true;
        clearTimeout(timer); // the deadline is moot once we're tearing down
        killTree('SIGTERM');
        // Escalate if the tree ignores SIGTERM.
        killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
      };

      const timer = setTimeout(teardown, timeoutMs);

      const onAbort = () => teardown();
      const signal = options?.signal;
      if (signal) {
        if (signal.aborted) teardown();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      const finish = (result: ExecResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve(result);
      };

      child.on('error', (err: Error) => {
        finish({
          exitCode: 127,
          stdout,
          stderr: stderr || err.message,
          durationMs: Date.now() - startTime,
          timedOut: false,
        });
      });

      child.on('close', (code: number | null, sig: NodeJS.Signals | null) => {
        const exitCode = timedOut
          ? TIMEOUT_EXIT_CODE
          : code !== null
            ? code
            : sig
              ? 128 // terminated by a signal we didn't initiate
              : 1;
        finish({
          exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - startTime,
          timedOut,
        });
      });
    });
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
