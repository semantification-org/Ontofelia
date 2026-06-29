import { ChannelType, ChatType, MessageEnvelope, Attachment, ChannelCapabilities } from './message.js';
import { HealthResult } from './common.js';

export interface ChannelAdapter {
  readonly type: ChannelType;
  readonly status: ChannelStatus;

  initialize(config: ChannelConfig): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<HealthResult>;

  // Inbound: Channel ruft diese Callbacks auf
  onMessage(handler: (envelope: MessageEnvelope) => Promise<void>): void;

  // Outbound: gateway sends through these methods
  sendText(target: string, text: string, options?: SendOptions): Promise<SendResult>;
  sendMedia(target: string, attachment: Attachment, caption?: string): Promise<SendResult>;
  sendReaction?(target: string, messageId: string, emoji: string): Promise<void>;
  editMessage?(target: string, messageId: string, newText: string): Promise<void>;

  // Capabilities
  getCapabilities(chatType: ChatType): ChannelCapabilities;
}

export type ChannelStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "logged_out";

export interface ChannelConfig {
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

export interface SendOptions {
  replyTo?: string;
  parseMode?: "text" | "markdown" | "html";
  chunkOnNewlines?: boolean;
}

export interface SendResult {
  success: boolean;
  messageIds: string[];
  error?: string;
}
