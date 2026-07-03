# CLI Reference

The `ontofelia` CLI is the primary management tool for the Ontofelia gateway.

## Installation

The CLI is built as part of the monorepo:

```bash
pnpm build
node apps/cli/dist/index.js <command>
```

For convenience, create an alias (`install.sh` instead puts an `ontofelia` wrapper script on your `PATH`):

```bash
alias ontofelia="node $(pwd)/apps/cli/dist/index.js"   # run from your Ontofelia clone
```

Run `ontofelia --help` (or `ontofelia <command> --help`) at any time for the authoritative command surface.

## Commands

### `ontofelia onboard`

Interactive setup. Creates `~/.ontofelia/` with configuration, gateway token, and workspace bootstrap files.

```bash
ontofelia onboard
ontofelia onboard --non-interactive   # no prompts; uses defaults with the mock provider
```

The wizard walks you through:
1. Prerequisite checks (Node.js ≥ 20; Java only if you pick the legacy Fuseki backend)
2. LLM provider (OpenAI via OAuth, OpenAI API key, OpenRouter, or others)
3. Network mode (loopback or LAN) — a gateway token is always generated
4. Knowledge graph backend (Oxigraph embedded — recommended, Fuseki, or in-memory)
5. File creation: `~/.ontofelia/ontofelia.json5` plus `workspace/` (SOUL.md, IDENTITY.md, USER.md)

With `--non-interactive`, steps 2–4 are skipped: the provider is set to `mock` and all other settings use defaults. Configure a real provider afterwards with `ontofelia model`.

---

### `ontofelia gateway`

Manage the Ontofelia gateway server.

```bash
ontofelia gateway start         # Start in background (also the default: `ontofelia gateway`)
ontofelia gateway stop          # Stop the running gateway
ontofelia gateway restart       # Restart the gateway (runs in foreground afterwards)
ontofelia gateway run           # Run in foreground (for systemd)
```

`gateway start` options: `--port <port>`, `--bind <mode>`, `--token <token>`, `--foreground`.

In background mode the PID is written to `~/.ontofelia/gateway.pid` and logs go to `~/.ontofelia/logs/gateway.log`.

The gateway starts:
- HTTP/WebSocket server on port 18780
- Embedded Oxigraph triplestore (in-process, no separate port; or Fuseki sidecar on 18787 if `backend = "fuseki"`)
- Web UI served at `/`
- Agent runtime with configured provider
- Telegram/Discord bots (if configured)

---

### `ontofelia status`

Show gateway status (from the PID file plus `GET /api/status`).

```bash
ontofelia status
ontofelia status --json
```

Reports gateway process state, uptime and version, agents running, channels connected, the knowledge graph backend with its triple count, the Web UI URL, and the gateway token.

---

### `ontofelia health`

Quick health check against `GET /api/health` (works without the token).

```bash
ontofelia health
ontofelia health --json
```

---

### `ontofelia doctor`

Check (and optionally repair) the configuration.

```bash
ontofelia doctor
ontofelia doctor --repair    # merge missing keys back in from the defaults
```

Checks:
- Config file parses as JSON5 and validates against the schema
- Session store and workspace directories exist
- Fuseki triplestore reachable (only meaningful with the Fuseki backend)
- Docker available (needed for sandboxing)

---

### `ontofelia channel`

Interactive wizard to configure Telegram and Discord channels.

```bash
ontofelia channel
```

The wizard guides you through choosing Telegram or Discord, entering the bot token, and saving to `ontofelia.json5`. Restart the gateway afterwards. New Telegram/Discord users must pair and be approved (see `pairing`).

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
ontofelia allowlist list telegram          # Filter by channel
ontofelia allowlist add <channel> <id> --name <name>   # Add a user directly
ontofelia allowlist remove <channel> <id>  # Remove a user
```

---

### `ontofelia provider`

Manage the LLM provider.

```bash
ontofelia provider status                  # Show current provider + model
ontofelia provider models                  # List available models
ontofelia provider test "What is 2+2?"     # Send a test message
```

---

### `ontofelia model`

Interactive wizard to switch the LLM provider and model. Writes `provider` to `ontofelia.json5`; restart the gateway to apply.

```bash
ontofelia model
```

Note: models can also be switched in-chat via the `/model` command.

---

### `ontofelia auth`

Manage OpenAI OAuth authentication and the gateway token.

```bash
ontofelia auth login                       # Start OAuth PKCE flow
ontofelia auth status                      # Show auth status
ontofelia auth logout                      # Remove stored tokens
ontofelia auth token                       # Print the gateway access token (for the Web UI / API)
```

---

### `ontofelia skills` / `ontofelia plugins`

```bash
ontofelia skills list                      # List available skills
ontofelia plugins list                     # List installed plugins
ontofelia plugins install <path>           # Install a plugin from a local path
ontofelia plugins activate <name>
ontofelia plugins deactivate <name>
```

---

### `ontofelia cron` / `ontofelia webhooks`

Manage scheduled jobs and inbound webhooks (both talk to the running gateway).

```bash
ontofelia cron list
ontofelia cron add                         # Interactive: name, cron expression, agent, prompt
ontofelia cron remove <id>
ontofelia cron run <id>                    # Trigger a job manually

ontofelia webhooks list
ontofelia webhooks create                  # Interactive: name, path, auth method, secret
ontofelia webhooks delete <id>
```

---

### `ontofelia sandbox`

Manage Docker sandboxes for tool execution.

```bash
ontofelia sandbox list
ontofelia sandbox prune --idle <hours> --age <days>
ontofelia sandbox build                    # Build the sandbox Docker image
```

---

### `ontofelia ontology` / `ontofelia reasoning`

Manage the knowledge graph's ontology and reasoning.

```bash
ontofelia ontology versions                # List ontology versions
ontofelia ontology proposals               # List evolution proposals
ontofelia ontology approve <id>            # Approve a proposal
ontofelia ontology rollback <version>      # Roll back to a version (e.g. v001)

ontofelia reasoning conflicts              # Show detected knowledge conflicts
ontofelia reasoning reflect                # Trigger a memory reflection manually
```

---

### `ontofelia devices`

Manage paired nodes/devices (connected via `/ws/node`).

```bash
ontofelia devices list
ontofelia devices approve <code>
ontofelia devices reject <code>
```

---

### `ontofelia media`

```bash
ontofelia media list
ontofelia media delete <id>
```

---

### `ontofelia daemon`

Manage Ontofelia as a systemd user service (Linux).

```bash
ontofelia daemon install                   # Write + enable + start the user unit (enables lingering)
ontofelia daemon status
ontofelia daemon logs                      # Follow journalctl output
ontofelia daemon uninstall
```

---

### Reset and removal

```bash
ontofelia data-reset [--yes]               # Delete conversations + knowledge graph; keep LLM/Telegram settings
ontofelia reset [--yes] [--keep-config]    # Factory reset: all data, re-seeds from bootstrap
ontofelia rebuild [--no-restart]           # Recompile all packages and restart the gateway
ontofelia uninstall [--yes] [--keep-data]  # Remove Ontofelia from this system
```

Both reset commands prompt for confirmation unless `--yes` is given.

---

## Chat Commands (In-Session)

These commands are available inside any chat session (Web UI, Telegram):

| Command | Description |
|---------|-------------|
| `/model` | Show available LLMs + switch model (Telegram: inline buttons) |
| `/model <name>` | Switch to a specific model (persisted to config) |
| `/new` | Start a new session (archives the current one) |
| `/reset` | Reset the session (transcript cleared) |
| `/reset soft` | Soft reset (context cleared, transcript kept) |
| `/status` | Show agent status |
| `/tools` | List available tools |
| `/skills` | List installed skills |
| `/skill <name> [input]` | Execute a skill |
| `/plugins` | List installed plugins |
| `/cog [health\|retain\|consolidate\|scan\|migrate\|debug on\|debug off\|cycles\|explain <cycleId>]` | Cognitive-architecture maintenance and inspection |
| `/stop` | Stop the agent |
| `/help` | Show available commands |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Error (details on stderr) |
