import { ChannelType } from './message.js';

export interface AgentConfig {
  agentId: string;
  name: string;
  displayName?: string;
  model: string; // "provider/model"
  workspace: string;
  systemPrompt: string;
  persona?: string;
  memoryPolicy: MemoryPolicy;
  sessionPolicy: SessionPolicy;
  enabledTools: string[];
  enabledSkills: string[];
  channelBindings: Record<ChannelType, ChannelBinding>;
  sandbox: SandboxConfig;
  mediaMaxMb: number;
  heartbeat?: HeartbeatConfig;
  owner: string;
}

export type AgentLifecycle =
  | "created"
  | "initializing"
  | "running"
  | "paused"
  | "stopped"
  | "degraded"
  | "error";

export interface AgentState {
  agentId: string;
  lifecycle: AgentLifecycle;
  activeRuns: number;
  totalRuns: number;
  lastActivity?: string;
  error?: string;
}

export interface MemoryPolicy {
  autoFlushBeforeCompaction: boolean;
  defaultConfidence: "high" | "medium" | "low";
  trustUntrustedContent: boolean;
}

export interface SessionPolicy {
  scope: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  idleResetMinutes?: number;
  dailyResetTime?: string; // "HH:mm"
  maxAgeDays?: number;
  maxTokens?: number;
}

export interface ChannelBinding {
  enabled: boolean;
  agentId: string;
  skills?: string[];
  systemPromptAddition?: string;
}

export interface SandboxConfig {
  scope: "agent" | "session" | "off";
  workspaceAccess: "none" | "ro" | "rw";
  pruneIdleHours?: number;
  pruneMaxAgeDays?: number;
}

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  prompt: string;
  silentToken: string; // z.B. "HEARTBEAT_OK"
  targetChannel?: string;
}
