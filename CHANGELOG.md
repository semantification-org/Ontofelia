# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Cognitive layer on by default for new installs.** A new install (self graph seeded in that boot, nothing else of the agent in the store) starts with every cognitive flag on except `flagRetention` and `flagInitiative`. Upgrading changes nothing: an existing install keeps its flags and opts in with the owner command `/cog defaults apply` (`/cog defaults` shows the difference first). Rollback: `/cog flag <name> off` or `/cog cycle off`; nothing is deleted by turning it off. See `docs/cognitive-architecture/09-integration-and-migration.md` section 7.

### Added
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
