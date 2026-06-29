import { HealthResult } from '@ontofelia/core';

export interface SandboxConfig {
  scope: 'agent' | 'session' | 'off';
  workspaceAccess: 'none' | 'ro' | 'rw';
  pruneIdleHours?: number;
  pruneMaxAgeDays?: number;
}

export interface SandboxInstance {
  id: string;
  containerId?: string;
  agentId: string;
  sessionId?: string;
  scope: 'agent' | 'session';
  workspaceAccess: 'none' | 'ro' | 'rw';
  status: 'creating' | 'running' | 'stopped' | 'error';
  createdAt: string;
  lastActivity: string;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  user?: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface SandboxAdapter {
  readonly backend: 'docker' | 'none';

  healthCheck(): Promise<HealthResult>;

  getOrCreate(agentId: string, sessionId: string, config: SandboxConfig, workspaceHostPath: string): Promise<SandboxInstance>;

  exec(instance: SandboxInstance, command: string, options?: ExecOptions): Promise<ExecResult>;

  copyTo(instance: SandboxInstance, hostPath: string, containerPath: string): Promise<void>;

  copyFrom(instance: SandboxInstance, containerPath: string, hostPath: string): Promise<void>;

  destroy(instanceId: string): Promise<void>;

  list(): SandboxInstance[];

  prune(config: { idleHours?: number; maxAgeDays?: number }): Promise<number>;
}
