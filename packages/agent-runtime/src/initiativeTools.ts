/**
 * The single, shared allowlist of tools an unattended initiative cycle may use
 * (docs/initiative-architecture.md §5–§6, §8 — "notify-only tool set first, no
 * host tools"). This is the ONE source of truth consumed by BOTH enforcement
 * sites:
 *
 *  1. Advertisement filtering in `AgentRuntime.getAllowedTools` — the LLM is
 *     only shown these tools in an initiative cycle (defense in depth), and
 *  2. The EXECUTION chokepoint in `ToolExecutor.execute` — any tool NOT in this
 *     set is hard-denied when `ctx.unattended` is true, so an LLM that NAMES an
 *     unadvertised tool (e.g. memory_store — not host-only, not default-deny)
 *     still cannot run it unattended.
 *
 * Advertisement filtering is NOT a security boundary; the execution gate is.
 * Keeping this an ALLOWLIST (not a denylist) means a newly-added dangerous tool
 * cannot silently leak into unattended cycles — it must be added here on purpose.
 *
 * An initiative cycle may ONLY call `notify_owner` plus read-only / non-
 * destructive tools; it CANNOT call exec, fs_write, cron_manage, memory_store,
 * memory_retract, or ontology_propose at all in v1. The Guardian-approval queue
 * that would let an initiative cycle request such actions is a later task (§8).
 *
 * Note: memory_query is intentionally ABSENT — it is default-deny (needs
 * approval), so it is dead weight in an unattended cycle where nobody approves.
 * The read paths kept are memory_ask / memory_sparql / memory_explain.
 */
export const INITIATIVE_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'notify_owner',
  // memory read / query (no writes, no deletes, no approval-gated select)
  'memory_ask',
  'memory_sparql',
  'memory_explain',
  // read-only inspection / utility
  'ontology_inspect',
  'self_inspect',
  'web_fetch',
  'read_pdf',
  'datetime',
  'calculator',
  // filesystem READS only (never fs_write)
  'fs_read',
  'fs_list',
]);
