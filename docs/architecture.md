# Architecture

This document describes the high-level architecture of Ontofelia, the design principles behind it, and how the components interact.

## Design Principles

1. **Gateway-first** — all channels, nodes, webhooks, and UIs communicate through the gateway. No direct connections between components.
2. **Loopback-first** — the gateway binds to `127.0.0.1` by default. Network exposure is opt-in.
3. **Token-always** — even local setups generate and require a gateway token.
4. **Adapters, not special cases** — providers, channels, triplestore, tools, and plugins all have stable interfaces. Swapping implementations never requires changing application code.
5. **Files stay readable** — user-facing artifacts live under `~/.ontofelia/` in human-readable formats (JSON5, JSONL, Turtle).
6. **No silent repairs** — migrations and config corrections create backups first.

## System Overview

```
                    ┌─────────────────────────────────┐
                    │           Gateway                │
                    │                                  │
  ┌──────────┐     │  ┌──────────┐  ┌──────────────┐ │
  │ WebChat  │────▶│  │ Channel  │  │    Agent     │ │
  │ Telegram │────▶│  │ Registry │──│   Runtime    │ │
  │ Discord  │────▶│  │          │  │              │ │
  │ Webhook  │────▶│  └──────────┘  │  ┌────────┐ │ │
  │ Cron     │────▶│                │  │Provider│ │ │
  └──────────┘     │  ┌──────────┐  │  │ Loop   │ │ │
                    │  │ Session  │◀─│  │ Tools  │ │ │
  ┌──────────┐     │  │  Store   │  │  └────────┘ │ │
  │   CLI    │────▶│  └──────────┘  └──────────────┘ │
  └──────────┘     │                                  │
                    │  ┌──────────┐  ┌──────────────┐ │
  ┌──────────┐     │  │ Semantic │  │  Security    │ │
  │  Web UI  │────▶│  │  Memory  │  │  Policies    │ │
  └──────────┘     │  │(Oxigraph)│  │  Sandbox     │ │
                    │  └──────────┘  └──────────────┘ │
  ┌──────────┐     │                                  │
  │  Nodes   │────▶│  ┌──────────┐  ┌──────────────┐ │
  │ (WS/IoT) │     │  │ Plugins  │  │  Scheduler   │ │
  └──────────┘     │  │ Skills   │  │  Cron/Hooks  │ │
                    │  └──────────┘  └──────────────┘ │
                    └─────────────────────────────────┘
```

## Component Details

### Gateway (`apps/gateway`)

The central process. Responsibilities:
- HTTP REST API (Fastify 5)
- WebSocket API for real-time communication
- Static file serving for the Web UI
- Channel adapter lifecycle management
- Agent runtime orchestration
- Embedded Oxigraph triplestore lifecycle (init, snapshot, backup)
- Request authentication and routing

**Port allocation:**
| Port | Service |
|------|---------|
| 18780 | Gateway (HTTP + WebSocket + UI) |
| 18793 | Canvas/File host |
| 18799 | OAuth callback server (temporary) |

Oxigraph runs in-process — no separate port. The optional legacy Fuseki sidecar would bind to 18787 if enabled.

### Agent Runtime (`packages/agent-runtime`)

Orchestrates LLM interactions:

```
User Message
    │
    ▼
┌──────────────┐
│ Context      │ ← Bootstrap files (SOUL.md, IDENTITY.md, ...)
│ Assembly     │ ← Session history
│              │ ← Tool definitions
└──────┬───────┘
       │
       ▼
┌──────────────┐
│ LLM Call     │ ← Provider adapter (OpenRouter/OpenAI/...)
│              │
└──────┬───────┘
       │
       ├── Text response → Return to user
       │
       └── Tool calls → Execute tools → Loop back to LLM
           (max 100 rounds per turn)
```

### Session Store (`packages/session-store`)

Manages conversation persistence:
- **SQLite** index for fast session lookup and metadata
- **JSONL** transcript files for complete chat history
- Session policies (per-peer, per-channel-peer, main)
- Token counting and context window management

### Semantic Memory (`packages/semantic-memory`)

The knowledge graph system. See [knowledge-graph-concept.md](knowledge-graph-concept.md) for the full topology.

- **KnowledgeEngine** — central orchestration layer for entity resolution, predicate registration, fact insertion, Claim/Evidence provenance, and conflict detection
- **Oxigraph** — embedded RDF triplestore (in-process, no sidecar, no separate port). The optional Fuseki adapter remains as a legacy sidecar backend.
- **Reasonable** — OWL reasoner. Materialization runs only over accepted knowledge graphs (not over Claim/Evidence metadata).
- **Named graphs** — agent-overarching `urn:shared:<graph>` (e.g. `urn:shared:ontology`, `urn:shared:world`, `urn:shared:shapes`) and agent-scoped `urn:<agent>:<graph>` (e.g. `urn:ontofelia:self`, `urn:ontofelia:worldview`, `urn:ontofelia:user:<id>`, `urn:ontofelia:claims`, `urn:ontofelia:evidence`, `urn:ontofelia:schema`, `urn:ontofelia:conflicts`, `urn:ontofelia:session:<id>`)
- **Truth Maintenance** — every extracted fact is accepted immediately; conflicts are resolved post-hoc via belief revision (`status "superseded"`)
- **Agent-local schema graph** — new predicates from the parser land in `urn:<agent>:schema`; the shared TBox (`urn:shared:ontology`) stays admin-only
- **Claim/Evidence provenance** — each fact has a `core:Claim` in `urn:<agent>:claims` and a `core:Evidence` in `urn:<agent>:evidence` (RDF-1.1-compatible, no RDF-Star)

### Providers (`packages/providers`)

LLM provider abstraction:
- `OpenAICompatibleProvider` — base class for OpenAI-format APIs
- `OpenRouterProvider` — OpenRouter-specific headers and routing
- `OpenAIProvider` — direct OpenAI API with OAuth support
- `ProviderFactory` — runtime provider selection

### Security (`packages/security`)

Defense layers:
- **Tool Policy Engine** — RBAC, rate limiting, argument validation
- **Docker Sandbox** — isolated execution environment
- **Audit Log** — complete record of all tool invocations
- **Pairing** — approval workflow for new channel users

## Data Flow

### Inbound Message Processing

```
1. Channel receives message
2. Normalize to MessageEnvelope
3. Gateway authenticates sender
4. Session store: get or create session
5. Agent runtime: assemble context
6. Provider: send to LLM
7. Tool loop (if tool calls returned)
8. Store response in transcript
9. Route response back to originating channel
```

### Memory Tool Flow

```
1. Agent calls memory_store(subject, subjectType, predicate, object, objectType)
2. Tool policy check (RBAC, rate limit)
3. KnowledgeEngine: resolve subject entity (find existing or create Individual)
4. KnowledgeEngine: resolve predicate
   - If unknown in urn:shared:ontology → register in agent-local urn:<agent>:schema
     (shared TBox stays admin-only)
5. KnowledgeEngine: resolve object entity or literal
6. SHACL validation against urn:shared:shapes
7. Insert RDF triple into the target graph (urn:<agent>:worldview / :user:<id> / ...)
   via SPARQL UPDATE — fact is immediately accepted (Truth Maintenance, no proposal step)
8. Create core:Claim in urn:<agent>:claims with status "accepted" and
   core:Evidence in urn:<agent>:evidence (source span, session, confidence, trust)
9. ConflictDetector scans for accepted Claims with same subject/predicate but other object;
   detected contradictions land in urn:<agent>:conflicts for later belief revision
10. Return confirmation with created URIs and claim ID to agent
```

## Technology Decisions

All major decisions are documented in `docs/decisions/`. Key choices:

- **TypeScript** over Python — shared types across gateway, CLI, and UI
- **Fastify** over Express — better performance, native WebSocket, schema validation
- **SQLite** over PostgreSQL — zero-config, embedded, sufficient for local use
- **Oxigraph (embedded) + Reasonable** over Fuseki — no Java dependency, in-process, easier backup/restore; Reasonable provides the OWL reasoning needed for accepted knowledge graphs
- **Named graphs + explicit Claim/Evidence objects** over RDF reification or RDF-Star — RDF-1.1-compatible, backend-portable, reasoner-friendly (the reasoner sees only accepted facts, not metadata about facts)
- **pnpm** over npm/yarn — faster, stricter, better workspace support
- **Turborepo** — parallel builds with intelligent caching

## Cognitive Architecture

The optional cognitive layer (working/episodic/procedural/semantic/self/meta memory,
the synchronous per-turn cognitive cycle, goals, metacognition) is specified and
documented in detail under [`docs/cognitive-architecture/`](./cognitive-architecture/)
(12 documents). It is additive on top of the named-graph topology and is gated behind
`cog.*` feature flags in `urn:ontofelia:setup`.
