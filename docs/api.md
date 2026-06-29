# API Reference

Ontofelia Gateway exposes an HTTP REST API and a WebSocket API. All endpoints (except `/api/health`) require a Bearer token.

## Authentication

Include the gateway token in every request:

```
Authorization: Bearer <token>
```

The token is generated during `ontofelia init` and stored in `~/.ontofelia/ontofelia.json5`.

## Base URL

```
http://127.0.0.1:18780
```

---

## REST API

### System

#### `GET /api/status`

Returns gateway status, uptime, and component health.

```json
{
  "running": true,
  "uptime": 3600.5,
  "version": "0.0.1",
  "bind": "loopback",
  "port": 18780,
  "agents": { "total": 1, "running": 1 },
  "channels": { "total": 2, "connected": 2 },
  "memory": { "backend": "oxigraph", "status": "running" }
}
```

#### `GET /api/health`

Public health check (no auth required).

```json
{
  "status": "ok",
  "memory": {
    "backend": "oxigraph",
    "healthy": true,
    "component": "Oxigraph",
    "checkedAt": "2026-05-17T09:30:00.000Z"
  }
}
```

When the optional Fuseki backend is active, `backend` reads `"fuseki"` and `component` `"Fuseki"`.

---

### Agents

#### `GET /api/agents`

List all configured agents with status.

```json
[
  {
    "agentId": "default",
    "lifecycle": "running",
    "activeRuns": 0,
    "totalRuns": 42,
    "lastActivity": "2026-05-17T09:30:00.000Z"
  }
]
```

---

### Sessions

#### `GET /api/sessions`

List all sessions. Query: `?agentId=default`

#### `GET /api/sessions/:id`

Get session details.

#### `GET /api/sessions/:id/transcript`

Get the full chat transcript. Query: `?limit=50`

#### `PATCH /api/sessions/:id`

Update session (e.g. rename): `{ "displayName": "My Chat" }`

#### `DELETE /api/sessions/:id`

Delete session and transcript.

---

### Provider

#### `GET /api/provider`

Current provider status.

```json
{
  "name": "openrouter",
  "model": "google/gemma-4-26b-a4b-it:free",
  "healthy": true,
  "autoFallback": true,
  "fallbackModels": ["deepseek/deepseek-chat-v3-0324:free", "google/gemma-4-31b-it:free"]
}
```

#### `GET /api/models`

List available models from the provider (alphabetically sorted).

#### `POST /api/provider/test`

Send a test message: `{ "text": "Hello!" }`

#### `PUT /api/config/model`

Change the active model. Persisted to `ontofelia.json5`.

```json
{ "model": "google/gemma-4-26b-a4b-it:free" }
```

#### `PUT /api/config/fallback`

Enable/disable auto-fallback. Persisted to `ontofelia.json5`.

```json
{ "enabled": true }
```

#### `PUT /api/config/fallback-models`

Set the ordered list of fallback models. Persisted to `ontofelia.json5`.

```json
{ "models": ["deepseek/deepseek-chat-v3-0324:free", "meta-llama/llama-3.3-70b-instruct:free"] }
```

---

### Channels

#### `GET /api/channels`

List all channel adapters and their status.

```json
[
  { "type": "webchat", "status": "connected" },
  { "type": "telegram", "status": "connected" }
]
```

---

### Pairing

#### `GET /api/pairing`

List pending pairing requests. Query: `?channel=telegram`

```json
[
  {
    "code": "ABC123",
    "channel": "telegram",
    "senderId": "123456789",
    "displayName": "Alice",
    "createdAt": "2026-05-17T09:30:00.000Z"
  }
]
```

#### `POST /api/pairing/approve`

Approve a pairing request: `{ "code": "ABC123" }`

#### `POST /api/pairing/reject`

Reject a pairing request: `{ "code": "ABC123" }`

---

### Allowlist

#### `GET /api/allowlist`

List approved users. Query: `?channel=telegram`

#### `POST /api/allowlist`

Add user directly: `{ "channel": "telegram", "senderId": "123", "displayName": "Name" }`

#### `DELETE /api/allowlist`

Remove user: `{ "channel": "telegram", "senderId": "123" }`

---

### Cron Trigger

#### `POST /api/cron-trigger`

Wake up the agent with a scheduled message. Used by cron jobs.

```json
{
  "message": "Daily news summary task",
  "agentId": "default"
}
```

Response:
```json
{
  "success": true,
  "response": "Agent's response text..."
}
```

---

### Settings

#### `GET /api/settings`

Get current UI settings (model, fallback, etc.)

#### `PATCH /api/settings`

Update settings: `{ "model": "google/gemma-3-27b-it:free" }`

---

## WebSocket API

Connect to `ws://127.0.0.1:18780/ws`

### Inbound Messages (Client → Server)

#### Authentication

The first message sent after connecting must be the auth token:

```json
{
  "type": "auth",
  "token": "your-gateway-token"
}
```

Failure to authenticate within 5 seconds will result in connection closure.

#### Chat Message

```json
{
  "type": "chat",
  "message": "Hello, Ontofelia!",
  "agentId": "default",
  "sessionId": "optional-session-id"
}
```

#### Ping

```json
{ "type": "ping" }
```

### Outbound Messages (Server → Client)

#### Chat Response

```json
{
  "type": "chat_response",
  "sessionId": "uuid",
  "text": "Hi! How can I help?",
  "model": "openai/gpt-oss-120b:free",
  "provider": "openrouter",
  "usage": { "promptTokens": 150, "completionTokens": 30, "totalTokens": 180 }
}
```

#### Chat Error

```json
{
  "type": "chat_error",
  "message": "❌ LLM-Fehler: Rate limit exceeded",
  "originalProvider": "openrouter"
}
```

#### Debug Log

```json
{
  "type": "debug_log",
  "timestamp": "2026-05-17T09:30:00.000Z",
  "phase": "tool_call",
  "label": "Tool: memory_store",
  "data": { "name": "memory_store", "args": "..." }
}
```

#### Error

```json
{
  "type": "error",
  "code": "UNAUTHORIZED",
  "message": "Invalid or missing token"
}
```

#### Session Created

```json
{
  "type": "session_created",
  "sessionId": "uuid",
  "agentId": "default"
}
```

### Connection Lifecycle

1. Connect: `ws://127.0.0.1:18780/ws`
2. Send `{ "type": "auth", "token": "<token>" }`
3. Receive `{ "type": "status", "data": { "status": "authenticated" } }`
4. Send `chat` messages
5. Receive `debug_log` events (tool calls, LLM steps)
6. Receive `chat_response` (final answer) or `chat_error`
7. Handle reconnection on disconnect (the Web UI does this automatically)

### Streaming Protocol

Ontofelia uses a streaming protocol for real-time token delivery:

#### `stream_start`
```json
{ "type": "stream_start", "sessionId": "uuid" }
```

#### `text_delta`
```json
{ "type": "text_delta", "content": "Hello" }
```
Sent for each text chunk as the LLM generates tokens.

#### `stream_end`
```json
{
  "type": "stream_end",
  "text": "Hello! How can I help?",
  "sessionId": "uuid",
  "model": "google/gemma-4-26b-a4b-it:free",
  "provider": "openrouter",
  "fallbackModel": "deepseek/deepseek-chat-v3-0324:free",
  "usage": { "promptTokens": 150, "completionTokens": 30, "totalTokens": 180 }
}
```
`fallbackModel` is only present when a fallback was used successfully.

### Auto-Fallback System

Ontofelia has a two-layer fallback system for LLM reliability:

**Layer 1 (Agent Runtime):** When the primary model returns an empty response (common with free OpenRouter models), the system automatically retries with user-configured fallback models. The full conversation context is preserved.

**Layer 2 (Gateway):** When the LLM call throws an exception (network error, rate limit), the gateway catches it and retries with fallback models.

Fallback order:
1. Primary model (from settings)
2. Fallback A (user-configured in Settings UI)
3. Fallback B (user-configured in Settings UI)
4. Default fallback list (DeepSeek, Gemma, Llama)

The client receives the fallback model info in the `stream_end` event. If all models fail, an error message listing all tried models is shown.

```json
{ "type": "stream_end", "model": "primary (+ 2 Fallbacks)" }
```

---

## Error Responses

All API errors follow this format:

```json
{
  "error": "Session not found",
  "statusCode": 404
}
```

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 400 | Bad request (invalid parameters) |
| 401 | Unauthorized (invalid/missing token) |
| 404 | Resource not found |
| 429 | Rate limited |
| 500 | Internal server error |
