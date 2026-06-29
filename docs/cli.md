# CLI Reference

The `ontofelia` CLI is the primary management tool for the Ontofelia gateway.

## Installation

The CLI is built as part of the monorepo:

```bash
pnpm build
node apps/cli/dist/index.js <command>
```

For convenience, create an alias:

```bash
alias ontofelia="node $(pwd)/apps/cli/dist/index.js"   # run from your Ontofelia clone
```

## Commands

### `ontofelia init`

Initialize a new Ontofelia installation. Creates `~/.ontofelia/` with default configuration.

```bash
ontofelia init
```

This creates:
- `~/.ontofelia/ontofelia.json5` — configuration file
- `~/.ontofelia/workspace/` — agent workspace with bootstrap files (SOUL.md, etc.)
- Gateway authentication token

Options:
- `--force` — overwrite existing configuration

---

### `ontofelia gateway`

Manage the Ontofelia gateway server.

```bash
ontofelia gateway start         # Start in background (daemonized)
ontofelia gateway stop          # Stop the running gateway
ontofelia gateway restart       # Restart the gateway
ontofelia gateway run           # Run in foreground (for systemd)
ontofelia gateway --install-daemon  # Install as systemd service
```

The gateway starts:
- HTTP/WebSocket server on port 18780
- Embedded Oxigraph triplestore (in-process, no separate port; or Fuseki sidecar on 18787 if `backend = "fuseki"`)
- Web UI served at `/`
- Agent runtime with configured provider
- Telegram/Discord bots (if configured)

---

### `ontofelia status`

Show gateway status and health information.

```bash
ontofelia status
```

Output:
```
Ontofelia Status

  Gateway:    ✔ Running (PID 12345)
  Uptime:     2h 15m
  Port:       18780
  Provider:   openrouter (openai/gpt-oss-120b:free)
  Memory:     oxigraph (embedded, 342 triples)
  Channels:   webchat ✔, telegram ✔
```

---

### `ontofelia doctor`

Run diagnostic checks on the installation.

```bash
ontofelia doctor
```

Checks:
- Node.js version (requires ≥ 20)
- Config file validity
- Triplestore: Oxigraph data directory writable (or Fuseki + Java 17+ if `backend = "fuseki"`)
- Provider authentication
- Workspace file integrity

---

### `ontofelia channel`

Interactive wizard to configure Telegram and Discord channels.

```bash
ontofelia channel
```

The wizard guides you through:
1. Choosing Telegram or Discord
2. Entering and validating the bot token
3. Setting DM policy (pairing, allowlist, open)
4. Saving to `ontofelia.json5`

---

### `ontofelia pairing`

Manage channel pairing requests (Telegram/Discord user approval).

```bash
ontofelia pairing list                     # Show pending requests
ontofelia pairing list telegram            # Filter by channel
ontofelia pairing approve <code>           # Approve a user
ontofelia pairing reject <code>            # Reject a user
```

When a new Telegram/Discord user messages the bot, they get a pairing code. The admin must approve it via this command before the user can chat.

---

### `ontofelia allowlist`

Manage the list of approved channel users.

```bash
ontofelia allowlist list                   # Show all approved users
ontofelia allowlist list telegram           # Filter by channel
```

---

### `ontofelia config show`

Display the current configuration (with sensitive values masked).

```bash
ontofelia config show
```

---

### `ontofelia provider`

Manage LLM providers.

```bash
ontofelia provider status                  # Show current provider + model
ontofelia provider models                  # List available models
ontofelia provider test "What is 2+2?"     # Send a test message
```

---

### `ontofelia model`

Quick model management.

```bash
ontofelia model                            # Show current model
ontofelia model set <model-id>             # Switch model
ontofelia model list                       # List available models
```

Note: Models can also be switched in-chat via `/model` command.

---

### `ontofelia auth`

Manage OpenAI OAuth authentication.

```bash
ontofelia auth login                       # Start OAuth PKCE flow
ontofelia auth status                      # Show auth status
ontofelia auth logout                      # Remove stored tokens
```

---

### `ontofelia chat <message>`

Send a message to the agent from the command line.

```bash
ontofelia chat "What's the weather like today?"
```

Options:
- `--agent <id>` — target a specific agent (default: `default`)
- `--session <id>` — use a specific session

---

### `ontofelia sessions`

Manage sessions.

```bash
ontofelia sessions                         # List all sessions
ontofelia sessions reset <id>              # Soft reset (clear context)
ontofelia sessions reset <id> --hard       # Hard reset (delete transcript)
```

---

### `ontofelia memory`

Manage the knowledge graph.

```bash
ontofelia memory export --format turtle > knowledge.ttl
ontofelia memory export --ontology-only > ontology.owl
ontofelia memory import knowledge.ttl
ontofelia memory stats
```

---

### `ontofelia tools list`

List all registered tools and their policies.

```bash
ontofelia tools list
```

---

### `ontofelia logs`

Follow gateway logs in real-time.

```bash
ontofelia logs
ontofelia logs --level debug
```

---

## Chat Commands (In-Session)

These commands are available inside any chat session (Web UI, Telegram, CLI):

| Command | Description |
|---------|-------------|
| `/model` | Show available LLMs + switch model (Telegram: inline buttons) |
| `/model <name>` | Switch to a specific model |
| `/new` | Start a new session |
| `/reset` | Soft reset (clear context, keep transcript) |
| `/status` | Show agent status |
| `/tools` | List available tools |
| `/skills` | List installed skills |
| `/plugins` | List installed plugins |
| `/help` | Show available commands |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General error |
| 2 | Configuration error |
| 3 | Connection error (gateway not running) |
