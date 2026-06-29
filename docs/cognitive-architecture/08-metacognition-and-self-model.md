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
