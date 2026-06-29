# Core Interfaces

This document defines the binding TypeScript interfaces for every adapter boundary in Ontofelia. All phases must use these interfaces. Extensions are allowed; breaking changes only with an ADR.

## Message Envelope

The central message format for all channels.

```typescript
interface MessageEnvelope {
  id: string;
  channel: ChannelType;
  accountId: string;
  chatType: ChatType;
  sender: SenderIdentity;
  target?: string;
  timestamp: string; // ISO 8601
  text: string;
  mentions: Mention[];
  attachments: Attachment[];
  replyTo?: string;
  raw?: unknown;
  routingHints?: RoutingHints;
  capabilities?: ChannelCapabilities;
}

type ChannelType =
  | "webchat"
  | "telegram"
  | "discord"
  | "slack"
  | "whatsapp"
  | "imessage"
  | "mattermost"
  | "signal"
  | "teams"
  | "matrix"
  | "line"
  | "googlechat"
  | "zalo"
  | "webhook"
  | "cron"
  | "cli";

type ChatType =
  | "dm"
  | "group"
  | "channel"
  | "thread"
  | "topic"
  | "web"
  | "cron"
  | "webhook";

interface SenderIdentity {
  id: string;
  channelPrefix: string; // e.g. "telegram", "discord"
  displayName?: string;
  isOwner: boolean;
}

interface Mention {
  id: string;
  type: "user" | "bot" | "role" | "channel";
  text: string;
}

interface Attachment {
  id: string;
  type: "image" | "audio" | "video" | "document" | "voice" | "file";
  mimeType: string;
  filename?: string;
  url?: string;
  localPath?: string;
  sizeBytes?: number;
}

interface RoutingHints {
  agentId?: string;
  sessionId?: string;
  skillName?: string;
  forceNewSession?: boolean;
}

interface ChannelCapabilities {
  supportsEdit: boolean;
  supportsReaction: boolean;
  supportsThread: boolean;
  supportsMedia: boolean;
  maxTextLength: number;
  maxMediaBytes: number;
}
```

## Channel Adapter

Interface for all messenger and communication channels.

```typescript
interface ChannelAdapter {
  readonly type: ChannelType;
  readonly status: ChannelStatus;

  initialize(config: ChannelConfig): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<HealthResult>;

  // Inbound: the channel invokes these callbacks
  onMessage(handler: (envelope: MessageEnvelope) => Promise<void>): void;

  // Outbound: the gateway sends via these methods
  sendText(target: string, text: string, options?: SendOptions): Promise<SendResult>;
  sendMedia(target: string, attachment: Attachment, caption?: string): Promise<SendResult>;
  sendReaction?(target: string, messageId: string, emoji: string): Promise<void>;
  editMessage?(target: string, messageId: string, newText: string): Promise<void>;

  // Capabilities
  getCapabilities(chatType: ChatType): ChannelCapabilities;
}

type ChannelStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "logged_out";

interface ChannelConfig {
  enabled: boolean;
  accounts: Record<string, unknown>;
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled";
  groupPolicy: "open" | "allowlist" | "disabled";
  allowFrom: string[];
  allowGroups: string[];
  mentionGating: boolean;
  mentionPatterns: string[];
  mediaMaxMb: number;
  textChunkLimit: number;
  lineChunkLimit: number;
  historyLimit: number;
  configWrites: boolean;
  debounceMs: number;
}

interface SendOptions {
  replyTo?: string;
  parseMode?: "text" | "markdown" | "html";
  chunkOnNewlines?: boolean;
}

interface SendResult {
  success: boolean;
  messageIds: string[];
  error?: string;
}
```

## Provider Adapter

Interface for LLM providers (OpenAI, Anthropic, Ollama, etc.).

```typescript
interface ProviderAdapter {
  readonly name: string; // e.g. "openai", "anthropic", "ollama"

  initialize(config: ProviderConfig): Promise<void>;
  healthCheck(): Promise<HealthResult>;

  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<StreamEvent>;

  listModels?(): Promise<ModelInfo[]>;
  getUsage?(): Promise<UsageInfo>;
}

interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  defaultModel: string;
  aliases: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
}

interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stop?: string[];
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
}

interface ChatResponse {
  id: string;
  content: string;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "error";
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

type StreamEvent =
  | { type: "text_delta"; content: string }
  | { type: "tool_call_start"; toolCall: ToolCall }
  | { type: "tool_call_delta"; toolCallId: string; content: string }
  | { type: "tool_call_end"; toolCallId: string }
  | { type: "done"; response: ChatResponse }
  | { type: "error"; error: string };

interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
  maxOutputTokens?: number;
}

interface UsageInfo {
  totalTokens: number;
  totalCost?: number;
  currency?: string;
  period: string;
}
```

## Triplestore Adapter

Interface for RDF triplestore backends (Fuseki, in-memory, Oxigraph).

```typescript
interface TriplestoreAdapter {
  readonly backend: "fuseki" | "oxigraph" | "memory";
  readonly status: "stopped" | "starting" | "running" | "error";

  initialize(config: TriplestoreConfig): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<HealthResult>;

  // SPARQL Operations
  query(sparql: string, namedGraph?: string): Promise<SparqlResult>;
  update(sparql: string): Promise<void>;

  // Graph Store Protocol
  getGraph(graphUri: string, format?: RdfFormat): Promise<string>;
  putGraph(graphUri: string, data: string, format?: RdfFormat): Promise<void>;
  deleteGraph(graphUri: string): Promise<void>;

  // Convenience
  insertTriples(graphUri: string, triples: Triple[]): Promise<void>;
  deleteTriples(graphUri: string, triples: Triple[]): Promise<void>;
  ask(sparql: string): Promise<boolean>;

  // Export/Import
  exportDataset(format: RdfFormat): Promise<string>;
  importDataset(data: string, format: RdfFormat): Promise<void>;

  // Backup
  backup(targetDir: string): Promise<string>;
  restore(backupPath: string): Promise<void>;
}

interface TriplestoreConfig {
  backend: "fuseki" | "oxigraph" | "memory";
  type: "sidecar" | "remote" | "embedded";
  dataDir: string;
  port: number;
  endpoint: string;
  fusekiBinaryPath?: string;
  fusekiConfigPath?: string;
  javaPath?: string;
  healthCheckIntervalMs?: number;
  restartOnCrash?: boolean;
  maxRestartAttempts?: number;
}

interface Triple {
  subject: string;
  predicate: string;
  object: string | { value: string; type?: string; language?: string };
}

interface SparqlResult {
  type: "bindings" | "boolean" | "graph";
  variables?: string[];
  bindings?: Record<string, RdfTerm>[];
  boolean?: boolean;
  graph?: string;
}

interface RdfTerm {
  type: "uri" | "literal" | "bnode";
  value: string;
  datatype?: string;
  language?: string;
}

type RdfFormat = "turtle" | "jsonld" | "ntriples" | "rdfxml" | "trig";
```

## Tool Definition

Interface for agent tools.

```typescript
interface ToolDefinition {
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

type ToolCategory =
  | "filesystem"
  | "shell"
  | "web"
  | "memory"
  | "ontology"
  | "media"
  | "channel"
  | "utility";

type ToolPermission =
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

interface ToolContext {
  agentId: string;
  sessionId: string;
  workspacePath: string;
  sandboxPath?: string;
  channelType: ChannelType;
  senderId: string;
  isOwner: boolean;
}

interface ToolResult {
  success: boolean;
  output: unknown;
  error?: string;
  artifacts?: ToolArtifact[];
  auditEntry: ToolAuditEntry;
}

interface ToolArtifact {
  type: "file" | "image" | "text" | "json";
  path?: string;
  content?: string;
  mimeType?: string;
}

interface ToolAuditEntry {
  toolName: string;
  timestamp: string;
  duration: number;
  input: unknown;
  output: unknown;
  success: boolean;
  error?: string;
  permissions: ToolPermission[];
}
```

## Agent Config

Configuration and runtime model of an agent.

```typescript
interface AgentConfig {
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

type AgentLifecycle =
  | "created"
  | "initializing"
  | "running"
  | "paused"
  | "stopped"
  | "degraded"
  | "error";

interface AgentState {
  agentId: string;
  lifecycle: AgentLifecycle;
  activeRuns: number;
  totalRuns: number;
  lastActivity?: string;
  error?: string;
}

interface MemoryPolicy {
  autoFlushBeforeCompaction: boolean;
  defaultConfidence: "high" | "medium" | "low";
  trustUntrustedContent: boolean;
}

interface SessionPolicy {
  scope: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
  idleResetMinutes?: number;
  dailyResetTime?: string; // "HH:mm"
  maxAgeDays?: number;
  maxTokens?: number;
}

interface ChannelBinding {
  enabled: boolean;
  agentId: string;
  skills?: string[];
  systemPromptAddition?: string;
}

interface SandboxConfig {
  scope: "agent" | "session" | "off";
  workspaceAccess: "none" | "ro" | "rw";
  pruneIdleHours?: number;
  pruneMaxAgeDays?: number;
}

interface HeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  prompt: string;
  silentToken: string; // e.g. "HEARTBEAT_OK"
  targetChannel?: string;
}
```

## Session Record

Data model for persistent sessions.

```typescript
interface SessionRecord {
  sessionId: string;
  agentId: string;
  scope: SessionPolicy["scope"];
  sessionKey: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  totalTokens: number;
  status: "active" | "idle" | "reset" | "archived";
  origin: SessionOrigin;
  displayName?: string;
  transcriptPath: string;
}

interface SessionOrigin {
  channel: ChannelType;
  chatType: ChatType;
  senderId: string;
  accountId?: string;
  groupId?: string;
}

// JSONL Transcript Entry
interface TranscriptEntry {
  timestamp: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  channel?: ChannelType;
  senderId?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  tokenCount?: number;
  metadata?: Record<string, unknown>;
}
```

## Skill Manifest

Definition of an Ontofelia skill.

```typescript
interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  commands?: SkillCommand[];
  tools?: string[];
  permissions?: ToolPermission[];
  config?: Record<string, unknown>; // JSON Schema for the skill config
  entryPoint?: string;
  tags?: string[];
}

interface SkillCommand {
  name: string;
  description: string;
  usage: string;
  aliases?: string[];
  nativeSlashCommand?: boolean;
}
```

## Plugin Manifest

Definition of an Ontofelia plugin.

```typescript
interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author?: string;
  type: PluginType[];
  permissions: PluginPermission[];
  entryPoint: string;
  config?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  trusted?: boolean;
}

type PluginType =
  | "command"
  | "tool"
  | "channel"
  | "skill"
  | "ui"
  | "hook";

type PluginPermission =
  | "commands:register"
  | "tools:register"
  | "channels:register"
  | "ui:extend"
  | "hooks:gateway"
  | "hooks:agent"
  | "config:read"
  | "config:write"
  | "fs:read"
  | "fs:write"
  | "net:http";
```

## Shared Types

Shared types used throughout.

```typescript
interface HealthResult {
  healthy: boolean;
  component: string;
  message?: string;
  details?: Record<string, unknown>;
  checkedAt: string;
}

interface ApiError {
  code: string;
  message: string;
  details?: unknown;
  requestId: string;
  docsUrl?: string;
}

type ErrorCode =
  | "CONFIG_ERROR"
  | "AUTH_ERROR"
  | "AUTH_TOKEN_MISSING"
  | "AUTH_TOKEN_INVALID"
  | "POLICY_DENIED"
  | "PROVIDER_ERROR"
  | "PROVIDER_UNAVAILABLE"
  | "CHANNEL_ERROR"
  | "CHANNEL_DISCONNECTED"
  | "TOOL_ERROR"
  | "TOOL_TIMEOUT"
  | "TOOL_DENIED"
  | "MEMORY_ERROR"
  | "MEMORY_INCONSISTENT"
  | "SANDBOX_ERROR"
  | "SESSION_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "AGENT_STOPPED"
  | "VALIDATION_ERROR"
  | "INTERNAL_ERROR";

interface PaginatedResponse<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
```
