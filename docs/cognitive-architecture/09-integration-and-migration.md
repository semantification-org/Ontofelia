# 09 · Integration and migration

> **Scope:** how this concept lands in the existing codebase. What changes,
> what is additive, what is touched at a minimum. A phased migration plan
> with rollback points.

---

## 1. Guiding constraints

- **No big-bang.** The cognitive layer is added incrementally — each phase
  delivers a runnable, testable system.
- **No regressions for users.** Existing prompt assembly, tools, channels,
  and storage paths continue to work throughout the migration.
- **One whitelist of truth.** Every new graph goes through `GraphRegistry`
  before any code can write to it.
- **Existing claim/evidence stays.** This concept only *consumes* the
  existing provenance ([`docs/knowledge-graph-concept.md` §4](../knowledge-graph-concept.md)),
  it does not redesign it.

---

## 2. Code touchpoints

Files that gain new code:

| File | Change kind | Why |
|---|---|---|
| `packages/semantic-memory/src/utils/GraphUriResolver.ts` | **Add methods** for `getCogEpisodicGraph`, `getCogProceduralGraph`, `getCogMetaGraph`, `getCogWorkingGraph`, `getCogGoalsSessionGraph`, `getCogGoalsLongtermGraph`, `getCogCyclesGraph` | URI factory |
| `packages/semantic-memory/src/utils/GraphRegistry.ts` | **Add roles** (`cog-*`), **extend `registerAgent`** to whitelist cog-fixed graphs, **add regex** for cog-parameterised graphs | Whitelist gate |
| `packages/semantic-memory/src/index.ts` | **Export** new modules | Surface API |
| `packages/semantic-memory/src/cognitive/EpisodicMemory.ts` | **New file** | Episodic LTM |
| `packages/semantic-memory/src/cognitive/ProceduralMemory.ts` | **New file** | Procedural LTM |
| `packages/semantic-memory/src/cognitive/SelfModel.ts` | **New file** (thin reader) | Self-model queries |
| `packages/agent-runtime/src/cognitive/WorkingMemory.ts` | **New file** | WM module |
| `packages/agent-runtime/src/cognitive/GoalStack.ts` | **New file** | Goal stack |
| `packages/agent-runtime/src/cognitive/Metacognition.ts` | **New file** | Metacog module |
| `packages/agent-runtime/src/cognitive/CycleManager.ts` | **New file** | Drives the six phases |
| `packages/agent-runtime/src/cognitive/PromptAssembler.ts` | **New file** | WM → prompt projection |
| `packages/agent-runtime/src/index.ts` | **Refactor** `AgentRuntime.handleMessage` to drive a cycle via `CycleManager`; existing tool loop becomes Phase 4's engine | Wiring |
| `bootstrap/` (whatever script) | **Add** TBox seeding for `cogt:` classes/predicates | Vocabulary in `urn:shared:ontology` |
| `packages/scheduler/src/` | **Add jobs** for: episodic consolidation, procedural consolidation, metacog cross-cycle scan, retention | Background |
| `apps/gateway/src/services/triplestore.ts` | **No code change** if `GraphRegistry` already routes; verify | Sanity |
| `apps/web-ui` | **Add (later)** a Debug-Panel for cycle replay | UX |
| `docs/architecture.md` | **Add a section** pointing to `docs/cognitive-architecture/` | Discoverability |

Files that do **not** change:

- `packages/providers/` — provider loop wraps the same way.
- `packages/tools/` — tools register the same way; only ToolExecutor adds
  a hook to write the skill trace.
- `packages/channels/` — channel adapters unchanged.
- `packages/security/`, `packages/sandbox/` — Tool policy/sandbox unaffected.
- `packages/session-store/` — verbatim transcripts and SQLite index stay
  as-is; episodic memory references them via `transcriptRef`.

---

## 3. Phased plan

### Phase A — Foundation (2–3 days)

Goal: every new graph exists, is whitelisted, and is empty.

1. Extend `GraphUriResolver` with the seven new helpers.
2. Extend `GraphRegistry` with new roles + register the four fixed cog
   graphs per agent + the cog-parameterised regex.
3. Bootstrap script writes the `cogt:` TBox into `urn:shared:ontology`.
4. Add `urn:shared:meta` entries (or `core:NamedGraphPattern` entries) for
   each new graph and pattern.
5. Smoke test: writing into `urn:ontofelia:cog:episodic` succeeds via
   `assertWritable`; writing into `urn:ontofelia:cog:no-such` throws
   `GraphPolicyError`.

**Rollback point:** none yet — pure additive. Disabling Phase A means
deleting the new TBox and helpers.

### Phase B — Working memory + cycle skeleton (3–4 days)

Goal: every message goes through a cycle; WM is written even though the
prompt assembler ignores it.

1. Implement `WorkingMemory` class.
2. Implement `CycleManager` with all six phases — Phases 1, 2, 6 do real
   work; Phases 3, 4, 5 call into the existing `AgentRuntime` code for
   continuity.
3. `AgentRuntime.handleMessage` becomes a thin wrapper around
   `CycleManager.runCycle(envelope)`.
4. Write one `cogt:Cycle` + 6 `cogt:Phase` resources per cycle.
5. Write perception-buffer entries; nothing reads them yet.
6. Phase 6 writes a basic reflective marker.

**Rollback point:** feature-flag `cog.cycleManagerEnabled` (default true
after stabilisation; can be flipped off to bypass cycle).

### Phase C — Episodic memory (2–3 days)

Goal: every message and tool call writes an episode.

1. Implement `EpisodicMemory` class.
2. Phase 1 writes a `message-received` episode.
3. Phase 5 writes `tool-called` / `tool-completed` / `response-sent`
   episodes (instrument `ToolExecutor`).
4. Retrieval API used by Phase 2 (episodic part).
5. Retention job stubbed (no-op in production for first 30 days).

**Rollback point:** disable Phase C → episodic writes stop; WM still
seeded from semantic-only retrieval.

### Phase D — Goals (3–4 days)

Goal: explicit goal stack drives action selection.

1. Implement `GoalStack` class.
2. Phase 3 decision tree: continue, new, or implicit `RespondToUser`.
3. Phase 4 receives goals via `goalBuffer`; the LLM tool loop now sees an
   `[Active goal]` section.
4. Phase 5 backfills `cogt:partOfGoal` on episodes.
5. Goal lifecycle transitions + long-term migration at session end.

**Rollback point:** disable Phase D → only the implicit goal is pushed; no
behavioural change.

### Phase E — Procedural memory (3–4 days)

Goal: every tool call produces a trace; suggestions surface into prompts.

1. Implement `ProceduralMemory` class.
2. `ToolExecutor` writes a `cogt:SkillTrace` per call.
3. Phase 1 (next cycle) backfills `userSatisfied` heuristics.
4. Phase 3 surfaces top-K skill suggestions into `retrievalBuffer`.
5. Consolidation job (skill summaries + sequence skills) — initially manual
   trigger, automated after one week of production data.

**Rollback point:** disable Phase E → traces stop; no skill suggestions.

### Phase F — Metacognition + impasses (3 days)

Goal: impasses are detected; metacog subcycle works; reflective markers
are rich.

1. Implement `Metacognition` class.
2. Each phase wires impasse-flagging.
3. `CycleManager` runs the subcycle on flag.
4. Phase 6 emits the full `cogt:ReflectiveMarker`.
5. Cross-cycle scan job (initial run weekly).

**Rollback point:** disable Phase F → no impasses raised; cycle behaves
like Phase B.

### Phase G — Self-model upgrade (2 days)

Goal: capabilities/constraints are queryable RDF, not config strings.

1. Migrate existing persona prose into capabilities/constraints (manual,
   one-time).
2. Phase 4 prompt assembly draws self-buffer from `SelfModel.queryFor(goalType)`.
3. Constraints feed metacog's `constraintPressure` signal.

**Rollback point:** disable Phase G → self prompt template restored.

### Phase H — Retention + consolidation jobs (2–3 days)

Goal: long-running operability.

1. Episodic retention job (cold/frozen tiers).
2. Procedural consolidation job scheduled.
3. Goal migration scheduled at session close.
4. Metacog cross-cycle scan scheduled.
5. Observability — pino logs, plus a `/cog/health` endpoint exposing
   counts per cog graph.

**Rollback point:** disable specific jobs via existing scheduler controls.

### Phase I — UI (2–4 days)

Goal: humans can see the architecture.

1. Web-UI debug panel: "show cycle" — phase timeline + buffer dump +
   action proposal.
2. "Explain this response" — walks WM → action → goal → episode.
3. Goal-list panel.
4. Episodic timeline view (filterable by entity).

This phase is independent of the others — the architecture works without
it.

---

## 4. Estimated effort

| Phase | Effort (eng-days) | Risk |
|---|---|---|
| A | 2–3 | Low |
| B | 3–4 | Med (cycle wiring touches the runtime) |
| C | 2–3 | Low |
| D | 3–4 | Med (goal logic interacts with intent) |
| E | 3–4 | Low |
| F | 3 | Med (impasse handling needs testing) |
| G | 2 | Low |
| H | 2–3 | Low |
| I | 2–4 | Low (UI; can ship later) |
| **Total** | **22–30** | |

Roughly five to six engineering weeks, assuming a single primary engineer
and review cycles in between phases.

---

## 5. Compatibility with existing concepts

| Existing concept | This concept | Resolution |
|---|---|---|
| `urn:<agent>:session:<id>` (KG concept §2) | Replaced by `urn:<agent>:cog:working:<sessionId>:<cycleId>` + `urn:<agent>:cog:goals:<sessionId>` + `urn:<agent>:cog:cycles:<sessionId>` | Migrate writers (`SemanticIngestionService` and Phase 1 writers) to the new graphs; keep the old URI valid in the registry as a deprecated alias for one release |
| `OntologyContextProvider` static graph injection | Replaced by WM-driven projection | Provider becomes one input to Phase 2 instead of a direct prompt source |
| `ReflectionRunner` (existing) | Subsumed by Metacognition + cross-cycle scan job | Move `ReflectionRunner.run()` body into `Metacognition.crossCycleScan()` |
| `KnowledgeEngine.required*Properties` (gap-detection for onboarding) | Becomes a `cogt:OnboardUser` goal-driven flow | `OnboardUser` goal pushed by Phase 3 when relevant gaps detected |
| `urn:<agent>:skills` | Stays — `Skill` (capability) layer is unchanged | Procedural memory adds a layer *above* it |

---

## 6. Migration of existing data

Most production data does **not** need migration — semantic LTM
(`worldview`, `user:<id>`, `shared:world`) stays where it is. Only the
ephemeral session graph needs handling:

```sparql
# One-off migration: existing session graphs are dropped (they were always
# ephemeral). Optionally export the last N to JSON-LD for forensic value.
PREFIX core: <urn:shared:ontology#>
SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p ?o . } FILTER(REGEX(STR(?g), "^urn:[^:]+:session:")) }
```

For each `?g`:
1. Optionally export to disk.
2. `DROP GRAPH ?g`.

Existing JSONL transcripts are untouched. New episodes will reference them
via `transcriptRef` from the next session forward; old sessions simply
have no episodic representation, which is fine.

---

## 7. Feature flags

For staged rollout (in `urn:<agent>:setup`):

```turtle
GRAPH <urn:ontofelia:setup> {
  onto:setup#Environment cog:flagCycleManager    true ;
                         cog:flagEpisodicMemory  true ;
                         cog:flagGoalStack       true ;
                         cog:flagProceduralMemory true ;
                         cog:flagMetacognition   true ;
                         cog:flagSelfModelQuery  true .
}
```

Each phase from B onward respects its flag; flipping a flag off restores
previous behaviour. This is what makes the migration safe to land
incrementally on production.

---

## 8. Testing strategy

| Layer | Test style |
|---|---|
| `GraphUriResolver` / `GraphRegistry` extensions | Vitest unit; whitelist/regex coverage |
| `WorkingMemory`, `EpisodicMemory`, `ProceduralMemory` | Vitest with `InMemoryAdapter` |
| `CycleManager` | Vitest integration: mock provider, assert all phases ran, all expected RDF written |
| End-to-end | Existing E2E suite (gateway + webchat) extended with "explain this response" assertions |
| Performance | Add a bench: cycle latency under 1000-trace, 10k-episode memory |
| Determinism | Same input → same WM contents (modulo timestamps); ensures prompt assembly is reproducible |

---

## 9. Observability

`/cog/health` returns:

```json
{
  "agent": "ontofelia",
  "graphs": {
    "cog:episodic":     { "tripleCount": 18342, "lastWrite": "2026-05-31T18:04:35Z" },
    "cog:procedural":   { "tripleCount": 1240,  "lastWrite": "2026-05-31T18:12:00Z",
                          "skillCount": 22, "sequenceSkillCount": 4 },
    "cog:goals:long":   { "active": 3, "blocked": 0, "resolved": 47, "abandoned": 2 },
    "cog:meta":         { "markerCount": 1820, "impassesLast24h": 1 }
  },
  "cycle": {
    "lastCycleId":      "cycle_2026-05-31T20-55-14Z_009",
    "meanLatencyMsLast100": 412,
    "p95LatencyMsLast100": 1187,
    "impasseRateLast100": 0.01
  }
}
```

Plus Pino structured logs at level `info` for every phase boundary, level
`warn` for every impasse, level `error` for every cycle abort.

---

## 10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| WM bloat across long sessions | Per-cycle graph drop + entry cap (§04); monitor `cog:working:*` graph count |
| Oxigraph WASM in-memory limit hit | Existing N-Quads snapshot mechanism already covers; episodic retention prevents growth |
| LLM prompt grows too large due to many WM entries | Salience threshold + buffer-render caps (§04 §5); fall back to truncation |
| Goal stack becomes a parallel system of record vs user's mental model | The user always sees the active goal in the UI; reconciliation is via explicit user "abandon" or natural drop-on-resolved |
| Procedural memory amplifies bad behaviour (suggestion → adherence → reinforcement) | `userSatisfied` signal + adherence tracking; consolidation thresholds are conservative |
| Metacognition produces too many impasses | Each impasse kind has a daily rate cap; over-cap triggers `cogt:ChronicImpasse` long-term goal instead of recurring subcycles |
| Migration of session graph breaks ongoing chats | Phase B keeps legacy URIs writable for one release; alias entries in `GraphRegistry` |

---

## 11. Acceptance criteria for "done"

This concept is considered implemented when **all** of these hold:

- [ ] Every new graph is whitelisted in `GraphRegistry`.
- [ ] Every message triggers exactly one `cogt:Cycle` with 6 `cogt:Phase`
      resources written.
- [ ] Every tool call produces a `cogt:SkillTrace`.
- [ ] Every cycle produces a `cogt:ReflectiveMarker`.
- [ ] Goal stack has ≥ 1 active goal at end of each cycle.
- [ ] Phase 4 prompt is assembled from WM (no hardcoded "always-on" graphs).
- [ ] `SelfModel.queryFor(goalType)` returns capability+constraint rows.
- [ ] `/cog/health` exposes the counts above.
- [ ] Existing tests pass.
- [ ] Documentation is updated (`docs/architecture.md` points here).

Continue with [`10-worked-example.md`](10-worked-example.md).
