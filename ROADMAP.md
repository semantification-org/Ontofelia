# Ontofelia Roadmap

> Last updated: 2026-05-17

## Vision

Ontofelia will become a **fully autonomous AI agent** that evolves itself, replicates across multiple servers, and operates as a networked agent ecosystem.

---

## ✅ Completed

### Foundation (Phase 0–2)
- Monorepo (pnpm + Turborepo, TypeScript strict, ESM)
- Core interfaces, config management (JSON5)
- CLI: init, gateway, status, doctor, channel, pairing, model
- Gateway: Fastify 5, HTTP REST API, WebSocket
- Session store: SQLite + JSONL transcripts
- Agent runtime: tool loop (max 100 rounds), system prompt, bootstrap files

### UX & channels (Phase 3, 6)
- Web UI (React/Vite): chat, sessions, settings, debug panel
- Telegram: polling, pairing, inline keyboards, /model, context line, Markdown fallback
- Discord: bot API, pairing, mention gating
- Webhooks: HMAC-signed, template-based

### Intelligence (Phase 4, 10)
- Semantic memory: embedded Oxigraph triplestore + Reasonable (OWL-DL reasoning); optional Apache Jena Fuseki backend
- KnowledgeEngine: entity resolution, auto-TBox extension, provenance
- Cross-session memory (30 most recent facts)
- Ontology management, conflict detection, reflection

### Tools & security (Phase 5, 9)
- Tools: exec, fs_read/write/list, memory_*, ontology_*, datetime, calculator
- Autonomy tools: self_inspect, web_fetch, cron_manage
- Tool policy engine, audit log
- Sandbox architecture (Docker + Noop)

### Autonomy (priority 1)
- Streaming responses in the Web UI (token-by-token)
- Persistent /model switching (ontofelia.json5, sorted model list)
- Systemd service (ontofelia daemon install)
- Guardian layer for dangerous exec commands (Telegram buttons)
- /model with inline keyboards
- Cron-trigger endpoint for self-wake-up
- LLM auto-fallback to free models
- User-configurable fallback order (Fallback A/B in settings)
- Onboarding (Named Graph gap detection, gradual profiling)
- Ontofelia avatar (owl mascot in chat bubbles)
- Fallback transparency (attempted models shown in the error message)
- Web UI settings (model, fallback, auto-fallback toggle)

### Infrastructure (Phase 7, 8, 11)
- Skills & plugins system
- Cron scheduler, webhook receiver
- Media store, node protocol (WS)
- LLM providers: OpenRouter, OpenAI (OAuth PKCE)

---

## 🔄 In progress

*No open implementations right now.*

---

## 📋 Next milestones

### Milestone 1: Robustness & everyday usefulness
> Goal: Ontofelia runs 24/7 reliably and is useful in daily life.

| Feature | Description | Effort |
|---|---|---|
| Multi-user sessions | Each Telegram user gets their own session + memory | 3h |
| Image/file intake | Telegram: receive and process photos, PDFs, voice | 3h |
| HTTPS + remote access | Reverse proxy, Let's Encrypt, reachable from anywhere | 2h |
| Memory browser | Web UI: visually inspect the ontology and facts | 3h |
| Error recovery | Auto-restart on crash, health-check watchdog | 2h |
| Telegram BotCommands | Slash menu with function suggestions | 1h |

### Milestone 2: Proactivity & knowledge
> Goal: Ontofelia acts on its own and learns from documents.

| Feature | Description | Effort |
|---|---|---|
| Proactive messages | Agent writes to Telegram on its own (cron → push) | 2h |
| RAG / document ingestion | Upload documents → index → use when answering | 1 day |
| Voice I/O | Telegram voice → Whisper STT → answer → TTS | 4h |
| Web search tool | Real web search (not just fetching single URLs) | 3h |
| Summaries | Daily/weekly summary of activity | 2h |

### Milestone 3: Self-development
> Goal: Ontofelia can safely modify its own code.

| Feature | Description | Effort |
|---|---|---|
| Safe-mode build | Build in a temp dir, deploy only on success | 2h |
| Auto-rollback | Git-based: revert + restart if the gateway stops responding | 2h |
| Smoke test suite | Automated checks: gateway starts? API ok? WS ok? | 3h |
| Dev-branch workflow | Changes on a branch, merge after review | 2h |
| Code-review skill | Ontofelia reviews its own changes before committing | 3h |

### Milestone 4: Agent network
> Goal: Multiple Ontofelia instances work together.

| Feature | Description | Effort |
|---|---|---|
| Sub-agent spawning | `spawn_agent` tool: temporary agents with their own prompt | 1 day |
| Remote deployment | Ontofelia installs itself on a VPS | 4h |
| Agent-to-agent communication | Messages between instances via API | 1 day |
| Shared knowledge graph | Federated SPARQL across multiple Fuseki instances | 1 week |
| Task delegation | Main agent distributes tasks to specialized sub-agents | 1 day |

### Milestone 5: Enterprise & scaling
> Goal: Ontofelia usable in production environments.

| Feature | Description | Effort |
|---|---|---|
| Multi-tenant | Multiple users with separate workspaces and KGs | 1 week |
| Admin dashboard | Web UI for configuration, user management, monitoring | 1 week |
| API rate limiting | Per-user limits for LLM calls | 3h |
| Backup & restore | Automatic backups of KG, sessions, config | 4h |
| Metrics & monitoring | Prometheus/Grafana integration | 1 day |

---

## Principles

1. **Local first** — Ontofelia always runs locally; the cloud is optional
2. **Autonomy over control** — the agent should be able to decide for itself
3. **Semantic over syntactic** — knowledge as a knowledge graph, not text files
4. **Security through transparency** — guardian layer, audit log, no covert actions
5. **Incremental** — every feature useful on its own, no big-bang release
</content>
