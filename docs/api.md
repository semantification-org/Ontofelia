# API Reference

Ontofelia Gateway exposes an HTTP REST API and a WebSocket API. All `/api/*` endpoints (except `GET /api/health`) require a Bearer token. Inbound webhooks (`POST /webhooks/:path`) and signed media URLs (`/canvas/media/:id`) carry their own authentication.

## Authentication

Include the gateway token in every request:

```
Authorization: Bearer <token>
```

The token is generated during `ontofelia onboard` and stored in `~/.ontofelia/ontofelia.json5` (`gateway.token`). Retrieve it with `ontofelia auth token`.

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
  "channels": { "total": 1, "connected": 1 },
  "memory": { "backend": "oxigraph", "status": "running", "tripleCount": 855 }
}
```

#### `GET /api/health`

Public health check (no auth required).

```json
{ "status": "ok", "fuseki": null }
```

`fuseki` is `null` with the default embedded Oxigraph backend. When the optional Fuseki sidecar is active it holds the health-check result:

```json
{
  "status": "ok",
  "fuseki": { "healthy": true, "component": "Fuseki", "checkedAt": "2026-05-17T09:30:00.000Z", "details": { "responseTime": 12 } }
}
```

#### `GET /api/version`

```json
{ "version": "0.0.1", "build": "dev", "node": "v20.20.2", "platform": "linux" }
```

---

### Chat

#### `POST /api/chat`

Send a message to an agent and get the full response (non-streaming; use the WebSocket for streaming).

Request:

```json
{
  "message": "Hello, Ontofelia!",
  "agentId": "default",
  "sessionId": "optional-session-id"
}
```

`agentId`, `sessionId`, `channel` (default `"webchat"`) and `senderId` (default `"owner"`) are optional. `agentId` `"default"` (or omitted) resolves to the primary agent.

Response:

```json
{
  "text": "Hi! How can I help?",
  "sessionId": "uuid",
  "model": "openai/gpt-oss-120b:free",
  "provider": "openrouter",
  "usage": { "promptTokens": 150, "completionTokens": 30, "totalTokens": 180 }
}
```

`model`, `provider` and `usage` are optional; `fallbackModel` is present when the primary model returned empty and a fallback was used.

---

### Agents

#### `GET /api/agents`

List all configured agents with status.

```json
[
  {
    "agentId": "ontofelia",
    "lifecycle": "running",
    "activeRuns": 0,
    "totalRuns": 42,
    "lastActivity": "2026-05-17T09:30:00.000Z"
  }
]
```

#### `GET /api/agents/:id`

Same shape for a single agent (`default` resolves to the primary agent).

#### `GET /api/tools`

List registered tools: `[{ "name", "description", "category", "permissions" }, ...]`

---

### Sessions

#### `GET /api/sessions`

List all sessions. Query: `?agentId=default&channel=webchat`

#### `GET /api/sessions/:id`

Get session details.

#### `GET /api/sessions/:id/transcript`

Get the full chat transcript. Query: `?limit=50`

#### `PATCH /api/sessions/:id`

Update session (rename): `{ "displayName": "My Chat" }`

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

List available models from the provider (empty array if the provider does not support listing).

#### `POST /api/provider/test`

Send a test message: `{ "text": "Hello!" }` — returns the raw provider chat response.

#### `PUT /api/config/model`

Change the active model. Persisted to `ontofelia.json5`.

```json
{ "model": "google/gemma-4-26b-a4b-it:free" }
```

Response: `{ "success": true, "model": "..." }`

#### `PUT /api/config/fallback`

Enable/disable auto-fallback. Persisted to `ontofelia.json5`.

Request `{ "enabled": true }` → response `{ "autoFallback": true }`

#### `PUT /api/config/fallback-models`

Set the ordered list of fallback models. Persisted to `ontofelia.json5`.

Request `{ "models": ["deepseek/deepseek-chat-v3-0324:free"] }` → response `{ "fallbackModels": [...] }`

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

### Knowledge Graph

#### `GET /api/knowledge/graphs`

List all named graphs of the primary agent with their content.

```json
{
  "agentId": "ontofelia",
  "graphs": [
    {
      "uri": "urn:ontofelia:worldview",
      "role": "worldview",
      "agentId": "ontofelia",
      "shared": false,
      "turtle": "@prefix ...",
      "tripleCount": 42
    }
  ]
}
```

#### `DELETE /api/knowledge?confirm=true`

Clear the entire knowledge graph. Requires `confirm=true`, is rate-limited to once per hour, writes a Turtle backup to `~/.ontofelia/backups/` first, and re-seeds the core ontology. Response: `{ "deleted": true, "backupPath": "...", "timestamp": "..." }`

---

### Ontology & Reasoning

#### `GET /api/ontology/versions` / `GET /api/ontology/proposals`

List ontology versions / evolution proposals.

#### `POST /api/ontology/proposals/:id/approve` / `POST /api/ontology/proposals/:id/reject`

Approve or reject an ontology proposal.

#### `POST /api/ontology/rollback`

Roll back to a version: `{ "version": "v001" }`

#### `GET /api/reasoning/conflicts`

List detected knowledge conflicts for the primary agent.

#### `POST /api/reasoning/reflect`

Trigger a memory reflection run.

#### Cognitive architecture (observability)

`GET /api/cog/health` reports per-graph counts and cycle-latency stats. The read-only debug projections `GET /api/cog/inspect/cycles|cycle|goals|episodes|explain` (query params: `agentId`, `sessionId`, `cycleId`, `entity`, `limit` as applicable) return `403` until the debug panel is enabled with the in-chat command `/cog debug on`.

---

### Scheduler & Webhooks

#### `POST /api/cron-trigger`

Wake up the agent with a scheduled message. Used by cron jobs.

```json
{ "message": "Daily news summary task", "agentId": "ontofelia" }
```

Response: `{ "success": true, "response": "Agent's response text..." }`

#### `GET /api/cron`

Returns `{ "cronJobs": [...], "oneTimeJobs": [...] }`.

#### `POST /api/cron`

Add a job: `{ "name", "cron", "agentId", "prompt", "enabled" }`

#### `DELETE /api/cron/:id` / `POST /api/cron/:id/trigger`

Remove / manually trigger a job.

#### `GET /api/webhooks` / `POST /api/webhooks` / `DELETE /api/webhooks/:id`

Manage inbound webhook definitions (`{ "name", "path", "secret", "authMethod", "agentId", "prompt", "enabled", ... }`).

#### `POST /webhooks/:path`

Inbound webhook receiver (outside `/api/*`; authenticated per webhook via HMAC-SHA256 or Bearer secret, with payload-size and replay protection). The payload is handed to the configured agent as a prompt.

---

### Skills, Plugins, Sandboxes

#### `GET /api/skills`

List skills: `[{ "name", "description", "source" }, ...]`

#### `GET /api/plugins` / `POST /api/plugins/:name/activate` / `POST /api/plugins/:name/deactivate`

List, activate, deactivate plugins.

#### `GET /api/sandboxes` / `DELETE /api/sandboxes/:id` / `POST /api/sandboxes/prune`

Manage Docker sandboxes. Prune body: `{ "idleHours": 24, "maxAgeDays": 7 }`

---

### Media

#### `GET /api/media`

List media entries. Query: `?agentId=&sessionId=&mimeType=`

#### `POST /api/media/upload` (also `POST /canvas/upload`)

Multipart file upload. Response: `{ "id": "...", "url": "<signed URL>" }`

#### `DELETE /api/media/:id`

Delete a media entry.

#### `GET /canvas/media/:id` / `GET /canvas/media/:id/thumb` / `GET /canvas/media/:id/meta`

Fetch a media file, its thumbnail, or its metadata. File and thumbnail accept either a signed URL (`?expires=&sig=`) or a Bearer token.

---

### Devices

#### `GET /api/devices`

List paired nodes/devices.

#### `POST /api/devices/:code/approve` / `POST /api/devices/:code/reject`

Approve or reject a device pairing request (devices connect via `ws://.../ws/node`).

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

Failure to authenticate within 5 seconds closes the connection. (If `gateway.auth.allowQueryToken` is enabled in the config, `?token=` in the connection URL is also accepted.)

#### Chat Message

```json
{
  "type": "chat",
  "message": "Hello, Ontofelia!",
  "agentId": "default",
  "sessionId": "optional-session-id",
  "attachments": [{ "name": "photo.jpg", "type": "image/jpeg", "data": "..." }]
}
```

`attachments` is optional.

#### Ping

```json
{ "type": "ping" }
```

Answered with `{ "type": "pong" }`.

#### Guardian Response

Answer a pending tool-approval request (see `guardian_confirm` below):

```json
{ "type": "guardian_response", "callId": "...", "approved": true, "approveAll": false }
```

### Outbound Messages (Server → Client)

#### Streaming a chat turn

Each `chat` message produces a stream of events:

```json
{ "type": "stream_start", "sessionId": "uuid" }
```

```json
{ "type": "text_delta", "content": "Hello" }
```
Sent for each text chunk as the LLM generates tokens.

```json
{ "type": "tool_start", "name": "memory_store", "args": "{...}" }
{ "type": "tool_result", "name": "memory_store", "success": true, "output": "..." }
```
Sent when the agent invokes tools during the turn.

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

#### Guardian Confirm

When a tool call requires operator approval:

```json
{ "type": "guardian_confirm", "callId": "...", "command": "..." }
```

Reply with a `guardian_response` message.

#### Chat Error

```json
{
  "type": "chat_error",
  "message": "❌ LLM error: Rate limit exceeded",
  "originalProvider": "openrouter"
}
```

#### Chat Response (gateway-level fallback only)

If the streaming call throws and the gateway-level fallback succeeds, the reply arrives as a single non-streamed message:

```json
{ "type": "chat_response", "text": "...", "sessionId": "fallback", "fallbackModel": "...", "usage": { } }
```

#### Error

```json
{
  "type": "error",
  "code": "UNAUTHORIZED",
  "message": "Invalid token"
}
```

### Connection Lifecycle

1. Connect: `ws://127.0.0.1:18780/ws`
2. Send `{ "type": "auth", "token": "<token>" }`
3. Receive `{ "type": "status", "data": { "status": "authenticated" } }`
4. Send `chat` messages
5. Receive `debug_log` events (tool calls, LLM steps)
6. Receive the `stream_start` → `text_delta`/`tool_*` → `stream_end` sequence (or `chat_error`)
7. Handle reconnection on disconnect (the Web UI does this automatically)

### Auto-Fallback System

Ontofelia has a two-layer fallback system for LLM reliability:

**Layer 1 (Agent Runtime):** When the primary model returns an empty response (common with free OpenRouter models), the runtime retries with `provider.fallbackModels` from the config (or a built-in free-model list when none are configured), preserving the full conversation context. The client sees the used model in `stream_end.fallbackModel`.

**Layer 2 (Gateway):** When the LLM call throws an exception (network error, rate limit), the gateway sends `chat_error`, then retries the message against a built-in list of free OpenRouter models and, on success, delivers a single `chat_response`. If all models fail, a final `chat_error` is sent.

### Node WebSocket (`/ws/node`)

Devices pair and chat via `ws://127.0.0.1:18780/ws/node` using `pair_request`/`pair_response`/`pair_approved`, `chat_message`/`chat_response`, `file_upload`/`file_response`, and `health_request`/`health_response` messages. Pairing codes are approved with `ontofelia devices approve <code>` or `POST /api/devices/:code/approve`.

---

## Error Responses

API errors follow this format:

```json
{ "error": "Session not found" }
```

| Status | Meaning |
|--------|---------|
| 200 | Success |
| 400 | Bad request (invalid parameters) |
| 401 | Unauthorized (invalid/missing token) |
| 403 | Forbidden (e.g. cognitive debug panel disabled) |
| 404 | Resource not found |
| 409 | Replay detected (webhooks) |
| 413 | Payload too large (webhooks) |
| 429 | Rate limited (knowledge deletion) |
| 500 | Internal server error |
