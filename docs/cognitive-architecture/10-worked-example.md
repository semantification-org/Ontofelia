# 10 · Worked example — one full cycle, end to end

> **Scope:** a single concrete cycle traced through every phase, with RDF
> writes, SPARQL reads, prompt fragments, and resulting episodes. This is
> what a reviewer should match against the spec.

---

## 1. Scenario

It is **2026-05-31 18:04:32 UTC**. The user (Alice, owner) is in a
webchat session with Ontofelia, having just asked Ontofelia to analyse the
Ontofelia repo (prior cycles already loaded it). The user now types a
single word:

```
ontofelia
```

This is what happens.

---

## 2. Identifiers used in this trace

| Resource | URI / Value |
|---|---|
| Agent | `ontofelia` |
| Session | `sess_2026-05-31_18-04` |
| Cycle | `cycle_2026-05-31T18-04-32Z_001` |
| WM graph | `urn:ontofelia:cog:working:sess_2026-05-31_18-04:cycle_2026-05-31T18-04-32Z_001` |
| Cycle metadata graph | `urn:ontofelia:cog:cycles:sess_2026-05-31_18-04` |
| Goals (session) | `urn:ontofelia:cog:goals:sess_2026-05-31_18-04` |
| Goals (long-term) | `urn:ontofelia:cog:goals:longterm` |
| Episodic | `urn:ontofelia:cog:episodic` |
| Procedural | `urn:ontofelia:cog:procedural` |
| Meta | `urn:ontofelia:cog:meta` |
| Self | `urn:ontofelia:self` |
| User-specific LTM | `urn:ontofelia:user:testuser` |
| Worldview LTM | `urn:ontofelia:worldview` |

Prefix declarations (omitted in code blocks for brevity):

```turtle
@prefix cog:  <urn:ontofelia:cog:> .
@prefix cogt: <urn:shared:ontology#cog/> .
@prefix core: <urn:shared:ontology#> .
@prefix onto: <urn:ontofelia:> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
```

---

## 3. Cycle bootstrap

`CycleManager.runCycle(envelope)` first writes the cycle skeleton:

```turtle
GRAPH <urn:ontofelia:cog:cycles:sess_2026-05-31_18-04> {
  cog:cycle_2026-05-31T18-04-32Z_001 a cogt:Cycle ;
      cogt:cycleId      "cycle_2026-05-31T18-04-32Z_001" ;
      cogt:sessionId    "sess_2026-05-31_18-04" ;
      cogt:startedAt    "2026-05-31T18:04:32.401Z"^^xsd:dateTime ;
      cogt:status       "running" ;
      cogt:hasPhase     cog:phase_001_1, cog:phase_001_2,
                        cog:phase_001_3, cog:phase_001_4,
                        cog:phase_001_5, cog:phase_001_6 .

  cog:phase_001_1 a cogt:Phase ; cogt:phaseIndex 1 ; cogt:phaseKind "perception"       ; cogt:phaseStatus "pending" .
  cog:phase_001_2 a cogt:Phase ; cogt:phaseIndex 2 ; cogt:phaseKind "comprehension"    ; cogt:phaseStatus "pending" .
  cog:phase_001_3 a cogt:Phase ; cogt:phaseIndex 3 ; cogt:phaseKind "goal-management"  ; cogt:phaseStatus "pending" .
  cog:phase_001_4 a cogt:Phase ; cogt:phaseIndex 4 ; cogt:phaseKind "action-selection" ; cogt:phaseStatus "pending" .
  cog:phase_001_5 a cogt:Phase ; cogt:phaseIndex 5 ; cogt:phaseKind "execution"        ; cogt:phaseStatus "pending" .
  cog:phase_001_6 a cogt:Phase ; cogt:phaseIndex 6 ; cogt:phaseKind "learning"         ; cogt:phaseStatus "pending" .
}
```

---

## 4. Phase 1 — Perception

`CycleManager` updates `cog:phase_001_1.phaseStatus = "running"` and
records `startedAt`.

### 4.1 Parse, NER, intent

- Tokenise: `["ontofelia"]`.
- NER (EntityMatcher): resolves `ontofelia` against the `urn:entity:`
  namespace; finds `<urn:entity:OntofeliaProject>` (entity already known
  from prior cycles).
- Intent classifier: rule "single token that matches a recent topic
  entity" → `topic-reference`.

### 4.2 Episode write

```turtle
GRAPH <urn:ontofelia:cog:episodic> {
  cog:ep_2026-05-31T18-04-32Z_001 a cogt:Episode ;
      cogt:episodeType   "message-received" ;
      cogt:occurredAt    "2026-05-31T18:04:32.412Z"^^xsd:dateTime ;
      cogt:cycleId       "cycle_2026-05-31T18-04-32Z_001" ;
      cogt:sessionId     "sess_2026-05-31_18-04" ;
      cogt:channel       "webchat" ;
      cogt:actor         <urn:entity:Alice> ;
      cogt:about         <urn:entity:OntofeliaProject> ;
      cogt:rawText       "ontofelia" ;
      cogt:salience      "0.6"^^xsd:decimal ;
      cogt:tags          "topic-reference", "minimal-input" ;
      cogt:transcriptRef "sess_2026-05-31_18-04.jsonl:offset_8412" .
}
```

A `core:Claim` is also written through the existing provenance pipeline
(omitted for brevity).

### 4.3 Working-memory writes

```turtle
GRAPH <urn:ontofelia:cog:working:sess_2026-05-31_18-04:cycle_2026-05-31T18-04-32Z_001> {
  cog:wm_001 a cogt:WorkingMemoryEntry ;
      cogt:writtenTo cogt:perceptionBuffer ; cogt:writtenBy cog:phase_001_1 ;
      cogt:salience "1.0"^^xsd:decimal ; cogt:entryKind "message-text" ;
      cogt:payload "ontofelia" ; cogt:writtenAt "2026-05-31T18:04:32.412Z"^^xsd:dateTime .

  cog:wm_002 a cogt:WorkingMemoryEntry ;
      cogt:writtenTo cogt:perceptionBuffer ; cogt:writtenBy cog:phase_001_1 ;
      cogt:salience "1.0"^^xsd:decimal ; cogt:entryKind "sender-id" ;
      cogt:payload "Alice (owner)" ; cogt:refersTo <urn:entity:Alice> .

  cog:wm_003 a cogt:WorkingMemoryEntry ;
      cogt:writtenTo cogt:perceptionBuffer ; cogt:writtenBy cog:phase_001_1 ;
      cogt:salience "0.7"^^xsd:decimal ; cogt:entryKind "ner-result" ;
      cogt:payload "entity=OntofeliaProject" ; cogt:refersTo <urn:entity:OntofeliaProject> .

  cog:wm_004 a cogt:WorkingMemoryEntry ;
      cogt:writtenTo cogt:perceptionBuffer ; cogt:writtenBy cog:phase_001_1 ;
      cogt:salience "0.8"^^xsd:decimal ; cogt:entryKind "intent" ;
      cogt:payload "intent=topic-reference" .
}
```

Phase 1 ends. `cog:phase_001_1.phaseStatus = "completed"`,
`endedAt = "2026-05-31T18:04:32.488Z"^^xsd:dateTime`, duration **76 ms**.

---

## 5. Phase 2 — Comprehension

Goal: retrieve from LTM whatever supports a useful next action.

### 5.1 Semantic retrieval

```sparql
SELECT ?p ?o FROM <urn:ontofelia:worldview> WHERE {
  <urn:entity:OntofeliaProject> ?p ?o .
}
```

Results (8 triples, scored). Top three:

```turtle
<urn:entity:OntofeliaProject> rdfs:label    "Ontofelia" ;
                              core:techStack "TypeScript, Oxigraph, Reasonable, Turbo" ;
                              core:repoUrl   "https://github.com/ORG/ontofelia" .
```

### 5.2 Episodic retrieval

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?ep ?when ?text ?type WHERE {
  GRAPH <urn:ontofelia:cog:episodic> {
    ?ep cogt:about      <urn:entity:OntofeliaProject> ;
        cogt:occurredAt ?when ;
        cogt:episodeType ?type ;
        cogt:rawText    ?text .
  }
} ORDER BY DESC(?when) LIMIT 5
```

Returns the last 5 episodes about `OntofeliaProject`, including the user's
prior request *"clone it and analyze the code"* and Ontofelia's analysis
response. Top result (relevance 0.92):

```turtle
cog:ep_prev_201 cogt:rawText "Snapshot Ontofelia (OpenProject) ..." ;
                cogt:episodeType "response-sent" ;
                cogt:occurredAt "2026-05-31T20:55:14Z"^^xsd:dateTime .
```

### 5.3 Retrieval-buffer writes (selection)

```turtle
GRAPH <... working ...> {
  cog:wm_010 cogt:writtenTo cogt:retrievalBuffer ; cogt:writtenBy cog:phase_001_2 ;
             cogt:entryKind "fact" ;
             cogt:salience  "0.85"^^xsd:decimal ;
             cogt:retrievalScore "0.85"^^xsd:decimal ;
             cogt:sourceGraph <urn:ontofelia:worldview> ;
             cogt:refersTo <urn:entity:OntofeliaProject> ;
             cogt:payload "techStack: TypeScript, Oxigraph, Reasonable, Turbo" .

  cog:wm_011 cogt:writtenTo cogt:retrievalBuffer ; cogt:writtenBy cog:phase_001_2 ;
             cogt:entryKind "episode-ref" ;
             cogt:salience  "0.92"^^xsd:decimal ;
             cogt:retrievalScore "0.92"^^xsd:decimal ;
             cogt:sourceGraph <urn:ontofelia:cog:episodic> ;
             cogt:refersTo cog:ep_prev_201 ;
             cogt:payload "Previously delivered snapshot of OPRO project + 0 work packages + structure analysis." .

  cog:wm_012 cogt:writtenTo cogt:retrievalBuffer ; cogt:writtenBy cog:phase_001_2 ;
             cogt:entryKind "fact" ;
             cogt:salience  "0.74"^^xsd:decimal ;
             cogt:sourceGraph <urn:ontofelia:worldview> ;
             cogt:payload "Project graphs: self, skills, worldview, schema, conflicts, claims, evidence" .
}
```

Phase 2 ends. Duration **142 ms**.

---

## 6. Phase 3 — Goal management

Current goal-stack snapshot (read):

```sparql
SELECT ?goal ?label ?priority ?status FROM <urn:ontofelia:cog:goals:longterm>
WHERE { ?goal a cogt:Goal ; cogt:goalLabel ?label ; cogt:priority ?priority ;
                            cogt:status ?status . FILTER(?status != "resolved") }
ORDER BY DESC(?priority)
```

Returns:

| URI | label | priority | status |
|---|---|---|---|
| `cog:goal_20260531_204900_concept` | Write cognitive architecture concept docs | 0.95 | active |
| `cog:goal_20260531_180432_analyze` | Analyse Ontofelia repo for the user | 0.6 | resolved |

(The analyse-repo goal resolved in cycle 20 with the snapshot.)

### 6.1 Decision

The intent is `topic-reference`, the entity overlaps with both the active
long-term goal (no) and the resolved analyse goal (yes). Heuristic:
"single-word topic mention after recent assistant message" → continuation
of *current top active* goal (`WriteConceptDoc`), NOT re-running the
analyse goal.

A child goal of `WriteConceptDoc` is pushed because the user appears to
want a context-refresh:

```turtle
GRAPH <urn:ontofelia:cog:goals:sess_2026-05-31_18-04> {
  cog:goal_2026-05-31T18-04-32Z_001 a cogt:Goal ;
      cogt:goalType        cogt:RefreshContextOnTopic ;
      cogt:goalLabel       "Refresh context on Ontofelia for the user" ;
      cogt:status          "active" ;
      cogt:priority        "0.8"^^xsd:decimal ;
      cogt:createdAt       "2026-05-31T18:04:32.612Z"^^xsd:dateTime ;
      cogt:parentGoal      cog:goal_20260531_204900_concept ;
      cogt:successCriterion "User received a concise snapshot tied to current concept work" ;
      cogt:triggeredByEpisode cog:ep_2026-05-31T18-04-32Z_001 .
}
```

### 6.2 Procedural lookup

Goal-type `RefreshContextOnTopic` has no skill summaries yet. Goal-type
`WriteConceptDoc` (the parent) does — top suggestion: `fs_read` (12×
success, 0.92 sat).

These get written into the retrieval buffer:

```turtle
GRAPH <... working ...> {
  cog:wm_020 cogt:writtenTo cogt:retrievalBuffer ; cogt:writtenBy cog:phase_001_3 ;
             cogt:entryKind "skill-suggestion" ;
             cogt:salience  "0.6"^^xsd:decimal ;
             cogt:payload "Top skill for WriteConceptDoc: fs_read (92% sat)" .
}
```

### 6.3 Goal-buffer write

```turtle
GRAPH <... working ...> {
  cog:wm_030 cogt:writtenTo cogt:goalBuffer ; cogt:writtenBy cog:phase_001_3 ;
             cogt:entryKind "goal-active" ;
             cogt:salience  "1.0"^^xsd:decimal ;
             cogt:forGoal   cog:goal_2026-05-31T18-04-32Z_001 ;
             cogt:payload   "Refresh context on Ontofelia (priority 0.80, parent: WriteConceptDoc 0.95)" .

  cog:wm_031 cogt:writtenTo cogt:goalBuffer ; cogt:writtenBy cog:phase_001_3 ;
             cogt:entryKind "goal-parent" ;
             cogt:salience  "0.7"^^xsd:decimal ;
             cogt:forGoal   cog:goal_20260531_204900_concept ;
             cogt:payload   "Parent: Write cognitive architecture concept docs (priority 0.95)" .
}
```

Phase 3 ends. Duration **8 ms**.

---

## 7. Phase 4 — Action selection

### 7.1 Self-model query

```sparql
SELECT ?cap ?cons FROM <urn:ontofelia:self> WHERE {
  OPTIONAL {
    onto:self#Ontofelia cogt:hasCapability ?cap .
    ?cap cogt:relevantToGoalType cogt:WriteConceptDoc .
  }
  OPTIONAL {
    onto:self#Ontofelia cogt:hasConstraint ?cons .
    ?cons cogt:applies "fs_read", "fs_write" .
  }
}
```

Returns one capability (`cap_doc_writing`) and one constraint
(`cons_no_destructive_without_approval`).

Written to `cog:selfBuffer`:

```turtle
GRAPH <... working ...> {
  cog:wm_040 cogt:writtenTo cogt:selfBuffer ; cogt:writtenBy cog:phase_001_4 ;
             cogt:entryKind "capability" ;
             cogt:salience  "0.6"^^xsd:decimal ;
             cogt:payload "cap_doc_writing — concept/architecture docs" .

  cog:wm_041 cogt:writtenTo cogt:selfBuffer ; cogt:writtenBy cog:phase_001_4 ;
             cogt:entryKind "constraint" ;
             cogt:salience  "0.9"^^xsd:decimal ;
             cogt:payload "no destructive ops without owner approval" .
}
```

### 7.2 Global-workspace projection

The prompt assembler runs the §04 §5.1 SPARQL with θ=0.5. Result is
rendered as:

```
[Self]
You are Ontofelia, semi-autonomous, owner Alice, language de.
Capability: cap_doc_writing — concept/architecture docs.
Constraint: no destructive ops without owner approval.

[Active goal]
Refresh context on Ontofelia (priority 0.80)
Parent: Write cognitive architecture concept docs (priority 0.95)
Success: User received a concise snapshot tied to current concept work.

[Retrieved facts]
• techStack: TypeScript, Oxigraph, Reasonable, Turbo  (urn:ontofelia:worldview)
• Project graphs: self, skills, worldview, schema, conflicts, claims,
  evidence  (urn:ontofelia:worldview)
• Top skill for WriteConceptDoc: fs_read (92% sat)
• Previously delivered snapshot of OPRO project + 0 work packages +
  structure analysis. (episodic)

[Now]
Sender: Alice (owner). Channel: webchat. Intent: topic-reference.
Message: "ontofelia"
```

### 7.3 LLM tool loop

The LLM is the existing provider; given the prompt it decides not to call
a tool — it produces a textual response continuing the concept work. The
proposal:

```turtle
GRAPH <... working ...> {
  cog:wm_050 cogt:writtenTo cogt:actionBuffer ; cogt:writtenBy cog:phase_001_4 ;
             cogt:entryKind "action-proposal" ;
             cogt:salience  "1.0"^^xsd:decimal ;
             cogt:actionType "text-response" ;
             cogt:forGoal    cog:goal_2026-05-31T18-04-32Z_001 ;
             cogt:payload    "Snapshot Ontofelia (OpenProject, via v0.3.0 MCP):\n- id: 19 ..." .
}
```

Phase 4 ends. Duration **2.3 s** (LLM-bound).

---

## 8. Phase 5 — Execution

The text response is dispatched via the webchat channel. No tool call this
cycle.

Episode written:

```turtle
GRAPH <urn:ontofelia:cog:episodic> {
  cog:ep_2026-05-31T18-04-35Z_001 a cogt:Episode ;
      cogt:episodeType "response-sent" ;
      cogt:occurredAt  "2026-05-31T18:04:35.118Z"^^xsd:dateTime ;
      cogt:precededBy  cog:ep_2026-05-31T18-04-32Z_001 ;
      cogt:cycleId     "cycle_2026-05-31T18-04-32Z_001" ;
      cogt:channel     "webchat" ;
      cogt:actor       <urn:ontofelia:self#Ontofelia> ;
      cogt:about       <urn:entity:OntofeliaProject> ;
      cogt:rawText     "Snapshot Ontofelia (OpenProject, …)" ;
      cogt:partOfGoal  cog:goal_2026-05-31T18-04-32Z_001 ;
      cogt:transcriptRef "sess_2026-05-31_18-04.jsonl:offset_8419" .
}
```

ActionBuffer result update:

```turtle
GRAPH <... working ...> {
  cog:wm_050 cogt:resultOutcome "delivered" ;
             cogt:resultAt      "2026-05-31T18:04:35.121Z"^^xsd:dateTime .
}
```

Phase 5 ends. Duration **2.7 s** (mostly stream).

---

## 9. Phase 6 — Learning

### 9.1 Goal-status update

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
WITH <urn:ontofelia:cog:goals:sess_2026-05-31_18-04>
DELETE { cog:goal_2026-05-31T18-04-32Z_001 cogt:status "active" }
INSERT { cog:goal_2026-05-31T18-04-32Z_001 cogt:status     "resolved" ;
                                           cogt:resolvedAt "2026-05-31T18:04:35.122Z"^^xsd:dateTime }
WHERE  {}
```

### 9.2 Reflective marker

```turtle
GRAPH <urn:ontofelia:cog:meta> {
  cog:meta_2026-05-31T18-04-35Z_001 a cogt:ReflectiveMarker ;
      cogt:reflectsOn   cog:cycle_2026-05-31T18-04-32Z_001 ;
      cogt:createdAt    "2026-05-31T18:04:35.125Z"^^xsd:dateTime ;
      cogt:cycleStatus  "completed" ;
      cogt:goalProgress "RefreshContextOnTopic resolved within cycle; parent WriteConceptDoc still active" ;
      cogt:newKnowledge "0 new facts; existing claim updated for OntofeliaProject (topic still warm)" ;
      cogt:toolsUsed    0 ;
      cogt:toolErrors   0 ;
      cogt:uncertainty  "low" ;
      cogt:emptyRetrieval false ;
      cogt:noted        "User pattern: minimal-input topic-reference → continuation rather than restart. Observation #3." ;
      cogt:carryForward true .
}
```

### 9.3 Carry-over to next cycle

Carried entries (decay factor 0.7):

| Entry | From | To | salience(after) |
|---|---|---|---|
| `wm_040` (capability) | cog:selfBuffer | next cycle's selfBuffer | 0.42 |
| `wm_041` (constraint) | cog:selfBuffer | next cycle's selfBuffer | 0.63 |
| `wm_031` (parent goal) | cog:goalBuffer | next cycle's goalBuffer | 0.49 |
| `wm_meta_001` (no carry on this one since not carryForward) | drop | — | — |

### 9.4 Cycle close

```turtle
GRAPH <urn:ontofelia:cog:cycles:sess_2026-05-31_18-04> {
  cog:cycle_2026-05-31T18-04-32Z_001 cogt:status   "completed" ;
                                     cogt:endedAt  "2026-05-31T18:04:35.130Z"^^xsd:dateTime ;
                                     cogt:totalMs  5083 .
}
```

The per-cycle WM graph is **dropped** after carry-over copies are made:

```sparql
DROP GRAPH <urn:ontofelia:cog:working:sess_2026-05-31_18-04:cycle_2026-05-31T18-04-32Z_001>
```

(Carried-forward entries already live in the *next* cycle's WM graph, so
nothing is lost.)

Phase 6 ends. Duration **47 ms**.

---

## 10. Total budget

| Phase | Duration |
|---|---|
| 1 — Perception | 76 ms |
| 2 — Comprehension | 142 ms |
| 3 — Goal management | 8 ms |
| 4 — Action selection | 2 320 ms (LLM) |
| 5 — Execution | 2 700 ms (stream) |
| 6 — Learning | 47 ms |
| **Total** | **5 293 ms** |

Within budget. The architecture-only overhead (1+2+3+6) is **273 ms**, well
under the 1-second target ([03 §9](03-cognitive-cycle.md)).

---

## 11. "Explain this response" query

A future debug button asks: *why did Ontofelia say that?* One SPARQL
answers it.

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?goal ?goalLabel ?fact ?factSource ?episode ?episodeText WHERE {

  # The action that was delivered:
  GRAPH ?wmGraph {
    ?action cogt:writtenTo cogt:actionBuffer ;
            cogt:actionType "text-response" ;
            cogt:forGoal    ?goal ;
            cogt:resultOutcome "delivered" .
  }

  # The goal that motivated it:
  GRAPH ?goalsGraph {
    ?goal cogt:goalLabel ?goalLabel .
  }

  # Facts that were above-threshold in WM at the time:
  GRAPH ?wmGraph {
    ?factEntry cogt:writtenTo cogt:retrievalBuffer ;
               cogt:entryKind "fact" ;
               cogt:payload   ?fact ;
               cogt:sourceGraph ?factSource ;
               cogt:salience  ?factSal .
    FILTER(?factSal >= 0.5)
  }

  # Optional: episodes brought into retrievalBuffer:
  OPTIONAL {
    GRAPH ?wmGraph {
      ?epEntry cogt:writtenTo cogt:retrievalBuffer ;
               cogt:entryKind "episode-ref" ;
               cogt:refersTo  ?episode .
    }
    GRAPH <urn:ontofelia:cog:episodic> {
      ?episode cogt:rawText ?episodeText .
    }
  }

  FILTER(STRSTARTS(STR(?wmGraph),    "urn:ontofelia:cog:working:"))
  FILTER(STRSTARTS(STR(?goalsGraph), "urn:ontofelia:cog:goals:"))
}
```

The result is a structured explanation:

> *Goal:* "Refresh context on Ontofelia" (priority 0.80)
> *Facts used:*
> – techStack: TypeScript, Oxigraph, Reasonable, Turbo (worldview)
> – Project graphs: self, skills, worldview, schema, conflicts, claims,
>   evidence (worldview)
> *Episode used:* "Snapshot Ontofelia (OpenProject) — 0 work packages,
> structure analysis" (yesterday's response).

That is what a cognitive architecture buys you: every behaviour traceable
to its causes.

---

## 12. What this trace does *not* show

To keep this example focused, the following are omitted but should be
verified during implementation:

- The `core:Claim` writes that accompany every WM entry that carries a new
  fact.
- The `cogt:SkillTrace` writes — none in this cycle because no tool was
  called.
- The full Phase 4 LLM provider call (request/response bodies).
- The `cog:phase_001_*` `cogt:phaseInput` / `cogt:phaseOutput` triples;
  conceptually they link to the WM entry IDs above.
- The procedural-suggestion adherence flag (omitted because no tool was
  called).
- The cross-cycle carry-over arriving at the *next* cycle's WM graph.

A reviewer should ask: "does my reading of [03] and [04] predict exactly
this trace?" If yes, the spec is internally consistent.

---

Return to [`README.md`](README.md) for navigation.
