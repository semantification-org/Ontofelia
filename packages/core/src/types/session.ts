import { ChannelType, ChatType } from './message.js';
import { SessionPolicy } from './agent.js';
import { ToolCall, ToolResult } from './tool.js';

export interface SessionRecord {
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

export interface SessionOrigin {
  channel: ChannelType;
  chatType: ChatType;
  senderId: string;
  accountId?: string;
  groupId?: string;
}

// JSONL Transcript Entry
export interface TranscriptEntry {
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
