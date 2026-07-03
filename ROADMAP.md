# Ontofelia Roadmap

> Last updated: 2026-07-03

## Vision

Ontofelia is a **self-hosted AI-agent gateway whose long-term memory is a governed knowledge graph**. Instead of a vector store, the agent's beliefs live in an RDF/OWL triplestore with a real reasoner on top: every ingested statement becomes a claim with provenance, inferences are materialised by OWL reasoning, writes are governed, and contradictions are revised instead of accumulated.

The long-term ambition is an agent that can be trusted with durable knowledge *because* its memory is inspectable, auditable, and formally governed — not despite it.

---

## ✅ Done

### Core platform
- pnpm/TypeScript monorepo: gateway (Fastify, REST + WebSocket), CLI, Web UI, session store (SQLite + JSONL transcripts), agent runtime with tool loop
- Channels: Telegram (pairing, inline keyboards, model switching), Discord, webhooks
- LLM providers: OpenRouter, OpenAI (incl. ChatGPT/Codex OAuth login), OpenAI-compatible endpoints; configurable fallback chain
- Tools + security: exec/fs/memory/ontology tools behind a policy engine, guardian layer for dangerous commands, audit log, sandbox architecture

### Semantic memory
- Embedded Oxigraph triplestore + Reasonable (OWL reasoning) via a native Rust addon; optional Apache Jena Fuseki backend
- KnowledgeEngine: entity resolution, auto-TBox extension, claim/evidence provenance, conflict detection
- Truth maintenance: functional properties supersede, non-functional properties accumulate multi-valued facts
- Per-user graph isolation for privacy; cross-session recall reads the graphs the ingester actually writes
- Conversational-perspective (deixis) resolution: user/owner/agent entities are kept distinct during ingestion

### Public release (v0.1 line)
- Public development on GitHub with CI (build + test), secret scanning (gitleaks), and branch protection
- One-command installer (`install.sh` / `install.ps1`), running as a plain non-root user — no Docker required
- Reasoner binaries built and published by CI instead of being committed to the repo
- Honest [Known Limitations](docs/known-limitations.md) and [Known Gaps](docs/known_gaps.md)

---

## 🔄 In progress

- **Try-it-in-2-minutes examples** — scripted recipes that show provenance ("why do you believe that?"), truth maintenance (contradiction → belief revision), and multi-valued facts right after install
- **Install supervision** — auto-restart on crash/reboot for fresh installs (cron watchdog, systemd user unit)
- **First tagged release (v0.1)** — with CI-built, verifiable reasoner binaries
- **Reproducible reasoner-vs-RAG benchmark** — public harness comparing knowledge-graph memory against a fair vector-RAG baseline, stating honestly where the reasoner wins (truth maintenance / contradiction handling) and where it does not

## 📋 Next

- **MCP (Model Context Protocol) support** — connect Ontofelia to the growing MCP tool ecosystem
- **Provenance as a UX feature** — a first-class "why do I believe this?" answer with the claim/evidence chain, in chat and in the Web UI
- **Security & auditability as a product feature** — the governed agent: policy engine, guardian, and audit log surfaced and documented as a differentiator
- **Second messaging channel** — Slack or Teams
- **Installable skill format + registry**
- **Knowledge-graph performance** — on-disk triplestore backend and write batching for large graphs

## 🔭 Later / research

- **Cognitive architecture** — episodic memory, procedural skills, goal stack, and metacognition on top of the knowledge graph (an experimental implementation exists behind feature flags)
- **Multi-agent & federation** — agent-to-agent communication and federated knowledge graphs
- **Multi-tenant & operations** — workspaces, admin dashboard, backup/restore, metrics

---

## Principles

1. **Local first** — Ontofelia always runs locally; the cloud is optional
2. **Governed autonomy** — the agent acts on its own within explicit, auditable policies
3. **Semantic over syntactic** — knowledge as a knowledge graph, not text files
4. **Security through transparency** — guardian layer, audit log, no covert actions
5. **Honesty** — limitations are documented, claims are backed by reproducible evidence
6. **Incremental** — every feature useful on its own, no big-bang release
