export interface MessageEnvelope {
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

export type ChannelType =
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
  | "system"
  | "cli";

export type ChatType =
  | "dm"
  | "group"
  | "channel"
  | "thread"
  | "topic"
  | "web"
  | "cron"
  | "webhook";

export interface SenderIdentity {
  id: string;
  channelPrefix: string; // z.B. "telegram", "discord"
  displayName?: string;
  isOwner: boolean;
}

export interface Mention {
  id: string;
  type: "user" | "bot" | "role" | "channel";
  text: string;
}

export interface Attachment {
  id: string;
  type: "image" | "audio" | "video" | "document" | "voice" | "file";
  mimeType: string;
  filename?: string;
  url?: string;
  localPath?: string;
  sizeBytes?: number;
}

export interface RoutingHints {
  agentId?: string;
  sessionId?: string;
  skillName?: string;
  forceNewSession?: boolean;
}

export interface ChannelCapabilities {
  supportsEdit: boolean;
  supportsReaction: boolean;
  supportsThread: boolean;
  supportsMedia: boolean;
  maxTextLength: number;
  maxMediaBytes: number;
}
