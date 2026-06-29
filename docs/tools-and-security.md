# Tools & Security

Ontofelia provides a powerful tool system that lets the AI agent interact with the outside world — running commands, reading files, fetching web pages, storing knowledge, and scheduling tasks. A policy engine ensures every tool invocation is authorized and audited.

## Built-in Tools

### Memory Tools

| Tool | Description | Example |
|------|-------------|---------|
| `memory_store` | Store a typed fact as real RDF triples | "Remember: I work at Google" → creates `Person`, `Organization`, `worksAt` triple |
| `memory_query` | SPARQL query against the knowledge graph | Raw SPARQL for power users |
| `memory_ask` | Template-based memory query | "What do you know about me?" |
| `memory_explain` | Provenance metadata for an entity | "When/where did you learn about me?" |
| `memory_retract` | Remove triples from the ABox | "Forget that I work at Google" |
| `memory_reflect` | Introspect recent triples and inferences | "What have you learned recently?" |

### Ontology Tools

| Tool | Description | Example |
|------|-------------|---------|
| `ontology_inspect` | View classes and properties in the TBox | "What types of things do you track?" |
| `ontology_propose` | Propose ontology changes as Turtle patches | "Add an Employee class" |

### Utility Tools

| Tool | Description | Example |
|------|-------------|---------|
| `datetime` | Current date, time, timezone | "What time is it in Tokyo?" |
| `calculator` | Arithmetic expressions | "What is 15% of 847?" |
| `self_inspect` | Read own config, system info, architecture | "What LLM are you using?" |

### Host Tools (Full Autonomy)

| Tool | Description | Capability |
|------|-------------|------------|
| `exec` | Execute shell commands on the host | Full terminal access, can install software |
| `fs_read` | Read files from the filesystem | Any readable file |
| `fs_write` | Write files to the filesystem | Create/modify files |
| `fs_list` | List directory contents | Browse filesystem |
| `web_fetch` | Fetch web pages as text | HTTP GET, HTML→text extraction |
| `cron_manage` | Manage cron jobs for self-wakeups | Schedule recurring tasks |

> **Note:** With `sandbox.scope: "off"`, host-only tools such as `exec`, `fs_write`, and `cron_manage` are not available unless explicitly listed in `tools.allow`. For production, enable Docker isolation with `sandbox.scope: "session"` or `"agent"` and keep dangerous tools off the allowlist unless they are operationally required.

## Self-Inspect Tool

The `self_inspect` tool gives Ontofelia deep self-knowledge:

| Action | What it returns |
|--------|----------------|
| `config` | Full `ontofelia.json5` (API keys masked) |
| `system` | Hostname, OS, CPU, memory, disk, Node version |
| `architecture` | Complete architecture diagram + component descriptions |
| `source` | Read Ontofelia's own source code files |

Example: When asked "Which LLM are you using?", the agent's system prompt already contains the current model name, so it responds directly. For deeper introspection, it uses `self_inspect`.

## Cron Management

Ontofelia can schedule itself to wake up at specific times:

```
User: "Wake me every morning at 8 with a summary of the news"
→ Agent uses cron_manage(add, schedule="0 8 * * *", label="morning-news")
→ Cron entry calls POST /api/cron-trigger → Agent wakes up and processes the task
```

The cron trigger endpoint (`POST /api/cron-trigger`) accepts:
```json
{
  "message": "The message to process",
  "agentId": "default"
}
```

## Tool Policy Engine

Every tool invocation is checked against the policy engine before execution.

### Policy Configuration

```json5
// In ontofelia.json5
tools: {
  allow: [],           // Explicitly allowed tools (empty = all allowed)
  deny: ["exec"]       // Blocked tools (overrides allow)
}
```

> **Current default:** The NoopSandboxAdapter (scope `off`) is active by default. However, **in production**, if `scope` is `off` and dangerous tools (`exec`, `cron_manage`, `fs_write`) are allowed, the Gateway will refuse to start. This prevents accidental exposure of the host system.

## Guardian Policy (Human-in-the-Loop)

Ontofelia implements a human-in-the-loop approval flow for potentially dangerous tools.

### Tool Policy Configuration
Every tool invocation is evaluated against `config.tools`. Tools listed in `config.tools.deny` are strictly blocked.
By default, dangerous tools (`exec`, `cron_manage`, `fs_write`, `memory_query`, `memory_retract`, `ontology_propose`) or any tool marked as `hostOnly: true` trigger a `requiresApproval` state unless they are explicitly listed in `config.tools.allow`. Pre-allowing a tool in the allowlist skips the approval process.

### The Approval Flow
When a tool requires approval, the flow is:
1. **Suspension**: The tool execution is suspended (`guardian_confirm` event).
2. **Notification**: A prompt is sent to the owner via Telegram.
3. **Execution or Timeout**: If approved, the tool executes. If there is no response within 60 seconds, the request times out and the tool is denied.

### Telegram UX
In Telegram, the Guardian prompt provides inline buttons:
- **✅ Approve**: Approves the single tool execution.
- **❌ Deny**: Denies the execution.
- **✅✅ Approve all (this task)**: Approves the current execution and enables session-scoped auto-approval. Subsequent dangerous tools in the same session will run automatically without prompting. You can reset this auto-approval by starting a new session with the `/new` command.

## Audit Log

Every tool invocation is strictly audited and stored in `audit.jsonl`:

```json
{
  "toolName": "exec",
  "timestamp": "2026-05-17T09:30:00.000Z",
  "duration": 42,
  "input": { "command": "ls -la" },
  "output": { "success": true },
  "success": true,
  "permissions": ["shell:exec"],
  "agentId": "default",
  "sessionId": "abc-123",
  "channelType": "telegram",
  "senderId": "user123",
  "isOwner": false,
  "policyDecision": "ALLOW",
  "sandboxBackend": "off"
}
```

*Secrets (tokens, passwords, keys) and extremely large payloads are automatically masked or truncated before being written to the audit log.*

## Docker Sandboxing

For production deployments, tools should run inside Docker containers:

```json5
agents: {
  defaults: {
    sandbox: {
      scope: "session",           // "off" | "agent" | "session"
      workspaceAccess: "rw",      // "none" | "ro" | "rw"
      memoryLimitMb: 512,
      cpuQuota: 100000,
      network: false              // Default: true isolation
    }
  }
}
```

The `DockerSandboxAdapter` provides:
- Isolated filesystem (only workspace mounted)
- Configurable network access
- CPU/memory limits
- Automatic container cleanup

> **Current state:** Switch `scope` to `"session"` or `"agent"` in `ontofelia.json5` to enable Docker isolation.

## Plugin Security

Plugins are incredibly powerful and can add new tools or behaviors. 
**Untrusted plugins will not be loaded.** A plugin must be explicitly added to `config.plugins.trusted` array in order to be executed. Alternatively, developers can set `config.plugins.allowUntrusted = true` in development mode.

## Creating Custom Tools

Tools are TypeScript classes implementing `ToolDefinition`:

```typescript
import type { ToolDefinition, ToolContext, ToolResult } from '@ontofelia/core';

export class WeatherTool implements ToolDefinition {
  name = 'weather';
  description = 'Get current weather for a location';
  category = 'web' as const;
  permissions: ToolPermission[] = ['net:http'];
  
  inputSchema = {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City name' }
    },
    required: ['location']
  };

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const { location } = input as { location: string };
    const res = await fetch(`https://api.weather.dev/v1?q=${location}`);
    const data = await res.json();
    return {
      success: true,
      output: data,
      auditEntry: { /* ... */ }
    };
  }
}
```

Register in `apps/gateway/src/index.ts`:
```typescript
toolRegistry.register(new WeatherTool());
```

## Tool Context

Every tool receives a `ToolContext` with:

```typescript
interface ToolContext {
  agentId: string;
  sessionId: string;
  workspacePath: string;
  channelType: ChannelType;
  senderId: string;
  isOwner: boolean;
  sandboxConfig?: {
    scope: 'agent' | 'session' | 'off';
    workspaceAccess: 'none' | 'ro' | 'rw';
  };
}
```
