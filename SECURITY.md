# Security Policy

## Supported Versions

Currently, the `main` branch of Ontofelia is supported with security updates. Releases will follow semantic versioning.

## Threat Model

Ontofelia is an AI Agent Gateway designed to operate with high autonomy. It bridges external user input (via chat channels) with local system execution and deep semantic reasoning.

**Trusted Components:**
- The Owner/Admin
- Pre-configured `allow` and `deny` tool lists
- Explicitly trusted Plugins in `config.plugins.trusted`

**Untrusted Components:**
- LLM Outputs (The AI can be prompt-injected)
- Unauthenticated users via public channels
- External web content fetched by tools
- Unlisted/untrusted plugins

### Secure Defaults
- **Path Traversal Protection**: Filesystem tools (`fs_read`, `fs_write`, `fs_list`) use strict relative path validation. Absolute paths and attempts to break out of the workspace (`../`) are blocked.
- **Timing-Safe Auth**: All internal token comparisons (WebSocket, Bearer tokens, Signed URLs) use constant-time operations (`crypto.timingSafeEqual`) to prevent side-channel timing attacks.
- **Audit Logging**: Every tool execution is logged to `audit.jsonl`. Secrets (tokens, passwords) are automatically masked.
- **SPARQL Hardening**: The `memory_sparql` tool strictly enforces Read-Only (`SELECT`, `ASK`) queries via an AST/Regex parser that strips comments and strings before validation. Modifying statements are strictly blocked for autonomous agents.
- **Cron Hardening**: The `cron_manage` tool writes to secure temporary files before applying crontabs via `execFile` without a shell, avoiding shell injection.

## Sandboxing & Production Requirements

### 1. The Sandbox Rule
If dangerous tools (`exec`, `cron_manage`, `fs_write`) are allowed in your `ontofelia.json5` configuration, **you must use the DockerSandboxAdapter in production.**
The `NoopSandboxAdapter` (scope: `off`) executes commands directly on your host machine. Ontofelia actively blocks startup if `NODE_ENV=production`, scope is `off`, and dangerous tools are present in the allowlist.

### 2. Guardian Policy
If you bypass the sandbox restriction, the **Guardian Policy** acts as a human-in-the-loop fallback. Any invocation of a dangerous tool (`hostOnly: true`) by the agent will be suspended until the human owner explicitly approves the execution via a configured trusted channel (e.g., CLI or Telegram).

### 3. Plugin Trust
Third-party plugins have full access to the Node.js runtime. By default, **Ontofelia blocks the loading of all plugins** unless they are explicitly listed in `config.plugins.trusted`.

## Dependency Advisories

We run `pnpm audit` as part of our review process. Our policy distinguishes
**runtime-reachable** advisories (shipped in the gateway/agent) from
**dev-only** advisories (test runner, bundler — never deployed).

### Fixed (runtime-reachable, pinned via `pnpm.overrides` in the root `package.json`)
- **`form-data`** → `>=4.0.6` — CRLF injection / unsafe random boundary
  (reachable transitively through `node-telegram-bot-api`).
- **`ws`** → `>=8.21.0` — DoS via memory exhaustion (reachable through the
  Discord channel).
- **`undici`** → `^6.27.0` — DoS in the WebSocket client. Pinned to the `6.x`
  line on purpose: `8.x` requires a newer Node web platform than our runtime
  baseline (Node 20) and breaks at load.

### Accepted, dev-only (not shipped, no runtime exposure)
The remaining advisories reported by `pnpm audit` live exclusively in the
**development toolchain** and are not part of any published artifact:
- **`vitest`** / **`vite`** / **`esbuild`** — test runner and bundler, used
  only for `pnpm test` and `pnpm build`. They never run in the gateway process
  and are not installed in production deployments.
- Assorted transitive `moderate`/`low` advisories (e.g. `qs`, `tough-cookie`,
  `request`) arrive through the same dev/CLI dependency chains.

These will be cleared as the upstream dev dependencies are upgraded; they do not
affect the security posture of a running Ontofelia instance.

## Reporting a Vulnerability

If you discover a security vulnerability in Ontofelia, please do not disclose it publicly.

1. Send an email to the maintainers at info@semantification.org
2. Provide a detailed description of the vulnerability, including steps to reproduce.
3. We will respond within 48 hours to coordinate a fix and release plan.
