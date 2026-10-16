# 08 · Metacognition and the self-model

> **Scope:** what the agent knows about itself, what it monitors about its own
> processing, how it detects impasses, and how it intervenes.

---

## 1. Two distinct things

This document covers two related but separate ideas:

- **Self-model** — *what* the agent is: identity, persona, capabilities,
  constraints, autonomy level, owner relation. Mostly **static** within a
  session (but queryable, not just templated).
- **Metacognition** — what the agent notices about *its own* processing:
  uncertainty, impasses, gaps, drift. **Dynamic** and per-cycle.

Self-model is read into every cycle; metacognition writes a marker at the
end of every cycle and watches for impasses during it.

---

## 2. Self-model — declarative shape

Lives in `urn:<agent>:self` (existing graph; this concept extends it). The
goal of the self-model is to make every assertion the agent might make about
*itself* into a SPARQL query, not a string match against a config blob.

### 2.1 Schema

```turtle
PREFIX cogt: <urn:shared:ontology#cog/>
PREFIX core: <urn:shared:ontology#>
PREFIX onto: <urn:ontofelia:>

GRAPH <urn:ontofelia:self> {
  onto:self#Ontofelia a core:Agent ;
      rdfs:label             "Ontofelia" ;
      core:language          "en" ;
      core:personality       "empathetic, curious, analytical" ;
      core:autonomyLevel     "semi-autonomous" ;
      core:greeting          "Hi! I'm Ontofelia." ;
      cogt:owner             <urn:entity:Alice> ;
      cogt:ownerRelation     "primary-user" ;
      cogt:operatesIn        <urn:env:semantification.org> ;

      # Capabilities — what the agent CAN do
      cogt:hasCapability     cog:cap_code_analysis,
                             cog:cap_doc_writing,
                             cog:cap_sparql_query,
                             cog:cap_telegram_chat ;

      # Constraints — what the agent MUST or MUST NOT do
      cogt:hasConstraint     cog:cons_no_destructive_without_approval,
                             cog:cons_no_external_data_without_consent,
                             cog:cons_no_secret_in_memory ;

      # Authority — who can override what
      cogt:authorityOver     <urn:tool:fs_read>,
                             <urn:tool:memory_store> ;
      cogt:requiresApproval  <urn:tool:fs_write>,
                             <urn:tool:exec> .
}

# Capability records
cog:cap_code_analysis a cogt:Capability ;
    rdfs:label   "Code analysis" ;
    cogt:requires "fs_read", "memory_store" ;
    cogt:relevantToGoalType cogt:CodeAnalysisGoal .

cog:cap_doc_writing a cogt:Capability ;
    rdfs:label   "Concept and architecture document writing" ;
    cogt:requires "fs_read", "fs_write" ;
    cogt:relevantToGoalType cogt:WriteConceptDoc .

# Constraint records
cog:cons_no_destructive_without_approval a cogt:Constraint ;
    rdfs:label "Destructive operations require explicit owner approval" ;
    cogt:enforcedBy "GuardianPolicy" ;
    cogt:applies   "exec", "fs_write[overwrite]", "memory_retract" .

cog:cons_no_secret_in_memory a cogt:Constraint ;
    rdfs:label "Never persist secrets in auto-memory or LTM" ;
    cogt:enforcedBy "MemorySkill" ;
    cogt:applies   "memory_store", "memory_reflect" .
```

### 2.2 Self-queries the agent runs

In Phase 4 (action selection) the system prompt is seeded from queries like
these:

```sparql
# Capabilities relevant to the active goal type
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?cap ?label WHERE {
  GRAPH <urn:ontofelia:self> {
    onto:self#Ontofelia cogt:hasCapability ?cap .
    ?cap rdfs:label              ?label ;
         cogt:relevantToGoalType cogt:WriteConceptDoc .
  }
}
```

```sparql
# Tools that need approval before this cycle uses them
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?tool WHERE {
  GRAPH <urn:ontofelia:self> {
    onto:self#Ontofelia cogt:requiresApproval ?tool .
  }
}
```

```sparql
# Constraints that apply to a tool I'm about to use
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?cons ?label WHERE {
  GRAPH <urn:ontofelia:self> {
    ?cons a cogt:Constraint ;
          rdfs:label    ?label ;
          cogt:applies  "fs_write" .
  }
}
```

This is the operational meaning of "self-aware": the agent's persona is not
a string, it's a graph it can interrogate.

### 2.3 As built: derived capabilities and constraints

Behind `cog.flagSelfModelQuery` (default off) the capability and constraint
records are **derived**, not written by hand. Seeding runs at boot and at
`/reseed-persona`, and when the flag is switched on with `/cog flag`; with the
flag off nothing is derived and the prompt does not change. Sources:

| Source | Becomes |
|---|---|
| tool registry (`ToolRegistry.list()`) | one `cogt:Capability` per tool: `cogt:requires "<tool>"`, `cogt:policyStatus`, `cogt:relevantToGoalType` by tool category |
| tool policy (`ToolPolicyEngine.describeTool`) | `cogt:policyStatus` `allowed` / `needs-approval` / `denied`; one `cogt:Constraint` (`derivedFrom "tool-policy"`) applying to every tool that is not freely usable |
| guardian policy (`GuardianPolicy.guardedTools()`) | a guarded tool the policy allows is `needs-approval`; one `cogt:Constraint` (`derivedFrom "guardian-policy"`) applying to the guarded tools |
| `onto:BehaviorDirective` individuals | one `cogt:Constraint` per **binding** directive of scope `safety`, `cogt:basedOn` the directive. Other directives are style rules the system prompt already carries |

Two vocabularies share the self graph and stay disjoint. The bootstrap persona
(subject `urn:ontofelia:core#Ontofelia`, `onto:` predicates) belongs to
`KnowledgeEngine.reseedSelf`; the self-model (subject `urn:<agent>:self#<agent>`,
`cogt:` predicates) belongs to `SelfModel`. The derivation reads the
directives and never writes the bootstrap subject. Everything it writes is on
the self-model subject or on a node under `urn:<agent>:self#derived/`:

```turtle
<urn:ontofelia:self#ontofelia>
    cogt:hasDerivedProfile <urn:ontofelia:self#derived/profile> ;
    cogt:hasCapability     <urn:ontofelia:self#derived/cap/exec> ;
    cogt:hasConstraint     <urn:ontofelia:self#derived/cons/guardian> .

<urn:ontofelia:self#derived/profile> a cogt:DerivedSelfProfile ;
    cogt:autonomyLevel  "semi-autonomous" ;       # restricted | semi-autonomous | autonomous
    cogt:ownerRelation  "approves-gated-tools" ;  # or "no-approval-required"
    cogt:owner          <urn:ontofelia:self#derived/owner> ;
    cogt:requiresApproval <urn:tool:exec>, <urn:tool:fs_write> ;
    cogt:authorityOver    <urn:tool:memory_ask> .

<urn:ontofelia:self#derived/cap/exec> a cogt:Capability ;
    cogt:requires "exec" ; cogt:policyStatus "needs-approval" ;
    cogt:derivedFrom "tool-registry" ;
    cogt:relevantToGoalType cogt:ExecuteCommand, cogt:HandleRequest, cogt:OwnerRequestedWork .
```

Deviation from the sketch in 2.1, on purpose: `requiresApproval`,
`authorityOver`, the autonomy level and the owner relation hang on the
**derived profile node**, not on the self-model subject, so a re-derivation can
replace exactly its own triples and a learned triple with the same predicate on
the subject is never deleted. Derived nodes carry no `rdfs:label` or
`rdfs:comment` (they would take part in entity resolution by label); their name
is `cogt:derivedLabel`. The legacy persona rendering skips them.

Re-derivation is one SPARQL update: the previous derived triples go and the
new ones come in. The same sources give the identical triple set, a removed
tool loses its capability and its approval entry, and hand-seeded or learned
self-model facts stay.

**Which tools need approval**, one query over the self graph (this is the
query the test runs, `SelfModel.toolsNeedingApprovalQuery()`):

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT DISTINCT ?tool WHERE {
  GRAPH <urn:ontofelia:self> {
    <urn:ontofelia:self#ontofelia> cogt:hasDerivedProfile ?profile .
    ?profile cogt:requiresApproval ?tool .
  }
} ORDER BY ?tool
```

`?tool` is `urn:tool:<percent-encoded name>`. The test compares the result with
the guardian's `guardedTools()` plus every tool for which
`ToolPolicyEngine.isAllowed` answers `requiresApproval`.

**`queryFor(goalType)` mapping** (conservative). Learned capabilities keep the
old rule: scoped to their `relevantToGoalType`, or general when unscoped.
Derived tool capabilities are never unscoped and never scoped to
`RespondToUser`, so a plain chat turn is shown the constraints only:

| Tool category | Goal types |
|---|---|
| `filesystem`, `shell` | `ExecuteCommand`, `HandleRequest`, `OwnerRequestedWork` |
| `web` | `AnswerQuestion`, `HandleRequest` |
| `memory`, `ontology` | `AnswerQuestion`, `AnswerInTopic`, `HandleRequest` |
| anything else (`media`, `channel`, `utility`, a new category) | `HandleRequest` |

Constraints are not goal-scoped and are always returned, so on a fresh install
`queryFor` returns rows for every goal type as soon as the derivation has run.

**When it is derived.** At start, when the self-model flag is switched on, on
`/reseed-persona`, after the gateway's `POST /api/ontology/reseed-self` (which the
CLI command `reseed-self` calls; the response then carries `selfModel` with the
counts, or `selfModelError`), and before a cycle when the tools or their
verdicts changed since the last derivation (a plugin, a tool the gateway
registers once the runtime is up, a removed tool): the registry is compared by a
fingerprint of name, category, verdict and description, and a change derives
again, once, before that turn. Always only with the self-model flag on. Without a
goal type (goal stack off) `queryFor` returns the capabilities that are
generally relevant and every constraint.

**What the prompt says.** Every `[Self]` line is a fixed template; store text
fills one slot and goes through `neutraliseQuoted` (built on `neutraliseLine`)
first. A row that does not fit its template is left out.

- `has tool <name> (policy: allowed | needs approval | denied by default)` —
  a statement about what the policy lets the agent attempt, not about skill.
  The status is read for the owner on a trusted channel; a non-owner on a chat
  channel may be refused more than the line says. At most eight tool lines are
  rendered, tools that are not freely usable first.
- `Some tools are denied or need the owner's approval (tool policy)`
- `Risky shell and scheduling commands need the owner's approval (guardian)`
- `Binding rule (<scope>): <directive label>`

**Constraint pressure** counts the tool calls the system refused, read from the
typed denial class the tool executor puts on a failed result:
`policy-denied` (tool policy, self-protection, unattended gate, missing
sandbox), `guardian-approval-required` (an owner approval that was not granted)
or `error` (anything else, which never counts, whatever its text says).

---

## 3. Metacognition — what it monitors

Six things, all per cycle:

| Signal | Where measured | When acted on |
|---|---|---|
| **Empty retrieval** | Phase 2 returned 0 facts above relevance θ | Phase 6 marker; future cycle considers `OnboardUser`-style probing |
| **Goal drift** | Top goal changed mid-cycle without user trigger | Phase 6 marker; escalates if 3 cycles in a row |
| **Tool churn** | > 5 tool calls in one cycle | Mid-cycle warning written to metaBuffer at call 5 |
| **Action-selection empty** | LLM returned empty text + no tool, after fallbacks | Impasse → metacog subcycle |
| **Conflict surfaced** | New `core:Conflict` arrived in retrievalBuffer | Phase 6 marker; pushes `cogt:ResolveConflict` goal |
| **Constraint pressure** | An action proposal violated a constraint and was rewritten | Phase 6 marker; tracked for capability/constraint tuning |

Each signal is one boolean or numeric attribute on the cycle's
`cogt:ReflectiveMarker`.

---

## 4. Reflective-marker schema

```turtle
PREFIX cogt: <urn:shared:ontology#cog/>

cog:meta_<cycleId> a cogt:ReflectiveMarker ;
    cogt:reflectsOn   cog:cycle_<cycleId>              ;
    cogt:createdAt    "..."^^xsd:dateTime              ;
    cogt:cycleStatus  "completed" ;                          # completed | impasse-resolved | aborted

    cogt:goalProgress "WriteConceptDoc: drafted 6/9 files this cycle" ;
    cogt:newKnowledge "0 new facts; verified existing topology" ;
    cogt:toolsUsed    7 ;
    cogt:toolErrors   0 ;

    cogt:uncertainty   "low" ;                              # low | medium | high
    cogt:emptyRetrieval false ;
    cogt:goalDrift     false ;
    cogt:toolChurn     false ;
    cogt:constraintPressure 0 ;

    cogt:flaggedImpasse cog:impasse_<id> ;                  # 0..N
    cogt:resolvedImpasse cog:impasse_<id> ;                 # 0..N

    cogt:noted        "Procedural skill 'concept_doc_writing' applied successfully." ;
    cogt:carryForward true .
```

Markers are written by Phase 6 (Learning) and live in
`urn:<agent>:cog:meta`.

---

## 5. Impasses

A **`cogt:Impasse`** is an explicit RDF resource raised when a phase cannot
complete normally.

```turtle
cog:impasse_<cycleId>_<n> a cogt:Impasse ;
    cogt:impasseKind   "action-selection-empty" ;
    cogt:flaggedInPhase cog:phase_<phaseId> ;
    cogt:flaggedAt     "..."^^xsd:dateTime ;
    cogt:context       "LLM returned empty after primary + 2 fallback models" ;
    cogt:resolution    "asked-user" ;                       # set when resolved
    cogt:resolvedAt    "..."^^xsd:dateTime ;
    cogt:resolvedBy    "metacog" .                          # metacog | user | timeout
```

### 5.1 Impasse kinds (initial)

| Kind | Triggered by |
|---|---|
| `perception-parse-failed` | Phase 1 malformed envelope |
| `comprehension-overflow` | Phase 2 retrieved > 200 candidate triples |
| `goal-conflict` | Phase 3 multiple equal-priority goals |
| `action-selection-empty` | Phase 4 LLM empty after fallbacks |
| `action-selection-refused` | Phase 4 LLM refusal pattern detected |
| `tool-policy-denied-all` | Phase 4 every viable tool denied by ToolPolicy |
| `tool-error` | Phase 5 tool returned `outcome: error` |
| `tool-timeout` | Phase 5 tool hard-timeout |
| `wm-overflow` | Phase 4/5 WM cap reached + high-salience push needed |

### 5.2 Metacognitive subcycle

When an impasse is flagged, the cycle manager runs a metacog subcycle (see
[03 §8](03-cognitive-cycle.md)):

```
S1. Meta-perception: read impasse + WM snapshot
S2. Meta-retrieval: query cog:meta for similar past impasses + their
                    resolutions; query cog:procedural for last-resort skills
S3. Meta-decision: pick a resolution from a fixed catalog
                   {retry, change-goal, ask-user, skip, abort}
S4. Resume: write resolution + jump back to the flagged phase
```

Subcycles cannot impasse — if S3 cannot decide, default is `ask-user`.

### 5.3 Resolution catalog

| Resolution | Effect |
|---|---|
| `retry` | Re-run the phase with adjusted inputs (e.g. swap LLM model) |
| `change-goal` | Set current top goal to `blocked` and push a different goal |
| `ask-user` | Generate a clarification message via channel; suspend cycle |
| `skip` | Mark the impasse `resolved-by-skip`; continue cycle without the action |
| `abort` | End cycle with `cycleStatus: aborted`; user sees graceful error |

The choice between them is **policy-driven** (lookup table by impasse kind +
recent-impasse density), not LLM-driven, so it is auditable.

---

## 6. Cross-cycle metacognition

Some signals only become meaningful over many cycles. A scheduled
background pass over `urn:<agent>:cog:meta` looks for:

1. **Recurring impasse kind.** Same impasse kind in ≥ N cycles → write a
   `cogt:ChronicImpasse` resource and surface as a long-term goal
   `cogt:ResolveChronicImpasse`.
2. **Capability gap.** Constraint pressure consistently around the same
   capability → write `cogt:CapabilityGap` and surface to the user as a
   suggestion.
3. **Drift detection.** Goal drift in > 30% of cycles in the last day →
   flag and propose tightening `OntologyContextProvider` to keep the agent
   on topic.

These produce **long-term goals** in `urn:<agent>:cog:goals:longterm` that
appear in the user's next session.

As implemented, the scan runs **per user**: every read is restricted to one
`cogt:forUser` (the owner's scope also holds records written before the key
existed), is bounded (newest 5000 rows) and compares instants, not strings. Every
record the scan writes carries the user. Nothing is aggregated across users; the
report returned to the owner covers the owner's scope only. The former
`ReflectionRunner` body (worldview triple count, conflict detection, reflection
event) lives in `reflectOnWorldview`; `ReflectionRunner.reflect` delegates to it,
and `crossCycleScan` runs it for the owner scope when given a conflict detector.
The runtime hands the weekly scan (`/cog scan`, the `cog.metacog-scan` job) the
same detector the gateway's reflection endpoint uses (`setConflictDetector`), so
the scheduled scan also runs the worldview reflection once, for the owner scope,
and no other user's scan does. Without a detector the scan skips it. The gateway
endpoint `POST /api/reasoning/reflect` is unchanged: it still calls
`ReflectionRunner.reflect`, which delegates to the same function.

---

## 7. The "I don't know" rule

A specific metacognitive rule worth calling out: if Phase 2 returns
zero relevant facts AND the intent is `question`, the agent SHOULD say so
explicitly rather than guess. This is enforceable from the metaBuffer:

```turtle
cog:wm_meta_001 a cogt:WorkingMemoryEntry ;
    cogt:writtenTo cogt:metaBuffer ;
    cogt:entryKind "reflection" ;
    cogt:salience  1.0 ;
    cogt:payload   "Retrieval was empty for entity in question. " +
                   "Acceptable answers: 'I don't know', 'never seen X', " +
                   "or an offer to retrieve from external sources." ;
    cogt:carryForward false .
```

The high salience (1.0) means it always enters the prompt, where it
nudges the LLM toward honest uncertainty rather than confabulation.

### 7.1 As implemented

- **Trigger.** The intent is `question` and Phase 2 finished cleanly (`status ok`)
  with no entry. A degraded read (`partial`, `timeout`) never triggers: a failed
  lookup is not an unknown.
- **Entry.** `metaBuffer`, kind `unknown-nudge`, salience 1.0, `carryForward
  false`, written for the sender by the queued persist. The prompt assembler
  renders it in `[Note]` as one fixed, neutral sentence (answer that you do not
  know rather than guess, or ask what is missing).
- **Owner-only canary.** In live prompt mode the nudge reaches the prompt of the
  owner only. The setup key `cog.unknownNudgeAllUsers` (boolean on the cognitive
  config subject, default false) lets it reach every user. The entry is written
  for every user either way. In shadow mode it is only recorded, for every user.
- **Flags.** Everything needs `flagMetacognition`; the prompt effect needs
  `flagWorkingMemoryPrompt` as well. With metacognition off nothing is written
  and the prompt is byte-identical.

### 7.2 Signals in the reflective marker (as implemented)

| Signal | Value |
|---|---|
| `forUser` | the user key of the cycle (also on impasses raised by the cycle) |
| `newKnowledge` | the number of facts the ingestion report stored for the message, as a string |
| `goalDrift` | the top goal differs from the previous turn's top goal (same session and user) and the turn did not cause it: neither the message's intent, nor its entities, nor a closing cue. Only with the goal stack on. The previous top goal is held in memory, so the first turn after a restart reports no drift |
| `goalProgress` | `N step update(s), M goal(s) resolved` for the cycle; absent when there are none |
| `uncertainty` | `gap` = empty retrieval AND question intent; `errors` = tool calls that ended in an error. `high` if (gap and errors >= 1) or errors >= 3; `medium` if gap or errors >= 1; else `low` |
| `conflictSurfaced` | the number of facts of the sender's own graph that were replaced during this turn |

A conflict of the turn pushes a `ResolveConflict` goal (priority 0.5, for the
sender, at most three per turn, never twice for the same fact) when the goal
stack is on. Worldview facts and changes made before the turn do not count.

The **churn warning** is a `metaBuffer` entry (kind `churn-warning`, salience
0.8, `carryForward false`) recorded when the 5th tool call of a turn starts,
once per turn, and written by the queued persist. The 5th call is counted in
the per-cycle tool sink, which the blocking and the streamed core both report
through, so a streamed turn gets the warning too, exactly once.

The **daily impasse cap** (the count after which a kind of impasse becomes a
`cogt:ChronicImpasse`) is counted per user: one user's impasses never exhaust
another's. The owner's scope also counts records written before the user key
existed.

---

## 8. Read API (TypeScript sketch)

```typescript
// packages/agent-runtime/src/cognitive/Metacognition.ts

export class Metacognition {
  constructor(
    private triplestore: TriplestoreAdapter,
    private agentId: string,
  ) {}

  metaGraphUri(): string {
    return GraphUriResolver.getCogMetaGraph(this.agentId);
  }

  // Per-cycle:
  async writeMarker(input: ReflectiveMarkerInput): Promise<MarkerId> { /* ... */ }
  async flagImpasse(input: ImpasseInput): Promise<ImpasseId> { /* ... */ }
  async resolveImpasse(impasseId: ImpasseId, resolution: Resolution, by: string): Promise<void> { /* ... */ }
  async pickResolution(kind: ImpasseKind, ctx: SubcycleContext): Promise<Resolution> { /* ... */ }

  // Cross-cycle:
  async crossCycleScan(window: { since: Date; until: Date }): Promise<MetacogReport> { /* ... */ }
}

export interface ImpasseInput {
  kind: ImpasseKind;
  flaggedInPhase: string;       // URI
  context: string;
}
export type Resolution =
  | 'retry'
  | 'change-goal'
  | 'ask-user'
  | 'skip'
  | 'abort';
```

---

## 9. Why this matters operationally

Without explicit metacognition, an agent's failure modes are silent: an
empty retrieval becomes confabulation, a tool churn becomes wasted budget,
a goal drift becomes a user frustration. Surfacing these as RDF resources
means:

- The **UI** can render "Ontofelia is uncertain because retrieval was
  empty" as a yellow-banner explanation.
- The **operator** can SPARQL across all recent cycles to find the most
  common impasse kind.
- The **agent itself** can decide to ask the user for help instead of
  faking confidence.

The investment is small (one schema, one phase, one background pass) and
the explainability benefit is large.

---

## 10. Open questions

- [ ] Should we distinguish *uncertainty about facts* from *uncertainty
      about own behaviour*? Currently both live under `cogt:uncertainty`.
      *Recommendation:* split into `cogt:factUncertainty` and
      `cogt:procUncertainty` in v2.
- [ ] How are constraint violations represented when the LLM proposes them
      *and they were caught before execution*? *Recommendation:* a new
      `cogt:RewrittenProposal` resource linking original and accepted
      versions, owned by metacog.
- [ ] Should the metacog subcycle have a hard time budget (it currently has
      none)? *Recommendation:* yes, 3 s; if exceeded, fall through to
      `ask-user`.

Continue with [`09-integration-and-migration.md`](09-integration-and-migration.md).
