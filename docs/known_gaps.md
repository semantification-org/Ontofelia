# Known Gaps & Roadmap

## Implemented (Phase 0–11 + extensions)

- ✅ Monorepo structure (pnpm + Turborepo), TypeScript strict, ESM
- ✅ Core interfaces and types
- ✅ Configuration management (`@ontofelia/config`, JSON5)
- ✅ CLI with interactive onboarding, status, doctor, channel wizard, pairing
- ✅ Gateway server (Fastify 5, HTTP + WebSocket + static)
- ✅ Session store (SQLite + JSONL transcripts)
- ✅ Agent runtime with tool loop (max 100 rounds), memory injection, session management
- ✅ LLM providers: OpenRouter, OpenAI (OAuth PKCE)
- ✅ Auto-fallback to free models on LLM failure (empty response or exception)
- ✅ User-configurable fallback models (Fallback A/B in the Settings UI)
- ✅ Semantic memory (embedded Oxigraph triplestore + Reasonable, OWL reasoning; optional Fuseki backend)
- ✅ Cross-session memory (30 most recent facts on every call)
- ✅ Named graphs (user, identity, soul) with bootstrap files
- ✅ Onboarding (gap detection, gradual profile completion)
- ✅ KnowledgeEngine with entity resolution, auto-TBox extension, provenance
- ✅ Web UI (React/Vite) with chat, sessions, settings, debug panel
- ✅ Token streaming in the Web UI (token-by-token via WebSocket)
- ✅ Persistent model switching (saved in ontofelia.json5, sorted list)
- ✅ Ontofelia avatar (owl icon in chat bubbles and typing indicator)
- ✅ Per-message model info (provider + model under each bubble)
- ✅ Telegram integration (polling, pairing, inline keyboards, /model, Markdown fallback)
- ✅ Discord integration (bot API, pairing, mention gating)
- ✅ Tools: exec, fs_read/write/list, memory_*, ontology_*, datetime, calculator
- ✅ Autonomy tools: self_inspect, web_fetch, cron_manage
- ✅ /model command with in-chat model switching and Telegram buttons
- ✅ Context line in Telegram (token usage + model info)
- ✅ Cron-trigger endpoint for scheduled agent wake-ups
- ✅ Sandbox architecture (Docker + Noop)
- ✅ Skills & plugins system
- ✅ Media store + node protocol
- ✅ Ontology management + conflict detection + reflection
- ✅ Guardian layer for exec commands (confirmation via Telegram/Web UI)
- ✅ Systemd service (`ontofelia daemon install`)

## In development (priority 1)

- 🔄 Telegram BotCommands menu (slash suggestions on `/`)
- 🔄 Richer error messages listing all attempted models on a total fallback failure

## Planned (priority 2)

- 📋 Image/file intake in Telegram (photos, PDFs, voice)
- 📋 RAG / document ingestion (upload → KG index → query)
- 📋 Proactive messages (agent writes to Telegram on its own)
- 📋 Multi-user sessions (each Telegram user gets their own session)
- 📋 Web UI: memory browser and ontology visualization

## Long term (priority 3)

- 📋 HTTPS + remote access (reverse proxy, Let's Encrypt)
- 📋 Agent network (mesh communication between Ontofelia instances)
- 📋 Voice I/O (Telegram voice → Whisper STT → TTS)
- 📋 Mobile PWA
- 📋 Hybrid vector search (SPARQL + embeddings)

## Known limitations

> For detailed tracking of correctness and scaling limitations, see [Known Limitations (v0.1)](known-limitations.md).

- **Telegram Markdown:** invalid Markdown falls back to plain text (no crash, but formatting is lost)
- **OpenRouter free tier:** free models occasionally respond empty or slowly — the fallback system compensates
- **Fuseki port (legacy backend only):** on gateway restarts, zombie processes can linger on port 18787 (lsof cleanup is implemented but not 100% reliable). Affects only the optional Fuseki backend; Oxigraph is embedded and has no separate port.
- **Truth maintenance:** multi-valued facts (worksAt, hasRole, memberOf) were incorrectly superseded — fixed in rel/correctness-bugs
- **Entity resolution:** owner ↔ named person sameAs link was missing — fixed in rel/correctness-bugs
- **KG scaling:** embedded Oxigraph single-threaded writes
- **Property chains:** owl:propertyChainAxiom not yet wired in the reasoner
</content>
</invoke>
