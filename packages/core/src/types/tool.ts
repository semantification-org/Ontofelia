import { ChannelType } from './message.js';

export interface ToolDefinition {
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: Record<string, unknown>; // JSON Schema
  outputSchema?: Record<string, unknown>;
  permissions: ToolPermission[];
  channelAvailability?: ChannelType[];
  sandboxOnly?: boolean;
  hostOnly?: boolean;
  timeoutMs?: number;
  retryable?: boolean;

  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

export type ToolCategory =
  | "filesystem"
  | "shell"
  | "web"
  | "memory"
  | "ontology"
  | "media"
  | "channel"
  | "utility";

export type ToolPermission =
  | "fs:read"
  | "fs:write"
  | "shell:exec"
  | "net:http"
  | "net:websocket"
  | "memory:read"
  | "memory:write"
  | "memory:delete"
  | "ontology:read"
  | "ontology:write"
  | "media:read"
  | "media:write"
  | "channel:action";

export interface ToolContext {
  agentId: string;
  sessionId: string;
  workspacePath: string;
  sandboxPath?: string;
  channelType: ChannelType;
  senderId: string;
  isOwner: boolean;
  sandboxConfig?: {
    scope: 'agent' | 'session' | 'off';
    workspaceAccess: 'none' | 'ro' | 'rw';
    pruneIdleHours?: number;
    pruneMaxAgeDays?: number;
  };
  /**
   * True when this tool runs inside an unattended initiative cycle
   * (docs/initiative-architecture.md §5–§6, §8). Set by the runtime from
   * `chatType === 'initiative'`; it is the SINGLE, authoritative signal for
   * "nobody is watching". The execution chokepoint (ToolExecutor) uses it to
   * hard-deny any tool outside the initiative allowlist, so an LLM that NAMES an
   * unadvertised tool cannot run it unattended. Tools (e.g. notify_owner) also
   * read it to distinguish initiative from conversational callers, rather than
   * inferring it from `channelType === 'system'` (which the cron path also uses).
   */
  unattended?: boolean;
  /**
   * IRI of the `message-received` episode recorded for the inbound message that
   * started THIS turn, when the runtime has recorded one (only on the cycle
   * manager path of a conversational turn). It is the only value a goal mandate
   * may point to (docs/initiative-architecture.md §5.1); absent means no
   * mandate can be given this turn.
   */
  inboundEpisodeUri?: string;
  /**
   * True only when the verified owner is present in a live, human-facing turn
   * (`isHumanOwnerTurn`). Synthetic owner senders (scheduler, cron trigger,
   * webhook, initiative) leave it false even though `isOwner` is true. Owner-
   * gated goal tools (`arm_goal`, `update_goal_step`) require it; other tools
   * keep reading `isOwner` / `unattended`.
   */
  ownerPresent?: boolean;
  /**
   * IRI of the goal an unattended initiative cycle was woken for
   * (`routingHints.initiativeGoalId`). Set only when `unattended` is true; the
   * `update_goal_step` tool restricts such a cycle to this one goal.
   */
  initiativeGoalUri?: string;
  /**
   * Cancellation signal wired to the executor's per-call timeout. When a tool
   * exceeds its `timeoutMs`, the executor aborts this signal so long-running
   * work (child processes, network requests) can actually stop instead of
   * leaking past the `Promise.race` that already rejected the caller.
   *
   * Honoring the signal is best-effort per tool: cancellation-aware tools
   * (`exec`, `web_fetch`) observe it; others may ignore it.
   */
  signal?: AbortSignal;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

/**
 * Why a tool call did not run, as decided by the dispatch chokepoint:
 * `policy-denied` (tool policy, self-protection, initiative gate or sandbox
 * requirement refused it), `guardian-approval-required` (the call needed an
 * owner approval that was not granted) or `error` (any other failure, e.g. the
 * tool threw, timed out or does not exist).
 */
export type ToolDenialClass = 'policy-denied' | 'guardian-approval-required' | 'error';

export interface ToolResult {
  success: boolean;
  /** Set on a failed result; absent on success. */
  denialClass?: ToolDenialClass;
  output: unknown;
  error?: string;
  artifacts?: ToolArtifact[];
  auditEntry: ToolAuditEntry;
}

export interface ToolArtifact {
  type: "file" | "image" | "text" | "json";
  path?: string;
  content?: string;
  mimeType?: string;
}

export interface ToolAuditEntry {
  toolName: string;
  timestamp: string;
  duration: number;
  input: unknown;
  output: unknown;
  success: boolean;
  error?: string;
  permissions: ToolPermission[];
  agentId?: string;
  sessionId?: string;
  channelType?: string;
  senderId?: string;
  isOwner?: boolean;
  policyDecision?: 'ALLOW' | 'DENY' | 'REQUIRES_APPROVAL' | 'MOCKED';
  sandboxBackend?: string;
}
