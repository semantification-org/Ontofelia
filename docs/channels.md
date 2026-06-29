# Channels

Ontofelia supports multiple communication channels through a unified adapter interface. Every channel normalizes messages into a common `MessageEnvelope` format before they reach the agent.

## Supported Channels

| Channel | Status | Auth Model | Features |
|---------|--------|------------|----------|
| WebChat | ✅ Built-in | Gateway token | Real-time WS, sessions, debug panel |
| Telegram | ✅ Active | Bot token + pairing | Inline keyboards, /model buttons, context line |
| Discord | ✅ Adapter | Bot token + pairing | Mention gating, DM support |
| System | ✅ Built-in | Internal | Cron wakeups, internal triggers |
| Webhook | ✅ Adapter | HMAC signature | GitHub, CI/CD events |
| Cron | ✅ Built-in | Internal | Scheduled agent wakeups |
| Slack | 📋 Planned | Bot token | — |
| WhatsApp | 📋 Planned | Business API | — |
| Matrix | 📋 Planned | Access token | — |

## WebChat

The built-in WebChat is served at `http://127.0.0.1:18780` and connects via WebSocket.

### Features
- Real-time messaging via WebSocket with **token-by-token streaming**
- Session management (create, rename, delete)
- **Ontofelia owl avatar** next to every assistant message and typing indicator
- Model/provider display per message (e.g. "14:05 · openrouter: google/gemma-4-26b-a4b-it:free")
- **Fallback model indicator** — shows which model actually responded
- Auto-reconnect on disconnect
- LLM auto-fallback with detailed error display (lists all tried models)
- **Settings panel**: model selection (alphabetically sorted), auto-fallback toggle, Fallback A/B dropdowns
- **Intelligent onboarding** — guides the user through profile completion on first use
- Input field stays focused after sending

## Telegram

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Run the interactive wizard:

```bash
ontofelia channel
```

Or configure manually in `ontofelia.json5`:

```json5
channels: {
  telegram: {
    enabled: true,
    accounts: {
      default: {
        token: "1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ"
      }
    },
    dmPolicy: "pairing"
  }
}
```

### Telegram-Specific Features

#### Context Line
Every Telegram response starts with a context usage line:
```
📚 Context: 2.1k/0.1M (1.6%) (openrouter: openai/gpt-oss-120b:free)

Hi! How can I help you?
```

Shows: used tokens / max context (percentage), and the provider:model.

#### Inline Keyboards
The `/model` command shows clickable buttons for model selection:
```
🧠 Current model: openai/gpt-oss-120b:free
📡 Provider: openrouter

[deepseek-chat-v3 🆓] [llama-3.1-70b 🆓]
[gemma-3-27b 🆓]      [qwen3-235b 🆓]
[gpt-4o 💰]            [claude-sonnet-4 💰]
```

Pressing a button immediately switches the model.

#### Markdown Fallback
If the LLM response contains invalid Markdown that Telegram can't parse, the message is automatically re-sent as plain text (no crash).

### Pairing

With `dmPolicy: "pairing"`, new users must be approved:

1. User sends any message to the bot
2. Bot responds: "Please send /pair to start a pairing request"
3. User sends `/pair`
4. A pairing code is generated
5. Admin approves: `ontofelia pairing approve <code>`
6. User can now chat with the agent

### DM Policies

| Policy | Behavior |
|--------|----------|
| `pairing` | New users need explicit approval (recommended) |
| `allowlist` | Only users in the allowlist can chat |
| `open` | Anyone can chat (not recommended for production) |
| `disabled` | No DMs accepted |

## Discord

### Setup

1. Create a bot at [discord.com/developers](https://discord.com/developers/applications)
2. Enable "Message Content Intent" in bot settings
3. Invite to your server with appropriate permissions
4. Configure via `ontofelia channel` wizard or manually:

```json5
channels: {
  discord: {
    enabled: true,
    accounts: {
      default: {
        token: "your-bot-token"
      }
    },
    dmPolicy: "pairing",
    mentionGating: true,
    mentionPatterns: ["@Ontofelia"]
  }
}
```

### Mention Gating

When `mentionGating` is enabled, the bot only responds in group channels when mentioned. This prevents it from responding to every message in a busy server.

## System Channel

Internal channel type for automated triggers:
- **Cron wakeups**: `POST /api/cron-trigger` creates a system message
- **Internal events**: Plugins and scheduled tasks can send messages through this channel
- Messages from this channel have `isOwner: true`

## Channel Adapter Interface

All channels implement the `ChannelAdapter` interface:

```typescript
interface ChannelAdapter {
  readonly type: ChannelType;
  readonly status: ChannelStatus;

  initialize(config: ChannelConfig): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<HealthResult>;

  onMessage(handler: (envelope: MessageEnvelope) => Promise<void>): void;
  sendText(target: string, text: string, options?: SendOptions): Promise<SendResult>;
  sendMedia(target: string, attachment: Attachment, caption?: string): Promise<SendResult>;

  getCapabilities(chatType: ChatType): ChannelCapabilities;
}
```

### Available Channel Types

```typescript
type ChannelType =
  | "webchat" | "telegram" | "discord" | "slack"
  | "whatsapp" | "imessage" | "mattermost" | "signal"
  | "teams" | "matrix" | "line" | "googlechat"
  | "zalo" | "webhook" | "cron" | "system" | "cli";
```

## Message Flow

```
User Message
    │
    ▼
┌──────────┐     ┌───────────────┐     ┌──────────┐
│ Channel  │────▶│ Message       │────▶│ Agent    │
│ Adapter  │     │ Envelope      │     │ Runtime  │
│          │◀────│ (normalized)  │◀────│          │
└──────────┘     └───────────────┘     └──────────┘
    │                                       │
    ▼                                       ▼
Reply sent                           Tool calls,
to same                              Memory queries,
channel                              LLM interaction
```

Every response is routed back to the **same channel and sender** that initiated the conversation.
