# 01 · Reference model — modules, buffers, and the cycle

> **Scope:** the modules Ontofelia gets, what each one stores, how they
> communicate, and the shape of one cognitive cycle. This is the **conceptual
> skeleton**; concrete URIs are in [02](02-named-graph-topology.md), the
> cycle's runtime behaviour in [03](03-cognitive-cycle.md).

---

## 1. Module catalog

Eight modules. Six are **memory** modules (they hold state); two are
**process** modules (they transform state). Every module has a fixed input
buffer, a fixed output buffer, and a clear ownership of one named-graph
family.

```
                         ┌─────────────────────┐
                         │     Perception      │  (process)
                         └──────────┬──────────┘
                                    │ writes
                                    ▼
                ┌──────────────────────────────────────┐
                │           Working Memory             │  (memory)
                │   ┌────────┬────────┬─────────────┐  │
                │   │ percep │ goal   │ retrieval   │  │
                │   │ buffer │ buffer │ buffer      │  │
                │   ├────────┼────────┼─────────────┤  │
                │   │ action │ self   │ meta        │  │
                │   │ buffer │ buffer │ buffer      │  │
                │   └────────┴────────┴─────────────┘  │
                └────────┬──────────────────┬──────────┘
        reads/writes     │                  │   reads
        ┌────────────────┘                  └────────────────┐
        ▼                                                    ▼
┌────────────────┐  ┌────────────────┐  ┌─────────────────┐  ┌────────────────┐
│  Semantic LTM  │  │  Episodic LTM  │  │ Procedural LTM  │  │   Self-Model   │
│   (memory)     │  │   (memory)     │  │    (memory)     │  │    (memory)    │
└────────┬───────┘  └────────┬───────┘  └────────┬────────┘  └────────────────┘
         │                   │                   │
         │                   │                   ▼
         │                   │          ┌─────────────────┐
         │                   │          │ Action Selection│  (process)
         │                   │          └────────┬────────┘
         │                   │                   │
         │                   │                   ▼
         │                   │          ┌─────────────────┐
         │                   │          │  Goal Stack     │  (memory)
         │                   │          └─────────────────┘
         │                   │
         └───────────────────┴────────────┐
                                          ▼
                                ┌─────────────────┐
                                │  Metacognition  │  (process)
                                └─────────────────┘
```

Two notes on the picture:

- **No direct lines between LTM modules.** They never read each other
  directly; everything goes through Working Memory. This is the discipline
  that makes the agent explainable.
- **Goal Stack reads from procedural memory** (to retrieve "for this goal-
  type, the skill that worked last time") but writes from action selection
  (when a tool is chosen, the goal it served is updated).

---

## 2. Memory modules

### 2.1 Working Memory (WM)

The **only blackboard**. Every module either writes here or reads from here.
Inside WM, six **buffers** carve out areas of responsibility, mirroring ACT-R's
module-buffer model:

| Buffer | Owner module | Contents |
|---|---|---|
| `cog:perceptionBuffer` | Perception | Parsed incoming message: sender, channel, raw text, NER results, parsed claims |
| `cog:retrievalBuffer` | Semantic + Episodic LTM (jointly) | Facts retrieved this cycle, scored by relevance |
| `cog:goalBuffer` | Goal Stack | Current top goal + its parents (for prompt context) |
| `cog:actionBuffer` | Action Selection | Chosen action proposal (tool name + arguments) before execution |
| `cog:selfBuffer` | Self-Model | Persona/identity slice relevant to *this* turn (constraints, voice, owner) |
| `cog:metaBuffer` | Metacognition | Reflective notes — "I'm uncertain because…", "skip web_fetch (just used it)" |

Each buffer entry has:
- a **salience** weight `[0,1]` controlling whether it enters the prompt;
- a **timestamp** of when it was written;
- a **source** triple linking it to the cycle phase that wrote it.

**Persistence:** WM is per-cycle, but selected high-salience entries carry over
to the next cycle within the same session (e.g. an unresolved goal). The
carry-over rule is in [`04-working-memory.md`](04-working-memory.md).

### 2.2 Semantic LTM

*What is true*. Existing graphs (`worldview`, `user:<id>`, `shared:world`)
keep their roles; the cognitive layer just gives them a coherent module
identity. The semantic-LTM module is the only module that owns
`urn:<agent>:worldview`, `urn:<agent>:user:<id>`, and reads
`urn:shared:world`.

**No structural change** for this concept's first phase. The Claim/Evidence
provenance ([`docs/knowledge-graph-concept.md` §4](../knowledge-graph-concept.md))
already applies.

### 2.3 Episodic LTM (NEW)

*What happened, when, who was involved*. Each cycle produces at least one
episode; tool calls and external events also create episodes.

```turtle
GRAPH <urn:ontofelia:cog:episodic> {
  cog:ep_20260531_180432_001 a cog:Episode ;
      cog:episodeType    "message-received" ;
      cog:occurredAt     "2026-05-31T18:04:32Z"^^xsd:dateTime ;
      cog:channel        "webchat" ;
      cog:sessionId      "sess_2026-05-31_18-04" ;
      cog:cycleId        "cycle_001" ;
      cog:actor          <urn:entity:Alice> ;
      cog:rawText        "ontofelia" ;
      cog:durationMs     0 ;
      cog:precededBy     cog:ep_20260531_180401_017 ;
      cog:hasClaim       claim:20260531_180432_001 .
}
```

Distinguishing properties vs. semantic LTM:

- **Time-indexed**: every triple has `cog:occurredAt`.
- **Sequential**: `cog:precededBy` chains episodes in order; you can walk a
  conversation.
- **First-person**: subject is always something that *happened to* or *was
  done by* this agent.

### 2.4 Procedural LTM (NEW)

*What to do in this kind of situation*. Stores **skill traces**: structured
records of "for a goal of type T, the tool sequence S succeeded in K ms with
outcome O".

```turtle
GRAPH <urn:ontofelia:cog:procedural> {
  cog:trace_20260531_181200_001 a cog:SkillTrace ;
      cog:forGoalType     cog:CodeAnalysisGoal ;
      cog:toolSequence    ( "fs_list" "fs_read" "fs_read" "memory_store" ) ;
      cog:executedAt      "2026-05-31T18:12:00Z"^^xsd:dateTime ;
      cog:durationMs      4317 ;
      cog:outcome         "success" ;
      cog:supportingGoal  cog:goal_20260531_180432_002 ;
      cog:userSatisfied   true .

  cog:skill_explore_repo a cog:Skill ;
      rdfs:label          "explore_repo" ;
      cog:goalType        cog:CodeAnalysisGoal ;
      cog:successCount    7 ;
      cog:failureCount    1 ;
      cog:meanDurationMs  3842 ;
      cog:lastUsedAt      "2026-05-31T18:12:00Z"^^xsd:dateTime ;
      cog:hasTrace        cog:trace_20260531_181200_001 .
}
```

Skill traces are written by Action Selection at every tool call; the
**consolidation** job aggregates them into `cog:Skill` summaries that the goal
stack can query ("for goal-type X, what is my best-performing skill?").

### 2.5 Goal Stack (NEW)

Explicit intentions. Every cycle has at least one **top goal** (often the
implicit `RespondTo` goal). Multi-step tasks push child goals.

```turtle
GRAPH <urn:ontofelia:cog:goals> {
  cog:goal_20260531_180432_002 a cog:Goal ;
      cog:goalType       cog:RespondToUser ;
      cog:status         "active" ;
      cog:createdAt      "2026-05-31T18:04:32Z"^^xsd:dateTime ;
      cog:priority       0.9 ;
      cog:parentGoal     cog:goal_20260531_180432_001 ;
      cog:successCriterion "User received a coherent textual response" ;
      cog:triggeredByEpisode cog:ep_20260531_180432_001 ;
      cog:resolvedAt     "2026-05-31T18:04:35Z"^^xsd:dateTime .

  cog:goal_20260531_180432_003 a cog:Goal ;
      cog:goalType       cog:WriteConceptDoc ;
      cog:status         "active" ;
      cog:createdAt      "2026-05-31T20:49:00Z"^^xsd:dateTime ;
      cog:priority       0.95 ;
      cog:parentGoal     cog:goal_20260531_180432_001 ;
      cog:successCriterion "Docs written to docs/cognitive-architecture/ and reviewed" ;
      cog:deadline       "2026-06-02T00:00:00Z"^^xsd:dateTime .
}
```

States: `proposed` · `active` · `blocked` · `resolved` · `abandoned`.
Goal stack order is by (active, priority desc, createdAt desc).

### 2.6 Self-Model

Existing `urn:<agent>:self` (see
[`docs/knowledge-graph-concept.md` §2](../knowledge-graph-concept.md)) is
extended with **queryable** capability and constraint predicates:

```turtle
GRAPH <urn:ontofelia:self> {
  onto:self#Ontofelia a core:Agent ;
      rdfs:label "Ontofelia" ;
      core:personality "empathisch, neugierig, analytisch" ;
      core:language "de" ;
      cog:hasCapability cog:cap_code_analysis,
                        cog:cap_doc_writing,
                        cog:cap_sparql_query ;
      cog:hasConstraint cog:cons_no_destructive_without_approval,
                        cog:cons_no_external_data_without_consent ;
      cog:autonomyLevel "semi-autonomous" ;
      cog:owner <urn:entity:Alice> .

  cog:cap_code_analysis a cog:Capability ;
      rdfs:label "code analysis" ;
      cog:requires "fs_read", "memory_store" .

  cog:cons_no_destructive_without_approval a cog:Constraint ;
      rdfs:label "Do not run destructive ops without owner approval" ;
      cog:enforcedBy "GuardianPolicy" .
}
```

The Self-Model module exposes one read API to other modules: *"Given a goal-
type, return the relevant capabilities, constraints, and identity slice."*

---

## 3. Process modules

### 3.1 Perception

**Input:** `MessageEnvelope` from a channel adapter.
**Output:** writes to `cog:perceptionBuffer` in WM, and one `cog:Episode`
record in episodic LTM.

Subphases:
1. **Tokenise** — adopt the existing `MessageEnvelope` decoding.
2. **NER + RE** — call `EntityMatcher` and `SemanticParser`
   ([`packages/semantic-memory/src/ingestion/SemanticParser.ts`](../../packages/semantic-memory/src/ingestion/SemanticParser.ts)).
3. **Classify intent** — heuristic + LLM-light call: question? request?
   chit-chat? feedback? (One of a small fixed taxonomy.)
4. **Write episode** — single triple write + claim/evidence ([§4 KG concept](../knowledge-graph-concept.md)).
5. **Write WM** — populate `cog:perceptionBuffer`.

### 3.2 Action Selection

**Input:** reads `cog:goalBuffer`, `cog:retrievalBuffer`, `cog:selfBuffer`.
**Output:** writes `cog:actionBuffer` (proposal), then `cog:actionBuffer.result`
after execution.

Today, the LLM tool-loop in
[`packages/agent-runtime/src/index.ts:1`](../../packages/agent-runtime/src/index.ts)
*is* action selection — implicitly. The cognitive layer makes it explicit by:

- Surfacing the goal stack and self-model into the system prompt (via the
  retrieval and self buffers).
- Recording every tool proposal as a `cog:ActionProposal` (whether or not the
  LLM ends up choosing it) for procedural learning.
- Recording the chosen action's outcome as a `cog:SkillTrace`.

No replacement of the LLM is implied.

---

## 4. The cognitive cycle

One cycle = one inbound `MessageEnvelope`. Six phases, fixed order, all
synchronous. Every phase is reified as `cog:Phase` in
`urn:<agent>:cog:cycles:<sessionId>:<cycleId>`.

```
┌─────────────────────────────────────────────────────────────────┐
│                      Cycle: cycle_2026-05-31_18-04-32_001       │
│                                                                  │
│  1. perception       → perceptionBuffer + episode                │
│  2. comprehension    → retrievalBuffer (LTM lookups)             │
│  3. goal-management  → goalBuffer (push/pop/select)              │
│  4. action-selection → actionBuffer (LLM tool loop)              │
│  5. execution        → tool calls; actionBuffer.result updated   │
│  6. learning         → episode close; procedural trace; meta     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

Each phase has timing data and an explicit input/output dependency:

| Phase | Reads | Writes | Can impasse? |
|---|---|---|---|
| 1. Perception | `MessageEnvelope`, ontology | perceptionBuffer, episode | rare (parse failure → meta) |
| 2. Comprehension | perceptionBuffer, semantic LTM, episodic LTM, self-model | retrievalBuffer | no (empty retrieval is allowed) |
| 3. Goal management | retrievalBuffer, goal stack, procedural LTM | goalBuffer, goal stack | yes — no goal candidate ⇒ create default `RespondTo` |
| 4. Action selection | goalBuffer, retrievalBuffer, selfBuffer | actionBuffer | yes — LLM returns empty / refuses ⇒ fallback |
| 5. Execution | actionBuffer | tool result, episode (per call) | yes — tool errors ⇒ meta |
| 6. Learning | all of the above | procedural trace, meta marker, episode close | no |

**Impasse handling** (§7 of [03](03-cognitive-cycle.md)) is the cycle's
escape valve: any phase can declare an impasse, which kicks the cycle into a
metacognitive subcycle.

---

## 5. Data flow example (textual, one cycle)

User types "ontofelia" in webchat.

1. **Perception.**
   - Tokenise: `["ontofelia"]`.
   - NER: matches `urn:entity:OntofeliaProject` (via EntityMatcher).
   - Intent: `topic-reference` (single token, prior context = "ontofelia is
     active").
   - Writes `cog:perceptionBuffer` with the message + recognised entity.
   - Writes one `cog:Episode` to episodic LTM.

2. **Comprehension.**
   - SPARQL against `urn:ontofelia:worldview` for `urn:entity:OntofeliaProject`
     (basic facts).
   - SPARQL against `urn:ontofelia:cog:episodic` for previous episodes
     mentioning Ontofelia in this session.
   - Both go into `cog:retrievalBuffer` with relevance scores.

3. **Goal management.**
   - Goal stack inspected; previous goal `WriteConceptDoc` is still `active`
     (carried over).
   - Heuristic: the user's terse "ontofelia" is most consistent with "continue
     the prior topic". No new goal pushed. `goalBuffer` = `WriteConceptDoc`.

4. **Action selection.**
   - LLM tool loop runs with prompt assembled from buffers (see [03 §5](03-cognitive-cycle.md)).
   - LLM proposes `text` response only — no tool call.

5. **Execution.**
   - Response streamed back to webchat.

6. **Learning.**
   - `cog:ResponseSent` episode written.
   - No procedural trace (no tool used).
   - Meta marker: "carried over goal succeeded one step".

Full RDF/SPARQL trace in [`10-worked-example.md`](10-worked-example.md).

---

## 6. Module boundaries — what is *not* a module

To resist scope creep:

- **The LLM provider is not a module.** It is action selection's *engine*,
  not a memory store. Swapping providers must not require touching modules.
- **The tool registry is not procedural memory.** Tools are *capabilities*;
  procedural memory records *uses* of them.
- **Skills (in `@ontofelia/skills`) are not procedural memory.** A `Skill`
  package is a prompt-extension bundle; procedural memory tracks runtime
  outcomes.
- **The session store** (JSONL transcripts + SQLite index in
  [`packages/session-store/src/`](../../packages/session-store/src/)) is not
  episodic memory. It is a verbatim audit log; episodic memory is *structured*
  and *queryable*. Both will coexist (with episodic memory referencing
  transcript IDs).

---

## 7. Mapping to existing code (preview)

Full mapping in [`09-integration-and-migration.md`](09-integration-and-migration.md).

| Module | New code or existing? | Primary file |
|---|---|---|
| Perception | Mostly existing | `packages/semantic-memory/src/ingestion/SemanticParser.ts` + `EntityMatcher.ts` |
| Working Memory | New | `packages/agent-runtime/src/cognitive/WorkingMemory.ts` |
| Semantic LTM | Existing | `packages/semantic-memory/src/KnowledgeEngine.ts` |
| Episodic LTM | New | `packages/semantic-memory/src/cognitive/EpisodicMemory.ts` |
| Procedural LTM | New | `packages/semantic-memory/src/cognitive/ProceduralMemory.ts` |
| Goal Stack | New | `packages/agent-runtime/src/cognitive/GoalStack.ts` |
| Self-Model | Existing graph + thin reader | `packages/semantic-memory/src/cognitive/SelfModel.ts` |
| Action Selection | Existing — wrapped | `packages/agent-runtime/src/index.ts` (refactor) |
| Metacognition | New | `packages/agent-runtime/src/cognitive/Metacognition.ts` |

Continue with [`02-named-graph-topology.md`](02-named-graph-topology.md).
