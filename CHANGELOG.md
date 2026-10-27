# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Behaviour change: webhooks no longer get host tools by default.** A webhook turn now gets no host tool (`exec`, `fs_*`, `cron_manage`, `hostOnly` tools), not even with approval and not through the allow-list, exactly like a non-owner person in a chat: webhook text often comes from third parties and the answer goes back to the caller. An existing webhook that reads files or runs commands must be recreated or edited in `scheduler/webhooks.json` with `"allowHostTools": true`; new webhooks accept the field via `POST /api/webhooks` and `ontofelia webhooks create` (default off, must be a boolean). The flag is read only from the stored webhook definition, never from the request; anything but a literal `true` is off. Paired devices (nodes) are unchanged. See `docs/tools-and-security.md`, section "Who gets host tools".
- **Cognitive layer on by default for new installs.** A new install (self graph seeded in that boot, nothing else of the agent in the store) starts with every cognitive flag on except `flagRetention`, `flagInitiative` and `flagPreferenceConsolidation`. Upgrading changes nothing: an existing install keeps its flags and opts in with the owner command `/cog defaults apply` (`/cog defaults` shows the difference first). Rollback: `/cog flag <name> off` or `/cog cycle off`; nothing is deleted by turning it off. See `docs/cognitive-architecture/09-integration-and-migration.md` section 7.

### Fixed
- **An approved ontology proposal now takes effect.** Approving a proposal, rolling back and starting the gateway load the active ontology version into the graph `urn:<agent>:ontology`; before, the version only existed as a file and no reader saw it, so a declared `owl:FunctionalProperty` never changed belief revision. The functional-property check, the label lookup, the parser context, conflict detection and `ontology_inspect` read the graph. See `docs/knowledge-graph-concept.md`.
- `ontology_propose` with `autoApprove` no longer approves for every caller: it takes the verified owner in a live conversation; for anyone else the proposal stays pending and the tool result says so.
- The Oxigraph adapter's `deleteGraph` no longer fails for a graph that does not exist.
- The boot log line for the cognitive defaults names every flag that stays off, taken from the list itself.

### Added
- **Preference consolidation** (`flagPreferenceConsolidation`, off by default, not part of `/cog defaults`). A button choice a user repeated over the same alternatives (an inline-button offer and the same user's later press, Telegram) is promoted into that user's own graph as a `core:preference` fact, inside the daily `/cog consolidate-episodes` job. Needs 3 choices in 2 independent session/day groups, is blocked by a contradicting recent choice, a consistent later shift to another value withdraws the earlier preference for the same offer (belief revision, recorded as a `consolidation-superseded` episode), never touches the worldview or another user, and never counts Guardian approval buttons. See `docs/cognitive-architecture/05-episodic-memory.md` section 6.5.
- **Reasoning gate (off by default).** With the setup key `reasoning/asyncThreshold` set, `storeFact` skips the synchronous OWL materialization once the graphs the reasoner reads hold more triples than the threshold, logs the skip and marks the inferred graphs stale. A `reasoning.catchup` cron job (every five minutes, only does work when the marker is set) rebuilds the inferred graphs; `ontofelia reasoning catchup` and `POST /api/reasoning/catchup` run it now, `ontofelia reasoning gate` and `/api/reasoning/gate` show and set the threshold. Trade-off: inferred triples may be missing until the next catch-up. Without the setting nothing changes. See `docs/reasoning-gate.md`.
- `bench/inproc_bench.mjs` takes `--async-threshold=N`, times the catch-up and reports peak RSS.
- `/cog defaults` and `/cog defaults apply` (owner only).
- Soak metrics in `/cog health` (owner only): persist latency p50 and p95, graph sizes per family, impasse rate per 100 cycles, dumps per turn.

## [0.1.0] - 2026-06

### Added
- **Release Readiness (REL-1..14):**
  - Added Apache-2.0 LICENSE, CODE_OF_CONDUCT, SECURITY, CI workflows, and issue/PR templates.
  - Improved install robustness by requiring Node >= 20, rewriting the onboard/gateway quickstart, and adding `.env.example`.
  - Added runtime smoke tests.
  - Added privacy graph-isolation regression tests.
- **Guardian / Telegram Approval (OPRO #958):**
  - Dangerous tools now route to a human-in-the-loop approval flow instead of hard-deny.
  - Added Telegram Approve/Deny inline buttons.
  - Added "Approve all for this task" session auto-approve feature.

### Changed
- **Agent Autonomy:**
  - Raised `MAX_TOOL_ROUNDS` to 100 to allow multi-step tasks to complete in one turn.

### Fixed
- **Correctness Fixes:**
  - Truth-maintenance now respects `owl:FunctionalProperty`, preserving multi-valued facts.
  - Owner-to-person entity resolution correctly uses `owl:sameAs`.
- **Guardian / Telegram Approval (OPRO #958):**
  - Fixed callback handler registration via adapter.
  - Fixed `exec` tool current working directory default.
- **Agent Autonomy:**
  - Enforced "act, don't announce" behavior in system prompt.

### Security
- **Release Readiness (REL-1..14):**
  - Anonymized PII, scrubbed internal references, and updated `.gitignore` for public release.
