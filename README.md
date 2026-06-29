<div align="center">

<img src="apps/web-ui/public/ontofelia-avatar.jpg" alt="Ontofelia" width="120" />

# Ontofelia

**The AI agent gateway with a semantic soul.**

An open-source, self-hosted agent gateway that gives your AI a persistent identity, structured long-term memory powered by OWL ontologies, and secure multi-channel communication.

[![CI](https://github.com/semantification-org/Ontofelia/actions/workflows/ci.yml/badge.svg)](https://github.com/semantification-org/Ontofelia/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.4-3178c6.svg)](https://typescriptlang.org)
[![Node.js](https://img.shields.io/badge/Node.js-20+-339933.svg)](https://nodejs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Getting Started](#-getting-started) · [Architecture](#-architecture) · [Documentation](#-documentation) · [Contributing](#-contributing)

</div>

---

> ## ⚠️ v0.0.1 — early research preview
>
> Ontofelia is an **active research project** in **neuro-symbolic AI**: it studies whether coupling an
> LLM with an OWL reasoner and a *governed* RDF knowledge graph yields a more reliable agent than an
> LLM with conventional string/vector memory. It is **under heavy development and not production-ready** —
> APIs, behaviour, and results will change.
>
> **Built by AI — a "vibe coding" experiment.** Ontofelia was implemented end-to-end with AI coding
> agents — **Claude Code**, **Codex**, and **Gemini** — under human direction. It is as much an
> experiment in *AI-assisted, vibe-coded* development as it is a neuro-symbolic AI study. Expect the
> rough edges, inconsistencies, and AI-generated artifacts that come with that.
>
> **On competitor comparisons — please read.** We have **not** run a validated, controlled head-to-head
> against the real **Hermes** or **OpenClaw** products, and we make **no claim** to have beaten them.
> The evaluation below is against a *fair RAG baseline* inside our own harness (a research proxy for
> string/vector memory) — **not** the shipped competitor binaries. An exploratory real-agent run we
> attempted surfaced harness and scoring problems (and a bug in our own forgetting path, since fixed),
> so it is **not** a published result. Treat every number here as **preliminary research**, not a verdict.

---

## Why Ontofelia?

Most AI agents are **stateless parrots** — they forget everything between sessions, can't reason about what they know, and store context as opaque embeddings. Ontofelia is different.

| Feature | Typical Agent | Ontofelia |
|---------|--------------|-----------|
| Memory | Vector embeddings / flat text | **RDF triples + OWL ontology** |
| Reasoning | None | **OWL inference** (via Oxigraph + Reasonable) |
| Knowledge query | Fuzzy similarity search | **SPARQL 1.1** — precise, structured |
| Self-awareness | None | **Ontology reflection** — the agent can inspect and explain its own knowledge model |
| Channels | Single platform | **Multi-channel** — WebChat, Telegram, Discord, WebSocket nodes |
| Tools | Basic function calling | **Governed execution** — policy engine, Guardian approval, audit log |
| Extensibility | Hardcoded | **Skills + Plugins** — hot-loadable ESM modules |

> **Ontofelia doesn't just remember — it *understands*.**

### The research question

Most agents — including OpenClaw and Hermes — store long-term memory as **strings or vectors that
don't reason**. Ontofelia's research *hypothesis* is that a **governed, reasoning** knowledge graph
can offer truth-maintenance a retrieval index cannot guarantee:

> **Hypothesis (under test): an agent whose memory *reasons* can forget completely when told to,
> and reliably flag contradictions — where a retrieval-augmented agent is unreliable.**

This is a hypothesis we are **testing**, not a settled claim, and explicitly **not** a head-to-head
result against the OpenClaw or Hermes products. On plain recall a good vector-RAG already matches
us; the open question is the part a retrieval index *structurally cannot* offer — deletion you can
trust, contradictions caught, and beliefs you can audit (`memory_explain` — "why do I believe
this?").

## 📊 Evaluation — honest & reproducible

**Scope:** this is a controlled *research* benchmark against a **RAG baseline** — a fair, strong
vector-RAG that stands in for the string/vector memory style of agents like OpenClaw and Hermes.
It is **not** a benchmark of those products themselves. The harness swaps **only the memory** behind
one LLM — Ontofelia's governed knowledge graph vs the RAG baseline vs no memory — across **3 models**,
scored H0–H6 with McNemar/Wilcoxon significance (Holm-corrected). Pilot run `pilot-2026-06-25`:

| Capability | Ontofelia | fair vector-RAG | Verdict |
|---|---|---|---|
| Recall (H1) | 0.99 | 1.00 | **tie** — we don't claim a win |
| Multi-hop (H2) | 1.00 | 0.94 | ~tie (not significant) |
| **Forget on command (H6)** | **1.00 — 0% leak** | 0.54 — leaks the "forgotten" fact 31–62% | **decisive win, every model** (p<0.001) |
| **Contradiction flagging (H3)** | **0.93** | 0.20 | **decisive win, every model** (p<0.001) |
| Auditable provenance (H4) | 0.89 | 0.64 | win (pooled, p=0.014) |
| Constraint/consistency (H5) | 1.00 | 0.89 | modest |

The two effects that held on **every model tested** were **forgetting (H6)** and **contradiction
detection (H3)**. This *supports the hypothesis against a RAG baseline* — it is **not** evidence
about the OpenClaw or Hermes products, which we have not benchmarked. Pilot-scale, preliminary.

**Run it yourself:**

```bash
# offline, no API key — proves the harness end-to-end
pnpm --filter @ontofelia/eval build && pnpm --filter @ontofelia/eval test

# the real multi-model benchmark (needs an OpenRouter key)
export OPENROUTER_API_KEY=sk-or-...
EVAL_PROVIDER=openrouter EVAL_MODELS="deepseek/deepseek-v4-flash,openai/gpt-4o-mini,anthropic/claude-haiku-4.5" \
  EVAL_EMBEDDINGS_URL=https://openrouter.ai/api/v1 EVAL_EMBEDDINGS_KEY=$OPENROUTER_API_KEY \
  EVAL_EMBEDDINGS_MODEL=text-embedding-3-small EVAL_JUDGE=llm EVAL_JUDGE_MODEL=openai/gpt-4o-mini \
  node packages/eval/dist/pilot.js   # → packages/eval/out/pilot-<ts>.{json,md}
```

> **Status:** pilot-scale (127 probes/model × 3 models, synthetic personas) — no human-adjudicated
> κ yet, and not a head-to-head against the shipped OpenClaw/Hermes binaries. We say "in our pilot
> evaluation," not "we proved." The reasoner's advantage is regime-specific (truth-maintenance and
> auditable, expensive errors), not universal.

## ✨ Features

### 🧠 Semantic Memory
- Store knowledge as **RDF triples** in a local embedded triplestore (Oxigraph)
- Store facts as **real RDF triples** (not reified meta-data) — entities become OWL individuals
- Build and evolve an **OWL ontology** (TBox) with automatic class/property extension
- **KnowledgeEngine** — entity resolution, property resolution, ABox insertion, provenance
- **OWL-DL reasoning** — automatic inference, consistency checking, disjoint class detection
- **SPARQL 1.1** queries for precise, structured knowledge retrieval
- Provenance tracking — every triple knows when/where/how it was learned

### 🤖 Agent Runtime
- **Multi-provider LLM support** — OpenRouter, OpenAI (API key + OAuth/ChatGPT Plus), any OpenAI-compatible API
- Autonomous **tool-calling loop** with up to 100 rounds per conversation turn (autonomy budget)
- **Token streaming** — real-time token-by-token responses via WebSocket
- **Intelligent LLM fallback** — automatic retry with configurable backup models on empty responses
- **User-configurable fallback order** — set Fallback A/B models directly in the Settings UI
- **Intelligent onboarding** — Named Graph gap-detection drives step-by-step user profiling
- Context assembly from Named Graphs (`user`, `identity`, `soul`)
- Session persistence with JSONL transcripts + SQLite index

### 🔧 Tools & Security
- 8 memory tools: `memory_store`, `memory_query`, `memory_ask`, `memory_explain`, `memory_retract`, `memory_reflect`, `ontology_inspect`, `ontology_propose`
- System tools: `datetime`, `calculator`, `exec`, `fs_read`, `fs_write`, `fs_list`, `web_fetch`, `cron_manage`
- **Tool Policy Engine** — role-based permissions, rate limiting, argument validation
- **Guardian Policy** — requires explicit owner approval via configured channels for dangerous tools when the sandbox is inactive
- **Strict Auditing** — every tool invocation is logged with context, and sensitive secrets are masked
- **Sandboxing** — Docker isolation for dangerous tools; insecure `NoopSandbox` is automatically blocked in production if dangerous tools are allowed

### 📡 Multi-Channel Communication
- **WebChat UI** — built-in React app with real-time WebSocket, Ontofelia owl avatar, model info per message
- **Telegram** and **Discord** adapters (with pairing & allowlist)
- **WebSocket node protocol** — connect IoT devices, desktop apps, headless nodes
- **Webhooks** — receive events from GitHub, CI/CD, external services
- **Cron jobs** — schedule recurring agent tasks

### 🔌 Extensibility
- **Skills** — prompt extensions with custom tool bundles (summarize, translate, explain)
- **Plugins** — ESM modules that extend gateway, tools, commands, and UI
- **Media system** — file upload, thumbnail generation, signed URL access

## 🚀 Getting Started

### Prerequisites

> The **one-command installer** below (`install.sh` / `install.ps1`) installs all of
> these for you automatically. You only need to set them up by hand for the
> **manual install**.

- **Node.js 20+** (LTS) — download from [nodejs.org](https://nodejs.org)
- **pnpm** v9+ — `npm install -g pnpm` or see [pnpm.io](https://pnpm.io/installation)
- **C/C++ toolchain + Python 3** — native modules (`better-sqlite3`) compile from source when no prebuilt binary matches your Node version. On Debian/Ubuntu: `sudo apt-get install build-essential python3`. On macOS: Xcode Command Line Tools (`xcode-select --install`).

> The default triplestore is **Oxigraph**, an embedded npm dependency — no
> Java and no separate server download are required.

### Quick Start (one command)

The installer handles **everything** — Node.js, pnpm, build tools, dependencies,
the build, the `ontofelia` CLI link, onboarding (gateway token + config), and
starting the gateway.

**Linux / macOS / WSL:**
```bash
git clone https://github.com/semantification-org/Ontofelia.git
cd Ontofelia
bash install.sh
```

**Windows (PowerShell):**
```powershell
git clone https://github.com/semantification-org/Ontofelia.git
cd Ontofelia
pwsh -ExecutionPolicy Bypass -File .\install.ps1
```

Then open **http://127.0.0.1:18780** in your browser. That's it.

### Manual install (advanced)

If you already have **Node.js 20+** and **pnpm** and prefer to run each step yourself:

```bash
git clone https://github.com/semantification-org/Ontofelia.git
cd Ontofelia
pnpm install
pnpm build

# In a fresh clone the CLI is not yet on your PATH — invoke it directly:
node apps/cli/dist/index.js onboard        # interactive setup (gateway token + config)
node apps/cli/dist/index.js gateway start
```

> **Tip:** to use the short `ontofelia <command>` form everywhere, link the CLI
> globally once: `pnpm --filter @ontofelia/cli link --global`.

### Configure an LLM Provider

The memory and reasoner layers work without an LLM key, but to use the
chat/LLM path you must **bring your own API key**.

The `onboard` wizard writes your config to `~/.ontofelia/ontofelia.json5`.
You can also set the key via environment variable (see `.env.example` at the
repo root) or edit the config directly:

```bash
nano ~/.ontofelia/ontofelia.json5
```

The provider section looks like this:

```json5
{
  // ... existing config ...
  provider: {
    name: "openrouter",
    apiKey: "sk-or-v1-YOUR-KEY",       // ← your key here
    defaultModel: "deepseek/deepseek-v4-flash:free",
    aliases: {
      fast: "deepseek/deepseek-v4-flash:free",
      smart: "google/gemma-4-26b-a4b-it:free"
    }
  }
}
```

The fastest way to get started is [OpenRouter](https://openrouter.ai) — it
offers free-tier models so you can try Ontofelia without spending anything.

Restart the gateway after changing the config.

### Alternative: Use Your ChatGPT Plus Account

```bash
# Login with your OpenAI account (opens browser)
node apps/cli/dist/index.js auth login
```

This uses OAuth PKCE to authenticate with your ChatGPT Plus/Pro subscription — no API key needed.

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Gateway                             │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐    │
│  │ Channels │  │  Agent   │  │  Semantic Memory   │    │
│  │          │  │ Runtime  │  │  ┌──────────────┐  │    │
│  │ WebChat  │  │          │  │  │ Oxigraph(RDF)│  │    │
│  │ Telegram │──│ Provider │──│  │ OWL Reasoner │  │    │
│  │ Discord  │  │ Tools    │  │  │ SPARQL 1.1   │  │    │
│  │ Webhook  │  │ Sessions │  │  └──────────────┘  │    │
│  │ Cron     │  │ Skills   │  │                    │    │
│  └──────────┘  └──────────┘  └────────────────────┘    │
│  ┌──────────┐  ┌──────────┐  ┌────────────────────┐    │
│  │ Security │  │ Plugins  │  │  Media / Sandbox   │    │
│  │ Policies │  │ Registry │  │  Docker Isolation   │    │
│  └──────────┘  └──────────┘  └────────────────────┘    │
└─────────────────────────────────────────────────────────┘
         │              │               │
    ┌────┴────┐    ┌────┴────┐    ┌─────┴─────┐
    │   CLI   │    │ Web UI  │    │   Nodes   │
    │         │    │ (React) │    │ (WS/IoT)  │
    └─────────┘    └─────────┘    └───────────┘
```

### Monorepo Structure

```
ontofelia/
├── apps/
│   ├── cli/                 # Command-line interface (Commander.js)
│   ├── gateway/             # HTTP/WS server (Fastify 5)
│   └── web-ui/              # Browser UI (React 19 + Vite 6)
├── packages/
│   ├── core/                # Shared types & interfaces
│   ├── config/              # JSON5 config loader with Zod validation
│   ├── agent-runtime/       # LLM orchestration, tool loop, sessions
│   ├── session-store/       # SQLite index + JSONL transcripts
│   ├── semantic-memory/     # RDF/SPARQL adapters, Oxigraph/Fuseki backends
│   ├── providers/           # LLM providers (OpenRouter, OpenAI, OAuth)
│   ├── tools/               # Tool registry, built-in tools, audit log
│   ├── security/            # Policy engine, RBAC, rate limiting
│   ├── channels/            # Channel adapters (WebChat, Telegram, Discord)
│   ├── skills/              # Skill system (prompt extensions + tools)
│   ├── plugins/             # Plugin registry (ESM hot-loading)
│   ├── scheduler/           # Cron jobs & webhook handling
│   ├── sandbox/             # Docker-based sandboxing
│   ├── media/               # File storage, thumbnails, signed URLs
│   ├── nodes/               # WebSocket node protocol for IoT/devices
│   └── testkit/             # MockProvider & test utilities
└── docs/                    # Architecture, interfaces, decisions
```

### Technology Stack

| Layer | Technology | Why |
|-------|-----------|-----|
| Language | TypeScript 5.4 (strict) | Shared types across gateway, CLI, and UI |
| Runtime | Node.js 20+ LTS | Modern ESM, native fetch, stable |
| HTTP | Fastify 5 + WebSocket | High performance, schema validation |
| CLI | Commander.js 13 | Battle-tested, zero config |
| UI | React 19 + Vite 6 | Fast builds, modern DX |
| Database | SQLite (better-sqlite3) | Zero-config, embedded, fast |
| Triplestore | Oxigraph (embedded) + Reasonable | Fast embedded RDF store with OWL reasoning, no separate server |
| RDF Library | N3.js | Turtle/JSON-LD serialization in Node.js |
| Build | Turborepo + pnpm workspaces | Parallel builds, intelligent caching |
| Testing | Vitest | Fast, native ESM support |
| Logging | Pino | Structured JSON, high throughput |

## 📖 Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System design and component overview |
| [Configuration](docs/configuration.md) | Complete configuration reference |
| [Knowledge Graph Concept](docs/knowledge-graph-concept.md) | How the RDF/OWL memory system works |
| [Tools & Security](docs/tools-and-security.md) | Tool system, policies, sandboxing |
| [Channels](docs/channels.md) | Multi-channel setup (Telegram, Discord, etc.) |
| [Skills & Plugins](docs/skills-and-plugins.md) | Extending Ontofelia with custom capabilities |
| [LLM Providers](docs/providers.md) | Configuring OpenRouter, OpenAI, OAuth |
| [API Reference](docs/api.md) | HTTP and WebSocket API documentation |
| [CLI Reference](docs/cli.md) | All CLI commands |
| [Deployment](docs/deployment.md) | Production deployment guide |
| [Interface Contracts](docs/interfaces.md) | TypeScript interfaces for all adapter boundaries |
| [Known Gaps](docs/known_gaps.md) | Current limitations and planned improvements |
| [Known Limitations](docs/known-limitations.md) | Correctness & scaling limitations with tracking tickets |

## 🧪 Development

```bash
# Build all packages
pnpm build

# Run all tests (42 test suites)
pnpm test

# Lint everything
pnpm lint

# Build a single package
pnpm --filter @ontofelia/agent-runtime build

# Run tests for a single package
pnpm --filter @ontofelia/tools test
```

### Project Stats

- **19 packages** in the monorepo
- **~9,000 lines** of TypeScript
- **42 test suites** with full coverage of core modules
- **0 external LLM dependencies** — bring your own provider

## 🗺 Roadmap

- [x] Core architecture (Gateway, CLI, Agent Runtime)
- [x] WebChat UI with real-time WebSocket
- [x] Semantic Memory with embedded Oxigraph triplestore
- [x] OWL-DL reasoning, ontology versioning, reflection
- [x] Tool system with policy engine and audit log
- [x] Multi-channel support (Telegram, Discord)
- [x] Skills and plugin system
- [x] Cron jobs and webhooks
- [x] Docker sandboxing for dangerous tools
- [x] Media system with signed URLs
- [x] OpenRouter and OpenAI provider integration
- [x] OAuth PKCE login (ChatGPT Plus)
- [x] Token streaming in Web UI
- [x] Persistent model switching (via UI + API)
- [x] Intelligent LLM fallback with configurable model order
- [x] Intelligent onboarding (Named Graph gap-detection)
- [x] Ontofelia owl avatar in chat
- [x] systemd service management
- [x] Guardian Layer for exec commands
- [ ] Playwright E2E test suite
- [ ] Extended channel adapters (Slack, WhatsApp, Matrix)
- [ ] Docker Compose deployment
- [ ] Web UI: Memory browser and ontology visualization
- [ ] Multi-agent orchestration
- [ ] Vector search hybrid (SPARQL + embeddings)

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Quick Start for Contributors

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Make your changes
4. Run `pnpm build && pnpm test && pnpm lint`
5. Commit (`git commit -m 'Add amazing feature'`)
6. Push to your fork (`git push origin feature/amazing-feature`)
7. Open a Pull Request

## 📜 License

Ontofelia is open source software licensed under the [Apache License 2.0](LICENSE).

## 🙏 Acknowledgments

- [Apache Jena](https://jena.apache.org/) — the backbone of our semantic memory
- [OpenRouter](https://openrouter.ai/) — affordable access to the best LLMs
- [Fastify](https://fastify.dev/) — blazing fast HTTP framework
- [N3.js](https://github.com/rdfjs/N3.js) — RDF processing in JavaScript

---

<div align="center">

**Built by [Semantification.org](https://semantification.org)**

*Knowledge is not data. Knowledge is structure.*

</div>
