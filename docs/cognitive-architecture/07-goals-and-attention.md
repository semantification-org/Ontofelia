# 07 · Goals and attention

> **Scope:** the goal stack, goal types, success criteria, priority and
> deadlines, and how attention/salience is steered by the active goal.

---

## 1. Why goals must be explicit

An LLM agent without an explicit goal representation has goals only
*implicitly* — they live in the prompt as imperative sentences ("you are
helping the user with X"). This breaks three things:

1. **Interruption.** If a multi-step task is interrupted by a chit-chat
   message, the implicit goal is lost on the next turn.
2. **Conflict resolution.** When the user pursues two goals at once, the
   agent cannot reason about which to prioritise — both are just prompt
   text.
3. **Learning.** Without a goal type label, procedural memory cannot
   index "what worked for this kind of goal".

Making goals first-class RDF resources solves all three.

---

## 2. Goal schema

```turtle
PREFIX cogt: <urn:shared:ontology#cog/>

cog:goal_<utc-iso>_<seq> a cogt:Goal ;
    cogt:goalId        "goal_2026-05-31T20-49-00Z_001"   ;     # required
    cogt:goalType      cogt:WriteConceptDoc               ;     # required, URI in vocab
    cogt:goalLabel     "Write cognitive architecture concept docs" ; # required, human-readable
    cogt:status        "active"                           ;     # required, see §3
    cogt:priority      "0.95"^^xsd:decimal                ;     # required, [0,1]
    cogt:createdAt     "2026-05-31T20:49:00Z"^^xsd:dateTime ;
    cogt:updatedAt     "2026-05-31T20:55:14Z"^^xsd:dateTime ;
    cogt:resolvedAt    ""                                 ;     # set when status → resolved
    cogt:abandonedAt   ""                                 ;     # set when status → abandoned

    cogt:successCriterion "MD files in docs/cognitive-architecture/ pass owner review" ;
    cogt:successMetric    "cogt:OwnerReviewApproved"     ;     # optional, machine-checkable
    cogt:deadline         "2026-06-02T00:00:00Z"^^xsd:dateTime ; # optional

    cogt:parentGoal       cog:goal_meta_session           ;     # optional, parent in stack
    cogt:rootGoal         cog:goal_meta_session           ;     # convenience, walk-cache

    cogt:triggeredByEpisode cog:ep_2026-05-31T20-49-00Z_001 ;
    cogt:triggeredByUser    <urn:entity:Alice>          ;

    cogt:plannedSteps "Outline → Draft modules → Worked example → Review" ;
    cogt:currentStep   "Draft modules" ;
    cogt:stepProgress  "5/8" ;

    cogt:owner         <urn:entity:Alice>               ;     # who cares about this
    cogt:assignee      <urn:ontofelia:self#Ontofelia>     ;     # who is acting

    cogt:tags          "documentation", "architecture", "concept" .
```

### 2.1 Two URIs you'll see

- `cogt:Goal` — the class.
- `cogt:GoalType` — a *subclass marker* for an entire family. Specific goal
  types subclass it: `cogt:WriteConceptDoc rdfs:subClassOf cogt:GoalType`.
  This is what procedural memory keys on.

### 2.2 Initial goal-type taxonomy (extensible)

| Goal type | Trigger | Notes |
|---|---|---|
| `cogt:RespondToUser` | Every cycle (implicit, low priority) | Always present unless overridden |
| `cogt:AnswerQuestion` | intent=question | Q&A with retrieval |
| `cogt:ExecuteCommand` | intent=command | Tool invocation likely |
| `cogt:WriteConceptDoc` | User asks for documentation | Multi-cycle |
| `cogt:CodeAnalysisGoal` | User asks to read/explain code | Multi-cycle, lots of fs_read |
| `cogt:DebugIssue` | Error context | Bias toward fs_read + curl |
| `cogt:CompletePlan` | User approves a previously proposed plan | Stepwise |
| `cogt:OnboardUser` | New session, missing user profile | Gap-driven |
| `cogt:ResolveConflict` | `urn:<agent>:conflicts` non-empty | Triggered by metacog |
| `cogt:ConsolidateMemory` | Background only | Not user-triggered |

The taxonomy is meant to grow; every new goal type is a triple in
`urn:shared:ontology` (TBox), reviewable.

---

## 3. Status lifecycle

```
                  proposed
                     │
                     ▼
                  active
                ┌───┼───┐
                │   │   │
              ▼     ▼     ▼
        blocked  resolved abandoned
            │
            ▼
        active (when unblocked)
```

| Status | Meaning | Set by |
|---|---|---|
| `proposed` | Considered but not yet committed (e.g. impasse proposing a new goal) | Goal management or metacog |
| `active` | Currently being pursued | Goal management |
| `blocked` | Waiting on external event (user reply, tool output, deadline) | Goal management |
| `resolved` | Success criterion met | Goal management or metacog |
| `abandoned` | Explicitly dropped (user said "no", deadline passed, etc.) | Goal management, user, or metacog |

Transitions are recorded as `cogt:Episode`s of type `goal-pushed`,
`goal-resolved`, etc., so the history is queryable.

---

## 4. The stack

A "stack" is a convenient mental model; the actual structure is a **forest**:
every goal has a `cogt:parentGoal` (optional), and the runtime selects the
**top active goal** via ordering:

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?goal ?priority ?created WHERE {
  GRAPH ?g {
    ?goal a cogt:Goal ;
          cogt:status   "active" ;
          cogt:priority ?priority ;
          cogt:createdAt ?created .
  }
  FILTER(?g IN (
    <urn:ontofelia:cog:goals:sess_2026-05-31_18-04>,
    <urn:ontofelia:cog:goals:longterm>
  ))
}
ORDER BY DESC(?priority) DESC(?created)
LIMIT 1
```

### 4.1 Long-term goals

A goal whose deadline exceeds the session boundary, **or** that has explicit
flag `cogt:longTerm true`, migrates from `cog:goals:<session>` to
`cog:goals:longterm` at session end. The migration preserves URI and
provenance — it is just a graph move (existing GraphRegistry `assertWritable`
covers both targets).

---

## 5. Goal creation rules

Goals can be created by:

| Source | Pattern | Example |
|---|---|---|
| Perception (Phase 1) | Inbound intent maps to a goal type with a templated label | "explain X" → `AnswerQuestion` |
| Goal management (Phase 3) | Decomposing a parent goal into child goals (planning) | `WriteConceptDoc` splits into per-doc child goals |
| Metacognition | An impasse needs a goal to resolve it | `ResolveImpasse(action-selection-empty)` |
| Background | Scheduled consolidation jobs are themselves `cogt:ConsolidateMemory` goals | Daily run |
| User (explicit) | The user writes "remember to check X tomorrow" | Goal pushed with deadline |

### 5.1 Default `RespondToUser`

Every cycle has at least an implicit `RespondToUser` goal at priority 0.5,
created if no other goal is active. It is the safety net.

### 5.2 Child-goal decomposition

When a goal has `plannedSteps` populated, the goal manager can push one
child goal per step (with status `proposed`) and activate them sequentially:

```turtle
cog:goal_concept_overview a cogt:Goal ;
    cogt:goalType    cogt:WriteConceptSection ;
    cogt:parentGoal  cog:goal_20260531_204900_concept ;
    cogt:goalLabel   "Write 00-overview.md" ;
    cogt:status      "resolved" ;
    cogt:resolvedAt  "2026-05-31T20:55:00Z"^^xsd:dateTime .

cog:goal_concept_model a cogt:Goal ;
    cogt:goalType    cogt:WriteConceptSection ;
    cogt:parentGoal  cog:goal_20260531_204900_concept ;
    cogt:goalLabel   "Write 01-reference-model.md" ;
    cogt:status      "active" .

# parent goal status is derived: resolved iff all children resolved,
# blocked iff any child blocked, etc.
```

---

## 6. Attention — how goals steer salience

The goal-management phase performs two operations on WM each cycle:

### 6.1 Salience boost

Working-memory entries that `cogt:refersTo` an entity the active goal is
**about** get a salience bump:

```
For each WM entry e with refersTo == E:
  if E in entitiesOf(activeGoal):
    e.salience = min(1.0, e.salience + 0.2)
```

`entitiesOf(goal)` is computed from the goal's triggering episode plus its
`plannedSteps` and `currentStep` (parsed for entity references).

### 6.2 Salience suppression

Entries that refer to entities **not** in any active goal *and* that have
been carried across more than one cycle get a damping:

```
For each WM entry e with carriedFrom set:
  if e.refersTo NOT IN union(entitiesOf(every active goal)):
    e.salience *= 0.7
```

This is the analogue of attentional drift: stale, unfocused material fades.

### 6.3 The result: focus

These two rules together produce an emergent property: the prompt
concentrates on entities the agent currently cares about, without the prompt-
assembly code knowing anything about the goal contents. All it does is
project `salience ≥ θ`.

---

## 7. Goal-stack queries the agent uses

### 7.1 What am I doing right now?

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?goal ?label ?priority ?step WHERE {
  GRAPH ?g {
    ?goal a cogt:Goal ;
          cogt:status      "active" ;
          cogt:goalLabel   ?label ;
          cogt:priority    ?priority .
    OPTIONAL { ?goal cogt:currentStep ?step . }
  }
  FILTER(?g IN (<urn:ontofelia:cog:goals:sess_2026-05-31_18-04>,
                 <urn:ontofelia:cog:goals:longterm>))
}
ORDER BY DESC(?priority)
```

### 7.2 What's blocked on me?

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?goal ?label ?reason WHERE {
  GRAPH ?g {
    ?goal a cogt:Goal ;
          cogt:status      "blocked" ;
          cogt:goalLabel   ?label .
    OPTIONAL { ?goal cogt:blockedReason ?reason . }
  }
  FILTER(?g IN (<urn:ontofelia:cog:goals:sess_2026-05-31_18-04>,
                 <urn:ontofelia:cog:goals:longterm>))
}
```

### 7.3 What did I get done today?

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?goal ?label ?resolved WHERE {
  GRAPH <urn:ontofelia:cog:goals:longterm> {
    ?goal a cogt:Goal ;
          cogt:status      "resolved" ;
          cogt:goalLabel   ?label ;
          cogt:resolvedAt  ?resolved .
    FILTER(?resolved >= "2026-05-31T00:00:00Z"^^xsd:dateTime)
  }
}
ORDER BY DESC(?resolved)
```

### 7.4 Have I tried this goal type before?

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?goal ?status ?resolved WHERE {
  GRAPH ?g {
    ?goal a cogt:Goal ;
          cogt:goalType cogt:WriteConceptDoc ;
          cogt:status   ?status ;
          cogt:resolvedAt ?resolved .
  }
  FILTER(?g IN (<urn:ontofelia:cog:goals:longterm>,
                 <urn:ontofelia:cog:goals:sess_2026-05-31_18-04>))
}
ORDER BY DESC(?resolved)
```

---

## 8. Read/write API (TypeScript sketch)

```typescript
// packages/agent-runtime/src/cognitive/GoalStack.ts

export class GoalStack {
  constructor(
    private triplestore: TriplestoreAdapter,
    private agentId: string,
    private sessionId: string,
  ) {}

  sessionGraphUri(): string {
    return GraphUriResolver.getCogGoalsSessionGraph(this.agentId, this.sessionId);
  }
  longtermGraphUri(): string {
    return GraphUriResolver.getCogGoalsLongtermGraph(this.agentId);
  }

  async push(input: GoalInput): Promise<GoalId> { /* ... */ }
  async setStatus(goalId: GoalId, status: GoalStatus, reason?: string): Promise<void> { /* ... */ }
  async setStep(goalId: GoalId, currentStep: string, progress?: string): Promise<void> { /* ... */ }
  async top(): Promise<Goal | null> { /* ... */ }
  async active(): Promise<Goal[]> { /* ... */ }
  async migrateLongterm(): Promise<number> { /* session-end migration */ }
}

export interface GoalInput {
  goalType: string;            // URI
  goalLabel: string;
  priority: number;            // [0,1]
  successCriterion?: string;
  successMetric?: string;
  deadline?: Date;
  parentGoal?: GoalId;
  triggeredByEpisode?: string; // URI
  triggeredByUser?: string;    // URI
  owner?: string;              // URI
  assignee?: string;           // URI
  tags?: string[];
  plannedSteps?: string;
  longTerm?: boolean;
}
```

---

## 9. Open questions

- [ ] Should the goal stack support **OR-choices** (any-of)? Useful for
      planning but adds complexity. *Recommendation:* defer; encode OR as
      sibling goals with an explicit `cogt:choiceGroup` URI.
- [ ] Should priority decay over time (older active goals lose priority)?
      *Recommendation:* yes, mild — `priority(t) = priority(0) * 0.95^days`,
      computed in queries via SPARQL `?priority` term — not persisted.
- [ ] How should the agent signal to the user that a long-term goal is
      stale? *Recommendation:* metacog produces a `cogt:stalenessWarning`
      reflective marker → enters next-cycle metaBuffer → surfaces in prompt.

## 10. Implementation notes: lifecycle and episodes (goal stack flag on)

Everything below applies only while `flagGoalStack` is on; with it off no goal
is read or written.

**Goal types.** Registered in the TBox as subclasses of `cogt:GoalType`:
`RespondToUser` (implicit), `AnswerQuestion`, `ExecuteCommand`, `HandleRequest`,
`AnswerInTopic`, `OwnerRequestedWork`, plus the reserved `ResolveConflict` and
`CompletePlan` (never created yet).

| Perception intent | Goal created |
|---|---|
| question | `AnswerQuestion` |
| command | `ExecuteCommand` |
| request | `HandleRequest` |
| topic-reference | `AnswerInTopic` |
| chit-chat, feedback | none (the implicit `RespondToUser` goal serves the turn) |

**Decision tree, steps 1-2 (per turn, over the sender's own goals only).**

1. A satisfaction cue resolves the top goal, a cancel cue abandons it. The cue
   lists live in `GoalLifecycle.ts` (`SATISFACTION_CUES`, `CANCEL_CUES`). A cue
   counts only as a whole short message (at most seven words, cue plus filler
   words such as "thanks", "bitte"), never with a question mark. Plain thanks
   is not a cue: it often comes in the middle of a task, so the message must
   also say that it is done ("thanks, that's it", "passt", "erledigt", "das
   wars"). Cancel: "nevermind", "forget it", "vergiss es", "stop", "abbrechen".
   A cue with nothing to close creates no goal. Goals armed by the owner (with a
   mandate or a wake) are closed through their tools only.
2. If the entities the message is about (`about` of the perception) overlap the
   entities stored on a goal (`cogt:aboutEntity`, written when the goal was
   created), that goal is continued. Otherwise the intent creates a new goal per
   the table. A message without entities that asks for the same goal type as the
   latest goal is a follow-up and continues it. Anything else keeps the earlier
   behaviour (continue an active goal, else the implicit goal).

**Competition.** When goals compete the most recent intent (newest goal) wins;
priority no longer decides. A `cogt:ChooseGoal` record in the cycle graph names
the `winner`, the `loser`s and the rule (`chosenBecause`), with `forUser`. The
losers stay active; they end by a cue, a tool, the supersession below or a
later cleanup.

**Superseded losers.** One turn of the session and user is counted when a turn's
records are written (queued persist). A goal that the decision tree created from
an intent (`AnswerQuestion`, `ExecuteCommand`, `HandleRequest`, `AnswerInTopic`),
that is not the turn's winner and was neither chosen nor touched (its `updatedAt`
unchanged) for N turns is set to `abandoned` with the reason
"superseded by newer intent". N is the setup key `goalSupersedeAfterTurns`
(integer 1 to 1000, default 10). The goal-abandoned episode is written for the
goal's owner (`forUser`) while episodic memory is on, its text carrying the
reason. Goals with a mandate or a wake, long-term goals and every other goal type
are never superseded. The bookkeeping is in memory: a goal counts from the turn
this process first read it, so a restart only delays an abandonment. Gated by
`flagGoalStack`; without it nothing is read or written.

**Episodes.** Every transition writes `goal-pushed`, `goal-resolved`,
`goal-abandoned` or `goal-blocked` with `partOfGoal` and `forUser` (the goal's
owner key), only while `flagEpisodicMemory` is on. Inside a cycle they are
written by the queued persist; transitions by `update_goal_step`, `arm_goal` and
an initiative failure write their episode directly. The implicit goal has no
episodes.

**goalBuffer.** The top goal has salience 1.0; its parents 0.7, minus 0.1 for
each further level, never below 0.3.

**Implicit goal hygiene.** The implicit goal of a cycle is resolved when the
cycle's records are written, and resolved implicit goals never move to the
long-term graph. On the first touch of a session by a process, active implicit
goals of the sender that are older than the cycle are resolved; no migration is
needed.

Continue with [`08-metacognition-and-self-model.md`](08-metacognition-and-self-model.md).
