# Configuration Reference

Ontofelia uses a single JSON5 configuration file located at `~/.ontofelia/ontofelia.json5`. This file is created during `ontofelia init` and can be edited manually or via CLI commands.

## File Location

| Platform | Default Path |
|----------|-------------|
| Linux/macOS | `~/.ontofelia/ontofelia.json5` |
| WSL | `~/.ontofelia/ontofelia.json5` |

The config directory also contains:
- `auth.json` — OAuth tokens (created by `ontofelia auth login`)
- `data/` — session database, transcripts, media files
- `oxigraph/` — embedded triplestore data (default backend)
- `fuseki/` — only present when the optional Fuseki sidecar backend is used
- `workspace/` — agent workspace files

## Complete Configuration Schema

```json5
{
  // Gateway settings
  gateway: {
    port: 18780,                    // HTTP/WebSocket port
    bind: "loopback",               // "loopback" (127.0.0.1) or "0.0.0.0"
    token: "auto-generated-hex",    // 32-byte hex token for authentication
    corsOrigins: ["http://localhost:*"]
  },

  // Agent configuration
  agents: [
    {
      agentId: "default",           // Unique agent identifier
      displayName: "Ontofelia",     // Human-readable name
      systemPrompt: "...",          // Base system prompt
      bootstrapPaths: [             // Files injected into context
        "~/.ontofelia/workspace/SOUL.md",
        "~/.ontofelia/workspace/IDENTITY.md",
        "~/.ontofelia/workspace/USER.md"
      ],
      sessionPolicy: {
        scope: "per-channel-peer",  // "main" | "per-peer" | "per-channel-peer"
        maxHistory: 50,             // Max messages in context window
        idleTimeoutMin: 60          // Auto-archive after N minutes idle
      },
      tools: {
        enabled: ["datetime", "calculator", "memory_store", "memory_query"],
        maxRoundsPerTurn: 10        // Max tool-call rounds per user message
      }
    }
  ],

  // LLM Provider
  provider: {
    name: "openrouter",             // "openrouter" | "openai" | "mock"
    apiKey: "sk-or-v1-...",         // API key (not needed for OAuth)
    defaultModel: "deepseek/deepseek-v4-flash:free",
    aliases: {                      // Model shortcuts
      fast: "deepseek/deepseek-v4-flash:free",
      smart: "google/gemma-4-26b-a4b-it:free"
    },
    maxTokens: 4096,                // Default max output tokens
    temperature: 0.7,               // Default temperature
    timeout: 30000,                 // Request timeout in ms
    autoFallback: true,             // Auto-retry with fallback models on empty response
    fallbackModels: [               // Ordered list of fallback models (tried on empty response)
      "deepseek/deepseek-chat-v3-0324:free",
      "google/gemma-3-27b-it:free"
    ]
  },

  // Semantic Memory
  memory: {
    backend: "oxigraph",            // "oxigraph" (default, embedded) | "fuseki" (legacy sidecar) | "none"
    oxigraph: {
      dataDir: "~/.ontofelia/oxigraph"  // Persistent triplestore directory
    },
    fuseki: {                       // Only used when backend = "fuseki"
      port: 18787,
      dataset: "ontofelia",
      javaHome: null                // Custom JAVA_HOME (auto-detected)
    },
    ontology: {
      sharedBaseIri: "urn:shared:ontology#",  // Shared TBox (admin-only)
      agentBaseIri: "urn:ontofelia:",         // Agent-scoped graphs (self, worldview, user:<id>, ...)
      autoReason: true,             // Run Reasonable on accepted knowledge graphs
      snapshotOnBoot: true          // Backup graphs on gateway start
    }
  },

  // Channels
  channels: {
    webchat: {
      enabled: true                 // WebChat is always available
    },
    telegram: {
      enabled: false,
      token: "",                    // Bot token from @BotFather
      dmPolicy: "pairing",         // "pairing" | "allowlist" | "open"
      allowFrom: []                 // Allowed Telegram user IDs
    },
    discord: {
      enabled: false,
      token: "",                    // Bot token from Discord Developer Portal
      dmPolicy: "pairing",
      allowFrom: []
    }
  },

  // Tool and security policy
  tools: {
    allow: [],                      // Explicitly allowed host-only tools, e.g. ["exec"]
    deny: ["fs_write", "memory_query", "memory_retract"]
  },
  plugins: {
    trusted: [],                    // Plugin names explicitly trusted for activation
    allowUntrusted: false           // Development-only escape hatch
  },
  security: {
    requireGuardian: true,
    guardianTimeoutMs: 60000
  },

  // Scheduler
  scheduler: {
    jobs: [],                       // Cron job definitions
    webhooks: []                    // Webhook endpoint definitions
  },

  // Logging
  logging: {
    level: "info",                  // "debug" | "info" | "warn" | "error"
    format: "json"                  // "json" | "pretty"
  }
}
```

## Environment Variables

These override config file values:

| Variable | Description | Default |
|----------|-------------|---------|
| `ONTOFELIA_HOME` | Config directory | `~/.ontofelia` |
| `ONTOFELIA_PORT` | Gateway port | `18780` |
| `ONTOFELIA_TOKEN` | Gateway auth token | from config |
| `OPENAI_API_KEY` | OpenAI API key | from config |
| `OPENROUTER_API_KEY` | OpenRouter API key | from config |
| `JAVA_HOME` | Java installation path | auto-detected |

## Provider Configuration Examples

### OpenRouter (Recommended for Getting Started)

```json5
provider: {
  name: "openrouter",
  apiKey: "sk-or-v1-...",
  defaultModel: "deepseek/deepseek-v4-flash:free"
}
```

Free models on OpenRouter: `deepseek/deepseek-v4-flash:free`, `google/gemma-4-26b-a4b-it:free`, `meta-llama/llama-4-maverick:free`

### OpenAI (API Key)

```json5
provider: {
  name: "openai",
  apiKey: "sk-...",
  defaultModel: "gpt-4o-mini"
}
```

### OpenAI (OAuth / ChatGPT Plus)

No config needed — run `ontofelia auth login` and authenticate in your browser. The token is stored in `~/.ontofelia/auth.json`.

## Session Policies

| Scope | Behavior |
|-------|----------|
| `main` | One global session for the agent |
| `per-peer` | One session per sender (across channels) |
| `per-channel-peer` | One session per sender per channel (default) |

## Data Directory Layout

```
~/.ontofelia/
├── ontofelia.json5           # Configuration
├── auth.json                 # OAuth tokens (mode 0600)
├── data/
│   ├── sessions.db           # SQLite session index
│   ├── transcripts/          # JSONL chat transcripts
│   ├── media/                # Uploaded files and thumbnails
│   └── audit.log             # Tool invocation audit log
├── oxigraph/                 # Embedded RDF triplestore (default backend)
├── fuseki/                   # Only present if backend = "fuseki" (legacy)
│   ├── apache-jena-fuseki-5.0.0/
│   └── data/
├── workspace/
│   ├── SOUL.md               # Agent personality and behavior
│   ├── IDENTITY.md           # Agent identity card
│   └── USER.md               # User preferences
├── skills/                   # Custom skill definitions
└── plugins/                  # ESM plugin modules
```
