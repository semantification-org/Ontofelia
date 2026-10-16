# 09 · Integration and migration

> **Scope:** how this concept lands in the existing codebase. What changes,
> what is additive, what is touched at a minimum. A phased migration plan
> with rollback points.
>
> **Implementation status (2026-10-15):** phases A to I and the later slices are
> implemented behind the flags in §7. **On by default for new installs since
> the staged default-on rollout (2026-10-15); existing installs keep their flags
> and opt in with `/cog defaults apply`; retention stays off.** A flag that is
> missing from the setup graph still counts as off, so an install that was
> running before the rollout behaves exactly as it did. §7 lists every flag with
> its default and its value on a new install, §7.1 to §7.3 describe the
> rollout, the rollback and the migration, and §12 records where the code's names
> differ from this specification.

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

For staged rollout. A flag is one boolean triple on the config subject
`<urn:<agent>:setup:cognitive>` in the setup graph `urn:<agent>:setup`
(namespace `cogt:` = `urn:shared:ontology#cog/`):

```turtle
GRAPH <urn:ontofelia:setup> {
  <urn:ontofelia:setup:cognitive> cogt:flagCycleManager   "true"^^xsd:boolean ;
                                  cogt:flagEpisodicMemory "true"^^xsd:boolean .
}
```

A missing, unparseable or unreadable triple counts as **off**. Flags are read
per message, so they toggle without a restart. The owner lists them with
`/cog flags` and sets one with `/cog flag <name> on|off` (a live owner turn);
`/cog cycle on|off` sets the cycle flag. Each flag respects the previous
behaviour when off: the legacy path runs and nothing is written.

The *Default* column is what a flag is when it has no triple (always off). The
*New install* column is what the boot step of §7.1 writes on a new install.

The thirteen feature flags (the allowlist `COGNITIVE_FLAGS` in
`CognitiveConfig.ts`; the test `CogDocsSync` keeps this table in step with it):

| Flag | Short key | Default | New install | What it switches on |
|---|---|---|---|---|
| `flagCycleManager` | `cycleManager` | off | on | Route messages through the six-phase cycle (cycle and phase records, working memory, action buffer, reflective marker). The other flags refine what the cycle does or what runs beside it. |
| `flagEpisodicMemory` | `episodicMemory` | off | on | The cycle writes episodes (messages, tools, replies, goal transitions, `impasse-flagged`, `meta-reflected`); `arm_goal` needs this. |
| `flagEpisodicRecall` | `episodicRecall` | off | on | Allow the recalled episodes and facts into the prompt; only the working-memory prompt mode renders them. The recall itself follows the cycle flag. |
| `flagGoalStack` | `goalStack` | off | on | Manage an explicit goal stack in the cycle. |
| `flagProceduralMemory` | `proceduralMemory` | off | on | Record skill traces per tool call and suggest skills. |
| `flagMetacognition` | `metacognition` | off | on | Raise impasses, write the full reflective marker and its signals. |
| `flagSelfModelQuery` | `selfModelQuery` | off | on | Add a self-model block to the prompt. |
| `flagRetention` | `retention` | off | off | Let the retention sweep tier old episodes (destructive). |
| `flagDebugPanel` | `debugPanel` | off | on | Expose the read-only inspection routes (`/api/cog/inspect/*`) and `/cog cycles`, `/cog explain`. |
| `flagPromptShadow` | `promptShadow` | off | on | Run the prompt assembler beside the normal prompt and record its output and a diff; the prompt is unchanged. |
| `flagWorkingMemoryPrompt` | `workingMemoryPrompt` | off | on | Build the cognitive prompt blocks from working memory instead of the legacy strings (wins over the shadow flag). |
| `flagInitiative` | `initiative` | off | off | Allow self-started goal wakes (kill switch for unattended work). |
| `flagEpisodicConsolidation` | `episodicConsolidation` | off | on | Daily, promote facts a user asserted in several independent episodes into that user's own graph (never the worldview). |

In live mode (`flagWorkingMemoryPrompt`) every cognitive block depends only on its
own flag and the live flag: `[Self]` on the self-model flag, `[Skills that
worked ...]` on the procedural flag, `[Recalled]` on the recall flag, `[Note]`
on metacognition. The goal stack is needed for the goal blocks only; with it off
`[Active goal]` is absent, skills are drawn from those learned without a goal
type, and `[Self]` shows the generally relevant capabilities and all constraints.
The shadow and the legacy path keep their dependency on the goal stack.

Setup keys that are **not** feature flags (same config subject, same graph):

| Key | Kind | Default | Effect |
|---|---|---|---|
| `unknownNudgeAllUsers` | boolean | `false` | The "I don't know" nudge reaches the live prompt of every user instead of the owner only. |
| `argRedactionRules` | JSON literal | built-in rules | Extra key and value patterns for argument redaction; can only add to the built-ins. |
| `salienceThreshold` | number 0..1 | `0.5` | θ of the global workspace. |
| `recalledTokenCap` | integer | `600` | Cap of the recalled block, in estimated tokens. |
| `promptTokenCap` | integer | `1200` | Cap of all cognitive prompt blocks together. |
| `workingMemoryCapacity` | integer 1..10000 | `200` | Entries per cycle graph. |
| `goalSupersedeAfterTurns` | integer 1..1000 | `10` | With the goal stack on: turns after which a competition loser that was neither chosen nor touched is abandoned. |
| `consolidationMinEpisodes` | integer 1..100 | `3` | Episodes needed to promote a fact. |
| `consolidationMinGroups` | integer 1..100 | `2` | Independent groups needed to promote a fact. |

### 7.1 Default-on for new installs

The cognitive layer is **on by default for new installs**; existing installs
are not changed. The default-on set is every flag in the table above except two:

- `flagRetention` stays off: it tiers episodes destructively (it deletes
  payloads and collapses episodes), and whether it should ever default on is an
  open decision.
- `flagInitiative` stays off: it is the only flag whose feature makes model
  calls of its own (a self-started wake runs a full model turn with no user
  message). Every other flag works with SPARQL and rules only, so the default-on
  set adds no model call per message.

The setup keys keep their defaults: `unknownNudgeAllUsers` stays `false` (the
"I don't know" nudge remains an owner-only canary), and all thresholds and caps
keep the values in the table above. With `flagWorkingMemoryPrompt` on, the
prompt gets the cognitive blocks of §7 (bounded by the caps), and
`flagPromptShadow` is inert beside it (live wins).

**Who counts as a new install.** The gateway boot writes the default set once,
in a single update together with a marker, and only when the store is fresh:

1. the self graph was seeded in this very boot (it was empty before), **and**
2. the setup graph holds no cognitive triple at all (no flag, no setup key, no
   marker), **and**
3. no other graph of the agent holds a single triple.

An install that has any data but no flag triples is an existing install, and
nothing is written. A second boot writes nothing: the self graph is no longer
fresh and the marker is there. The marker is two triples on the config subject:
`cogt:defaultsSeededAt` (the time, `xsd:dateTime`) and `cogt:defaultsVersion`
(the revision of the default-on set, currently `1`). A factory reset empties the
store, so the next boot counts as a new install again.

**Existing installs** adopt the defaults with the owner-only commands (a live
owner turn for `apply`):

- `/cog defaults` shows the default-on set next to the current flags and what
  would change. It writes nothing.
- `/cog defaults apply` turns on every default-on flag that is currently
  missing or off (that includes a flag the owner had switched off on purpose),
  never turns on `flagRetention` or `flagInitiative`, never touches a setup key,
  writes the marker, and lists every flag it changed in the reply.

### 7.2 Rollback

Every step back is one owner command and needs no restart (flags are read per
message):

- `/cog flag <name> off` turns one flag off, any of the thirteen.
- `/cog cycle off` turns the whole layer off for messages: they run on the
  legacy path again, and no new cycle, episode, skill-trace, working-memory or
  reflective record is written by a message. The other flags may stay on; they
  have no effect on messages without the cycle. A scheduled background job
  that has a flag of its own (the daily episodic consolidation) keeps running
  until that flag is off too, so turn it off as well for a full stop.
- With every flag off the system prompt is byte for byte the legacy prompt (the
  golden test `PromptGolden.test.ts` holds this for the existing-install path).

**What stays in the store after turning off.** Nothing is deleted by switching a
flag off. Episodes, goals, skill traces and skills, the reflective markers, the
self-model, cycle and working-memory graphs, and the setup triples stay as they
are, and they are read again when the flag is turned back on. They are removed
only by an explicit action: the cleanup job (`/cog cleanup`, working and cycle
graphs of finished sessions and old procedural traces), the retention sweep
(only with `flagRetention` on, which no default switches on), or a factory reset.
Note that the episodic graph holds message text of every user, so a rollback
that must also erase it needs one of those explicit actions.

### 7.3 Migration note for upgraders

- Upgrading does not change your flags. An install that has any data, or any
  cognitive triple, is an existing install, and the boot step writes nothing.
- To adopt the defaults, run `/cog defaults` to see the difference and
  `/cog defaults apply` to switch them on. To undo, see §7.2.
- A brand-new install, or one that was reset, starts with the layer on. Expect
  the cycle to write cycle records, episodes (including message text), skill
  traces and reflective markers from the first message, and the prompt to
  carry the cognitive blocks.
- `/cog health` now also reports soak metrics (§9) to help you judge the cost
  of the layer on your install before and after switching it on.

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

### Performance and the persistence model

The embedded Oxigraph adapter keeps the dataset in memory and persists it by
serialising the whole dataset to one N-Quads file (temp file, then atomic
rename). A mutating call changes the store and then awaits that flush, so the
cost of a write grows with the dataset size.

- **Coalescing.** Flushes run one at a time. If a flush is queued and has not
  started, a new write joins it instead of queueing another one. A burst of
  concurrent writes therefore costs one or two dumps instead of one per write.
- **Guarantee.** A caller's awaited promise resolves only after a flush that
  started after its own write has completed. Durability is "after the awaited
  write resolves". A crash before that point loses the in-flight writes, the
  same as before coalescing. If a flush fails, every caller that joined it gets
  the rejection and the next write tries again.
- **Limit.** Coalescing only helps writes that are in flight at the same time.
  Writers that await each write before issuing the next still pay one dump per
  write. Delaying the dump (debouncing) would not help them either without
  letting a caller's await resolve before its write is on disk, which the
  guarantee above rules out. Reducing the dumps per turn means issuing the
  turn's writes together or as fewer updates; that is a change in the writers,
  not the adapter.
- **Waves of the queued persist.** The persist of a turn writes in waves. Inside
  a wave every task first does its reads and builds its statement; then all the
  statements of the wave are issued in one synchronous pass, so they share one
  flush, and the wave resolves when all of them are on disk. Several writes of
  one helper are one update (the working-memory entries of a group, the episodes
  of the turn, the skill traces and the adherence summary, the delete and insert
  of a goal status or of an impasse resolution). A turn with every flag on is
  dumped twice or three times instead of nine or more. The order that is kept,
  and why:
  - wave 1 (working memory, cycle record, skill traces, conflict goals, shadow
    record, close mark of the previous working graph) comes before the carry-over,
    which reads this cycle's working graph and the goal stack;
  - the carry-over's own insert is written before the salience pass, which reads
    the graph as the carry left it;
  - the episodes of a turn are one chained batch, written in the order they were
    once appended one by one (goal transitions, supersession, tool calls, reply,
    initiative record, reflection): the chain (`precededBy`, sequence number) is
    read once and threaded through in memory;
  - the working-memory entries of the turn are written as groups only while they
    fit under the entry cap together (nothing is evicted then); over the cap the
    entries are written one by one so the eviction after each write decides what
    stays;
  - impasses are flagged one after the other (each flag reads how many of its
    kind exist), and the prior cycle's satisfaction back-fill precedes the
    turn's skill traces.
  A failing write is reported on its own and does not stop the others in its
  wave. If the combined episode update fails, the episodes are written one by one
  so only the failing one is lost. The stored data is the same as with one write
  at a time (`PersistWaves.test.ts` compares a scripted sequence with a reference
  taken from the sequential persist).
- **Measuring.** `scripts/bench-cog.ts --persist-only 1 --episodes N` prints
  dumps per turn, the p95 awaited turn time, and the dumps and time of a burst
  of 9 concurrent writes.

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

### Soak metrics

The owner command `/cog health` adds a `soak` object to the payload above.
It holds numbers only and no user text, and every read is bounded:

```json
"soak": {
  "windowCycles": 100,
  "persistLatencyMs": { "samples": 100, "p50": 41.2, "p95": 118.7 },
  "graphSizes": {
    "episodic": { "triples": 18342, "capped": false },
    "procedural": { "triples": 1240, "capped": false },
    "meta": { "triples": 5200, "capped": false },
    "goalsLongterm": { "triples": 310, "capped": false },
    "goalsSession": { "triples": 96, "graphs": 12, "capped": false },
    "cycles": { "triples": 40211, "graphs": 12, "capped": false },
    "working": { "triples": 9120, "graphs": 36, "capped": false }
  },
  "impasses": { "cyclesInWindow": 100, "flaggedInWindow": 1, "per100Cycles": 1 },
  "dumpsPerTurn": 1.4
}
```

- `persistLatencyMs`: p50 and p95 (nearest rank) of the time the queued persist
  of a turn took, over the newest turns of this process (at most 500 are kept,
  the window is 100 and never above 500). It is kept in memory, so it is empty
  after a restart; the values are `null` until a turn has run.
- `graphSizes`: triples per graph family, counted with `COUNT` over a `LIMIT`ed
  subquery (at most 100000 triples and 10000 graphs per family; `capped: true`
  means the number is a lower bound).
- `impasses`: of the newest cycles in the window, how many carry a reflective
  marker with an impasse, and the rate per 100 cycles (`null` with no cycles).
- `dumpsPerTurn`: mean full-dataset dumps the embedded store wrote during a
  turn's persist, from a read-only counter of the Oxigraph adapter; `null` when
  the adapter keeps no counter. It counts every dump in that time, so it is a
  little high when turns overlap or other work writes at the same time.

The unauthenticated `/api/cog/health` route does not carry the `soak` object.

The debug-panel routes `/api/cog/inspect/*` (everything except `/api/cog/health`)
need the debug-panel flag **and** the gateway bearer token, and they refuse to
serve when the gateway runs without a token requirement. The gateway has one
credential, the operator's, so the output is additionally scoped to the owner's
records (episodes, goals, cycles and working memory written for the owner, plus
records without a user key); `?scope=all` returns every user's records. Any
other `scope` value is a 400.

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

## 12. Naming decisions: the specification versus the code

Where the code's names differ from the specification, the difference is a
decision recorded here, not an oversight. Stored data is **not** migrated: a
name the code already wrote stays, unless a row says it was changed. Format:
the doc says X, the code uses Y, because Z.

**Changed to the doc's name (phase records).** Phases are written with
`cogt:hasPhase` (from the cycle), `cogt:phaseIndex` and `cogt:phaseStatus`, as
in doc 03 §1 and §10. Earlier cycles carry `cogt:ordinal` and no status; the
inspector reads both shapes, so old cycles still display, and they are not
rewritten. `cogt:partOfCycle` (the inverse link) is kept next to `hasPhase`.
`phaseStatus` is written once, after the cycle: `completed`, or `aborted` for
phases 4 and 5 (the delegated core) when the core threw. The `pending` and
`running` states of doc 10 are not written, because phases are recorded after
the fact. The cycle resource also carries `cogt:cycleId` and `cogt:sessionId`
now (doc 03 §1), which joins a cycle to its episodes.

**Kept as the code has it.**

| The doc says | The code uses | Because |
|---|---|---|
| Phase kinds `action-selection`, `execution`, `learning` (doc 00, 03) | `action`, `response`, `reflection` in `cogt:phaseKind` | Phases 3 to 5 run inside the existing runtime core, so the code names what that core does; the stored kinds are not rewritten. Index and order are the doc's. |
| `cycleId = cycle_<iso>_<seq>`, IRI `cog:cycle_...` | `cyc-<uuid>`, IRI `urn:<agent>:cog:cycle:cyc-<uuid>` | An id must be unique without a per-session counter on the reply path; every reader takes the id as it is. |
| `cogt:status` on a cycle or goal | `cogt:cycleStatus`, `cogt:goalStatus` | Already stored under these names; renaming them would need a migration. |
| `cogt:triggeredBy` from a cycle to an episode, and its inverse `cogt:triggers` | Episodes carry `cogt:cycleId` (a string); the cycle carries the same literal | The episode is written before the cycle resource exists; a literal joins them without ordering. |
| `cogt:rawText` on an episode | `cogt:payload` | Already stored under this name; a payload that looks like a credential is class-marked as secret. |
| `cogt:writtenTo cogt:actionBuffer` (an IRI) | `cogt:writtenTo "actionBuffer"` (a plain literal) | All buffers are stored and filtered as literals; an IRI would split the data. |
| Proposal attributes `actionType`, `toolArgs` as the JSON arguments; a `text-response` proposal | Entry kind tells proposal from result; `toolArgs` is a **keys-only** brief with masked paths listed; only tool calls are written | A stored argument value could be a secret; the keys are enough to explain a call, and the reply text is the `response-sent` episode. |
| The proposal is updated with its result (`actionBuffer.result`) | A separate `action-result` entry, paired by `callId`, with `outcome`, `denialClass`, `durationMs` | Working memory entries are append-only; an update would need a delete. |
| Action salience 1.0 | 0.4 | Below the default threshold: the entries are an audit trail and must not enter the prompt or push other entries out of a capped cycle. At most 25 tool calls per cycle are written. |
| `onto:setup#Environment cog:flag...` | `<urn:<agent>:setup:cognitive> cogt:flag...` | The subject and namespace the config reader uses (doc 09 §7). |
| `EpisodicMemory.record`, `walkChain` (doc 05) | `append`, `chainFrom` | Already in use by every caller; `findByGoal` exists with the doc's name. |
| Impasses of every phase become `impasse-flagged` episodes | Only impasses raised inside a cycle do; the weekly scan's chronic impasses do not | The scan has no cycle or turn goal to attach; to be revisited if the scan's findings should be recalled. |

Continue with [`10-worked-example.md`](10-worked-example.md).
