# 03 · The cognitive cycle

> **Scope:** the six phases of one cycle, their inputs and outputs, how they
> are reified in RDF, and how impasses escalate to metacognition.

---

## 1. Cycle identity and structure

One cognitive cycle = one inbound `MessageEnvelope`. Cycle identity:

```
cycleId  = cycle_<startedAt-iso-z>_<seq-within-session>
graphs   = urn:<agent>:cog:cycles:<sessionId>          (cycle metadata)
           urn:<agent>:cog:working:<sessionId>:<cycleId>  (per-cycle WM)
```

The cycle reified:

```turtle
GRAPH <urn:ontofelia:cog:cycles:sess_2026-05-31_18-04> {
  cog:cycle_2026-05-31T18-04-32Z_001 a cogt:Cycle ;
      cogt:cycleId       "cycle_2026-05-31T18-04-32Z_001" ;
      cogt:sessionId     "sess_2026-05-31_18-04" ;
      cogt:startedAt     "2026-05-31T18:04:32Z"^^xsd:dateTime ;
      cogt:endedAt       "2026-05-31T18:04:35Z"^^xsd:dateTime ;
      cogt:triggeredBy   cog:ep_20260531_180432_001 ;
      cogt:status        "completed" ;
      cogt:hasPhase      cog:phase_2026-05-31T18-04-32Z_001_1,
                         cog:phase_2026-05-31T18-04-32Z_001_2,
                         cog:phase_2026-05-31T18-04-32Z_001_3,
                         cog:phase_2026-05-31T18-04-32Z_001_4,
                         cog:phase_2026-05-31T18-04-32Z_001_5,
                         cog:phase_2026-05-31T18-04-32Z_001_6 .
}
```

Each phase is its own `cogt:Phase` resource. Phase IDs are deterministic
(`<cycleId>_<phaseIndex>`), so a SPARQL walk across phases is
straightforward.

---

## 2. Phase 1 — Perception

**Purpose:** turn a raw `MessageEnvelope` into a structured episode and seed
working memory.

**Reads:**
- `MessageEnvelope` (channel adapter input)
- `urn:shared:ontology` (TBox for entity typing)
- `urn:<agent>:user:<userId>` (sender profile lookup)

**Writes:**
- `urn:<agent>:cog:episodic` — new `cogt:Episode`
- `urn:<agent>:cog:working:<sessionId>:<cycleId>` — `cogt:perceptionBuffer`
- `urn:<agent>:claims` + `urn:<agent>:evidence` — claim/evidence for any
  extracted facts (delegates to existing `SemanticIngestionService`)

**Subphases:**

```
1a. parse    : tokenise, channel-specific decoding
1b. NER+RE   : EntityMatcher + SemanticParser (existing)
1c. classify : intent taxonomy (question / request / chit-chat / feedback /
                command / topic-reference)
1d. episode  : write Episode record
1e. wm-seed  : populate perceptionBuffer entries (salience defaults below)
```

**Salience defaults written by perception:**

| Entry kind | Default salience | Notes |
|---|---|---|
| The message text itself | 1.0 | Always in prompt |
| Sender identity | 0.9 | High; always needed |
| Recognised entities (NER) | 0.7 per entity | Truncated to top 5 |
| Parsed claims | 0.6 | Lower; LLM may rederive |
| Intent classification | 0.8 | Routing signal |

**Example output (working memory entries):**

```turtle
GRAPH <urn:ontofelia:cog:working:sess_2026-05-31_18-04:cycle_2026-05-31T18-04-32Z_001> {
  cog:wm_001 a cogt:WorkingMemoryEntry ;
      cogt:writtenTo  cogt:perceptionBuffer ;
      cogt:writtenBy  cog:phase_2026-05-31T18-04-32Z_001_1 ;
      cogt:writtenAt  "2026-05-31T18:04:32.412Z"^^xsd:dateTime ;
      cogt:salience   "1.0"^^xsd:decimal ;
      cogt:payload    "ontofelia" ;
      cogt:entryKind  "message-text" .

  cog:wm_002 a cogt:WorkingMemoryEntry ;
      cogt:writtenTo  cogt:perceptionBuffer ;
      cogt:salience   "0.9"^^xsd:decimal ;
      cogt:payload    "sender=Alice (owner)" ;
      cogt:entryKind  "sender-id" ;
      cogt:refersTo   <urn:entity:Alice> .

  cog:wm_003 a cogt:WorkingMemoryEntry ;
      cogt:writtenTo  cogt:perceptionBuffer ;
      cogt:salience   "0.7"^^xsd:decimal ;
      cogt:payload    "entity=OntofeliaProject (resolved)" ;
      cogt:entryKind  "ner-result" ;
      cogt:refersTo   <urn:entity:OntofeliaProject> .

  cog:wm_004 a cogt:WorkingMemoryEntry ;
      cogt:writtenTo  cogt:perceptionBuffer ;
      cogt:salience   "0.8"^^xsd:decimal ;
      cogt:payload    "intent=topic-reference" ;
      cogt:entryKind  "intent" .
}
```

**Impasse paths:**
- Channel adapter returned a malformed envelope → write `cogt:Impasse` of
  kind `perception-parse-failed`, abort cycle, fall back to channel-level
  error response.
- NER threw → degrade gracefully, log impasse, continue without NER.

---

## 3. Phase 2 — Comprehension

**Purpose:** retrieve from LTM whatever is needed to act on this input.

**Reads:**
- `cog:perceptionBuffer`
- `urn:<agent>:worldview`, `urn:<agent>:user:<userId>`, `urn:shared:world`
- `urn:<agent>:cog:episodic` (prior episodes in this session, optionally
  cross-session for the same entities)
- `urn:<agent>:inferred` (materialised inferences)
- `urn:<agent>:self` (relevant capability slice — see Phase 4 too)

**Writes:**
- `cog:retrievalBuffer` — scored retrieval results

**Retrieval strategy** (deterministic, no LLM):

```
For each high-salience perception buffer entry:
  1. If it refers to a URI E:
       SELECT ?p ?o WHERE { GRAPH <worldview> { <E> ?p ?o } }   # 1-hop facts
       SELECT ?p ?o WHERE { GRAPH <user:<id>>   { <E> ?p ?o } } # 1-hop user-specific
       SELECT ?ep WHERE { GRAPH <cog:episodic>
                          { ?ep cogt:actor|cogt:about <E> ; cogt:occurredAt ?t }
                          ORDER BY DESC(?t) LIMIT 5 }
  2. If it is a parsed claim (s,p,o):
       SELECT prior claims with same s,p (regardless of o) to surface conflicts
  3. If it is an intent label:
       Map intent → typical retrieval template (e.g. "command" → fetch
       relevant procedural skills via Phase 3's procedural module).
```

Results are scored by:
```
score = recency_decay(occurredAt) * entity_overlap(entry, query) * specificity(graph)
```

with `specificity(user) > specificity(worldview) > specificity(shared:world)`.

**Example retrieval-buffer entry:**

```turtle
cog:wm_010 a cogt:WorkingMemoryEntry ;
    cogt:writtenTo  cogt:retrievalBuffer ;
    cogt:writtenBy  cog:phase_2026-05-31T18-04-32Z_001_2 ;
    cogt:salience   "0.85"^^xsd:decimal ;
    cogt:payload    "OntofeliaProject techStack: TypeScript, Oxigraph, Turbo" ;
    cogt:entryKind  "fact" ;
    cogt:sourceGraph <urn:ontofelia:worldview> ;
    cogt:retrievalScore "0.85"^^xsd:decimal ;
    cogt:refersTo   <urn:entity:OntofeliaProject> .
```

**Impasse paths:** none — empty retrieval is allowed (and informative — see
Phase 6 metacog notes).

---

## 4. Phase 3 — Goal management

**Purpose:** decide which goal this cycle serves.

**Reads:**
- `cog:perceptionBuffer` (intent)
- `cog:retrievalBuffer`
- Existing goal stack: `urn:<agent>:cog:goals:<sessionId>` +
  `urn:<agent>:cog:goals:longterm`
- `urn:<agent>:cog:procedural` (skill-summary stats for goal-type matching)

**Writes:**
- `cog:goalBuffer` — selected top goal + visible ancestors
- Updates to goal stack (push new goals, status changes)

**Decision tree:**

```
1. Are any goals in 'active' or 'blocked' status whose successCriterion the
   user just satisfied (e.g. "approve plan: ok")? → mark resolved.
2. Is there a currently-active goal whose context the user is continuing?
   (Heuristic: intent ∈ {topic-reference, follow-up}, entities overlap with
   the active goal's retrievalBuffer.) → continue that goal.
3. Does the intent imply a new goal type? (intent=command → new
   ExecuteCommand goal; intent=question with prior topic → AnswerInTopic.)
   → push new goal.
4. Else → push the implicit RespondTo goal (salience 0.5, low priority).
```

**Goal records written:**

```turtle
GRAPH <urn:ontofelia:cog:goals:sess_2026-05-31_18-04> {
  cog:goal_2026-05-31T18-04-32Z_001 a cogt:Goal ;
      cogt:goalType        cogt:RespondToUser ;
      cogt:status          "active" ;
      cogt:createdAt       "2026-05-31T18:04:32Z"^^xsd:dateTime ;
      cogt:priority        "0.9"^^xsd:decimal ;
      cogt:triggeredByEpisode cog:ep_20260531_180432_001 ;
      cogt:successCriterion "User received a coherent textual response" ;
      cogt:parentGoal      cog:goal_meta_session .

  # If the previous WriteConceptDoc goal is being continued:
  cog:goal_20260531_204900_concept a cogt:Goal ;
      cogt:goalType        cogt:WriteConceptDoc ;
      cogt:status          "active" ;
      cogt:priority        "0.95"^^xsd:decimal .
}
```

`goalBuffer` then contains the top one or two goals as WM entries with
salience 1.0 (top) and 0.7 (parents).

**Impasse paths:**
- Conflicting active goals at the same priority → push a metacognitive
  `ChooseGoal` subgoal; default outcome is "user-most-recent intent wins".

---

## 5. Phase 4 — Action selection

**Purpose:** decide what to do — usually a tool call or a textual response.

This phase wraps the existing LLM tool loop. The LLM is given a prompt
assembled deterministically from the **global workspace** — i.e. the subset of
WM with salience ≥ θ (default `θ = 0.5`).

**Reads:** all WM buffers, filtered by salience.
**Writes:** `cog:actionBuffer` with the proposal.

### 5.1 Prompt assembly function

```
prompt =
  systemHeader(self)                      ← from selfBuffer
  + goals(goalBuffer)                     ← from goalBuffer
  + retrievedFacts(retrievalBuffer)       ← from retrievalBuffer, top-K
  + perceptionContext(perceptionBuffer)   ← original message + sender
  + reflectiveNotes(metaBuffer)           ← any cross-cycle carry-over
  + history(prior cycle summaries, K)
  + currentMessage
```

The exact projection rules:

| Buffer | Projection rule | Max items |
|---|---|---|
| `selfBuffer` | All entries with salience ≥ 0.5; render as persona/capability/constraint block | 6 |
| `goalBuffer` | Top goal verbatim; parents one-line each | 3 |
| `retrievalBuffer` | Sort by `retrievalScore`, take top N=8, render as bulleted facts with source graph | 8 |
| `perceptionBuffer` | Always include message text + sender; entities if salience ≥ 0.6 | unbounded for message text |
| `metaBuffer` | Render any carry-over note as italic "previously noted: …" | 3 |

### 5.2 Action-buffer schema

```turtle
cog:wm_action_001 a cogt:WorkingMemoryEntry ;
    cogt:writtenTo  cogt:actionBuffer ;
    cogt:writtenBy  cog:phase_2026-05-31T18-04-32Z_001_4 ;
    cogt:salience   "1.0"^^xsd:decimal ;
    cogt:entryKind  "action-proposal" ;
    cogt:actionType "text-response" ;
    cogt:payload    "Snapshot Ontofelia (OpenProject, …)" ;
    cogt:forGoal    cog:goal_20260531_204900_concept .

# OR for a tool call:
cog:wm_action_002 a cogt:WorkingMemoryEntry ;
    cogt:writtenTo  cogt:actionBuffer ;
    cogt:entryKind  "action-proposal" ;
    cogt:actionType "tool-call" ;
    cogt:toolName   "mcp__opro-connector__work_packages_overview" ;
    cogt:toolArgs   "{\"identifier\":\"ontofelia\",\"api_token\":\"...\"}" ;
    cogt:forGoal    cog:goal_2026-05-31T18-04-32Z_001 .
```

### 5.3 Multiple LLM-loop iterations

The existing tool loop runs **inside** Phase 4 — each LLM call is a
sub-iteration of action-selection, not a separate phase. Tool calls within
that loop go through Phase 5 (execution) inline; multi-round tool use stays
within one cycle.

**Impasse paths:**
- LLM returns empty after fallback chain exhausted → impasse
  `action-selection-empty`, escalate to meta.
- Tool policy denied every viable tool → impasse `no-permitted-action`,
  meta-decides whether to ask the user.

---

## 6. Phase 5 — Execution

**Purpose:** execute the action selected. For tool calls this is the
existing `ToolExecutor` path
([`packages/agent-runtime/src/executor/ToolExecutor.ts:1`](../../packages/agent-runtime/src/executor/ToolExecutor.ts));
for textual responses this is the channel send path.

**Reads:** `cog:actionBuffer`.
**Writes:**
- `cog:actionBuffer.result` (success/error + payload)
- One `cogt:Episode` per tool call (`episodeType: "tool-called"`)
- One `cogt:SkillTrace` per tool call (regardless of outcome) — see
  [06](06-procedural-memory.md)
- The reply (textual) does **not** create a procedural trace, but does
  create a `cogt:Episode` of type `response-sent`.

**Impasse paths:** tool failures flow into Phase 6 as facts to learn from.

---

## 7. Phase 6 — Learning

**Purpose:** close the cycle, persist what should be learned, write the
reflective marker.

**Reads:** all WM buffers, episode trail of this cycle.
**Writes:**
- Cycle status → `completed` (or `impasse-resolved`, `aborted`)
- `cogt:ReflectiveMarker` in `urn:<agent>:cog:meta`
- Carry-over working-memory entries → next cycle's WM (high-salience or
  flagged with `cogt:carryForward true`)
- Procedural memory updates (aggregated trace summaries from this cycle)
- Goal status updates (mark resolved goals)

**Reflective marker example:**

```turtle
GRAPH <urn:ontofelia:cog:meta> {
  cog:meta_2026-05-31T18-04-32Z_001 a cogt:ReflectiveMarker ;
      cogt:reflectsOn   cog:cycle_2026-05-31T18-04-32Z_001 ;
      cogt:goalProgress "WriteConceptDoc: continued, no completion" ;
      cogt:newKnowledge "0 new facts; user message was topic-reference" ;
      cogt:uncertainty  "Low — clear continuation of prior goal" ;
      cogt:toolsUsed    "0" ;
      cogt:noted        "User used minimal input ('ontofelia'). Inferred continuation correctly per prior context." ;
      cogt:createdAt    "2026-05-31T18:04:35Z"^^xsd:dateTime .
}
```

### 7.1 Carry-over rules

Working memory is per-cycle, but selective continuity matters. An entry
carries to the next cycle's WM iff:

- It belongs to `goalBuffer` AND the goal is not resolved/abandoned, OR
- It belongs to `metaBuffer` AND has `cogt:carryForward true`, OR
- It belongs to `selfBuffer` (constant for the session).

Carry-over copies the entry with `cogt:carriedFrom` linking back, **with
salience decayed** by factor 0.7 (configurable). Other buffers are dropped.

This is the *only* memory mechanism within a session apart from LTM writes.

---

## 8. Impasses and metacognitive subcycles

Any phase may write a `cogt:Impasse` to working memory. When the cycle
manager sees one, it interrupts the normal flow and runs a **metacognitive
subcycle**:

```
Subcycle:
  S1. Meta-perception : read the impasse + the WM state at the time of impasse
  S2. Meta-retrieval  : query cog:meta for similar past impasses + procedural
                        traces of how they were resolved
  S3. Meta-decision   : choose a resolution (retry / change-goal / ask-user /
                        skip)
  S4. Resume          : write resolution to WM, jump back to the phase that
                        impassed (or abort cycle if no resolution found)
```

Subcycles cannot impasse themselves (to prevent infinite recursion); if
S3 cannot decide, the default is `ask-user` with a generated clarification
prompt.

---

## 9. End-to-end timing budget (informative)

Targets per phase on a modern Node 22 process, single agent, Oxigraph
embedded:

| Phase | Target | Hard cap |
|---|---|---|
| 1 — Perception | 50 ms | 300 ms (NER) |
| 2 — Comprehension | 80 ms | 500 ms (SPARQL) |
| 3 — Goal management | 5 ms | 50 ms |
| 4 — Action selection | LLM-bound (1–10 s) | 60 s |
| 5 — Execution | tool-bound | tool-defined |
| 6 — Learning | 30 ms | 200 ms |

Phases 1, 2, 3, 6 together must not exceed **1 s** in 95% of cycles, or the
architecture becomes the bottleneck instead of the LLM.

---

## 10. SPARQL: walk the cycle

A complete behavioural trace of one cycle, queryable:

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?phase ?idx ?started ?ended ?status WHERE {
  GRAPH <urn:ontofelia:cog:cycles:sess_2026-05-31_18-04> {
    cog:cycle_2026-05-31T18-04-32Z_001 cogt:hasPhase ?phase .
    ?phase cogt:phaseIndex ?idx ;
           cogt:startedAt  ?started ;
           cogt:endedAt    ?ended  ;
           cogt:phaseStatus ?status .
  }
} ORDER BY ?idx
```

Cross-graph trace from a goal back to the phase that proposed an action for
it, back to the WM entry, back to the episode, back to the message:

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?goal ?phase ?action ?episode ?messageText WHERE {
  GRAPH <urn:ontofelia:cog:goals:sess_2026-05-31_18-04> {
    ?goal a cogt:Goal ; cogt:status "resolved" .
  }
  GRAPH <urn:ontofelia:cog:working:sess_2026-05-31_18-04:cycle_2026-05-31T18-04-32Z_001> {
    ?actionEntry cogt:writtenTo cogt:actionBuffer ;
                 cogt:forGoal   ?goal ;
                 cogt:writtenBy ?phase ;
                 cogt:payload   ?action .
  }
  GRAPH <urn:ontofelia:cog:episodic> {
    ?episode cogt:triggers ?phase ;       # inverse of cogt:triggeredBy
             cogt:rawText  ?messageText .
  }
}
```

Continue with [`04-working-memory.md`](04-working-memory.md).
