# 06 · Procedural memory

> **Scope:** what the agent has *done*, what *worked*, and how that informs
> the next action selection. Distinguishes raw tool catalog from learned
> tool-use patterns.

---

## 1. Procedural memory in three layers

```
   Skills (capabilities)         ← what tools EXIST       (urn:<agent>:skills, existing)
                                                          ────────────────────────
   Skill summaries (aggregated)  ← what kind of tool-use  (urn:<agent>:cog:procedural)
                                    has worked, by goal
                                    type
   Skill traces (raw records)    ← every individual call  (urn:<agent>:cog:procedural)
                                    with timing + result
```

Layer 1 — the skills graph — already exists; tools register themselves
there. The cognitive layer adds layers 2 and 3 and **uses** them when goal
management picks an approach.

---

## 2. Skill trace — one record per tool execution

Written by Phase 5 (execution) for every tool call, success **or** failure.

```turtle
PREFIX cogt: <urn:shared:ontology#cog/>

cog:trace_2026-05-31T18-12-00Z_001 a cogt:SkillTrace ;
    cogt:traceId        "trace_2026-05-31T18-12-00Z_001" ;
    cogt:toolName       "fs_read" ;                          # required
    cogt:toolArgsHash   "sha256:1f3a..." ;                   # required, content-addressed
    cogt:toolArgsBrief  "path=/root/Ontofelia/README.md" ;   # short, human readable
    cogt:executedAt     "2026-05-31T18:12:00.412Z"^^xsd:dateTime ;
    cogt:durationMs     147 ;
    cogt:outcome        "success" ;                          # success | error | partial
    cogt:errorClass     "" ;                                 # filled iff error
    cogt:cycleId        "cycle_2026-05-31T18-12-00Z_001" ;
    cogt:sessionId      "sess_2026-05-31_18-04" ;
    cogt:forGoal        cog:goal_20260531_204900_concept ;
    cogt:forGoalType    cogt:WriteConceptDoc ;
    cogt:sequencePos    2 ;                                  # this is the 2nd tool in this cycle
    cogt:sequenceLen    7 ;                                  # cycle ended up using 7 tools
    cogt:previousTrace  cog:trace_2026-05-31T18-11-58Z_001 ;
    cogt:userSatisfied  true ;                               # set at cycle-end via feedback signal
    cogt:agentId        "ontofelia" .
```

### 2.1 What "user satisfied" means

A weak feedback signal, derived heuristically (cannot be perfect, but
"better than nothing" is the point):

| Signal | `userSatisfied` |
|---|---|
| User said "thanks" / "perfect" / "great" in the next turn | `true` |
| User said "no" / "wrong" / "stop" / immediate correction | `false` |
| User asked a follow-up question that depends on this answer | `true` (weak) |
| User changed topic abruptly | unknown (null) |
| No further user response within session | unknown (null) |

Captured retroactively at end of *next* user turn, so each trace's
`userSatisfied` is **back-filled** during Phase 1 of the next cycle.

### 2.2 Why traces never delete on failure

Failed traces are at least as informative as successes:

> "Last time I tried `fs_write` with a relative path it failed; let me
> normalise first."

So failures stay in `cog:procedural` and are read by goal management when
re-attempting similar work.

---

## 3. Skill summary — aggregated stats per (tool, goal-type)

Maintained by the background consolidation job (§5). One row per
`(toolName, forGoalType)` pair.

```turtle
PREFIX cogt: <urn:shared:ontology#cog/>

cog:skill_fs_read__WriteConceptDoc a cogt:Skill ;
    cogt:toolName        "fs_read" ;
    cogt:forGoalType     cogt:WriteConceptDoc ;
    cogt:successCount    42 ;
    cogt:failureCount    3 ;
    cogt:partialCount    1 ;
    cogt:meanDurationMs  93 ;
    cogt:p95DurationMs   180 ;
    cogt:lastUsedAt      "2026-05-31T18:12:00Z"^^xsd:dateTime ;
    cogt:successRate     "0.93"^^xsd:decimal ;
    cogt:satisfactionRate "0.88"^^xsd:decimal ;          # of successCount, share with userSatisfied = true
    cogt:hasTrace        cog:trace_2026-05-31T18-12-00Z_001,
                         cog:trace_2026-05-31T18-11-58Z_001 ;
    cogt:typicalArgPattern "path=/root/Ontofelia/{*}.md" .
```

### 3.1 Sequence skills

Some skills are about a *sequence* of tools, not a single one. For these:

```turtle
cog:seqskill_explore_repo a cogt:SequenceSkill ;
    cogt:label           "explore_repo" ;
    cogt:forGoalType     cogt:CodeAnalysisGoal ;
    cogt:hasStep         [ cogt:stepIndex 1 ; cogt:toolName "fs_list" ;
                           cogt:notes "list package roots" ] ,
                         [ cogt:stepIndex 2 ; cogt:toolName "fs_read" ;
                           cogt:notes "READMEs and root manifests" ] ,
                         [ cogt:stepIndex 3 ; cogt:toolName "fs_read" ;
                           cogt:notes "deep-dive into the largest packages" ] ;
    cogt:successCount    7 ;
    cogt:meanDurationMs  3842 .
```

Sequence skills are first-class because action selection should sometimes
choose a *sequence template* rather than a single next tool. (See §6.)

---

## 4. Procedural retrieval in goal management

In Phase 3 (goal management), the goal stack looks up:

> "For goal-type T, what is the highest-satisfaction skill I have, and how
> well does it work?"

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?skill ?tool ?successRate ?satRate ?meanMs WHERE {
  GRAPH <urn:ontofelia:cog:procedural> {
    ?skill a cogt:Skill ;
           cogt:forGoalType      cogt:WriteConceptDoc ;
           cogt:toolName         ?tool ;
           cogt:successRate      ?successRate ;
           cogt:satisfactionRate ?satRate ;
           cogt:meanDurationMs   ?meanMs .
    FILTER(?successRate >= 0.7)
  }
}
ORDER BY DESC(?satRate * ?successRate) DESC(?successRate)
LIMIT 5
```

The top-K skills are written into `cog:retrievalBuffer` (not `actionBuffer`
— they are *suggestions* for action selection, not commitments). They enter
the prompt as a section:

```
[Skills that worked before for this kind of goal]
• fs_read   — used 42×, 93% success, user satisfied 88%, ~93 ms avg
• fs_list   — used 18×, 100% success
• memory_store — used 27×, 100% success
```

The LLM then chooses. This is the "Common Model of Cognition" influence:
procedural memory **biases**, it does not **dictate**.

---

## 5. Consolidation — turning traces into skill summaries

Runs as a scheduled job (default every 6 hours, or after N=50 new traces,
whichever first).

```
For each (toolName, forGoalType) pair in the new traces window:
  fetch existing Skill row (or create empty)
  successCount   += count(traces where outcome = success)
  failureCount   += count(traces where outcome = error)
  partialCount   += count(traces where outcome = partial)
  meanDurationMs  = running mean of durationMs
  p95DurationMs   = quantile(0.95, durationMs)
  successRate     = successCount / (successCount + failureCount + partialCount)
  satisfactionRate = count(userSatisfied=true) / successCount
  lastUsedAt      = max(executedAt)
  typicalArgPattern = generalise from cogt:toolArgsBrief by replacing
                      numeric/UUID/path-leaf with {*}
  link top-N traces as cogt:hasTrace (keep ring buffer of last 10)
```

### 5.1 Detecting sequence patterns

Within the same window, walk cycles where ≥ 2 tools were called:

```
For each cycle C:
  toolSeq = ordered list of (toolName, sequencePos) in C
  if toolSeq matches a known SequenceSkill template:
    increment that SequenceSkill's successCount
  else if toolSeq with goal-type T appears ≥ K (default 3) cycles in the
    last window:
    mint a new cogt:SequenceSkill template
```

Sequence detection is intentionally **conservative** — it only crystallises
patterns that have happened multiple times, to avoid memorising flukes.

---

## 6. Procedural memory and action selection

The integration with Phase 4 is loose by design:

1. Goal management surfaces the top skills/sequence skills into
   `cog:retrievalBuffer` (with `entryKind: "skill-suggestion"`).
2. Prompt assembly renders them as the `[Skills that worked]` block (§4).
3. The LLM tool loop runs as today; if it picks a suggested tool, that is
   logged as `cogt:proceduralAdherence true` in the trace; if it picks
   something else, `cogt:proceduralAdherence false`.

This adherence signal lets metacognition track *whether* procedural
suggestions help: high adherence + high satisfaction means the suggestions
are useful; low adherence + high satisfaction means the LLM is doing better
on its own and we should revisit the consolidation thresholds.

---

## 7. Read API (TypeScript sketch)

```typescript
// packages/semantic-memory/src/cognitive/ProceduralMemory.ts

export class ProceduralMemory {
  constructor(
    private triplestore: TriplestoreAdapter,
    private agentId: string,
  ) {}

  graphUri(): string {
    return GraphUriResolver.getCogProceduralGraph(this.agentId);
  }

  async recordTrace(t: TraceInput): Promise<TraceId> { /* ... */ }
  async backfillSatisfaction(traceId: TraceId, satisfied: boolean | null): Promise<void> { /* ... */ }

  async suggestSkills(forGoalType: string, k = 5): Promise<SkillSuggestion[]> { /* ... */ }
  async suggestSequenceSkills(forGoalType: string, k = 3): Promise<SequenceSkillSuggestion[]> { /* ... */ }

  async consolidate(window: { since: Date; until: Date }): Promise<ConsolidationReport> { /* ... */ }
}

export interface TraceInput {
  toolName: string;
  toolArgsHash: string;
  toolArgsBrief: string;     // human-readable, redact secrets
  executedAt: Date;
  durationMs: number;
  outcome: 'success' | 'error' | 'partial';
  errorClass?: string;
  forGoal: string;           // goal URI
  forGoalType: string;       // GoalType URI
  cycleId: string;
  sessionId: string;
  sequencePos: number;
  sequenceLen?: number;      // unknown until cycle end
  previousTrace?: string;
  proceduralAdherence: boolean | null;
}

export interface SkillSuggestion {
  skillUri: string;
  toolName: string;
  successRate: number;
  satisfactionRate: number;
  meanDurationMs: number;
  typicalArgPattern?: string;
}
```

---

## 8. Privacy and procedural memory

Tool calls can include secrets in their args (tokens, paths to private
files). Two rules:

- **`toolArgsHash`** is computed *after* secret-masking, so different secret
  values for the same logical args do not look like different calls.
- **`toolArgsBrief`** is the human-readable form that ends up in retrieval;
  it is mandatorily redacted (`token=*****`, paths shortened to a base).
  The redaction map lives in `urn:<agent>:setup` (`cog:argRedactionRules`).

This keeps procedural memory shareable for cross-session learning without
leaking credentials into a long-lived store.

---

## 9. What procedural memory does *not* store

- Whole tool outputs (they live in the cycle's WM and in the verbatim
  transcript; only summaries enter procedural traces).
- Code snippets the agent wrote (those go in episodic memory or, if
  re-usable, in `urn:<agent>:skills` as a custom skill).
- LLM-internal chain-of-thought (we have no reliable way to reify it and
  doing so would invite hallucinated rationalisations).

---

## 10. Worked example — repeated tool use becoming a skill

Suppose Ontofelia, over a week, executes goal-type `WriteConceptDoc` seven
times. Each time it follows roughly: `fs_list → fs_read*K → fs_write*M →
memory_store`. After the consolidation job runs:

```turtle
GRAPH <urn:ontofelia:cog:procedural> {
  cog:seqskill_concept_doc_writing a cogt:SequenceSkill ;
      cogt:label "concept_doc_writing" ;
      cogt:forGoalType  cogt:WriteConceptDoc ;
      cogt:hasStep
        [ cogt:stepIndex 1 ; cogt:toolName "fs_list" ;
          cogt:notes "Inventory target directory" ] ,
        [ cogt:stepIndex 2 ; cogt:toolName "fs_read" ;
          cogt:notes "Read existing related docs to align style" ] ,
        [ cogt:stepIndex 3 ; cogt:toolName "fs_write" ;
          cogt:notes "Write the new doc(s)" ] ,
        [ cogt:stepIndex 4 ; cogt:toolName "memory_store" ;
          cogt:notes "Record decisions for future reference" ] ;
      cogt:successCount    7 ;
      cogt:failureCount    0 ;
      cogt:meanDurationMs  41382 ;
      cogt:successRate     "1.0"^^xsd:decimal ;
      cogt:satisfactionRate "0.86"^^xsd:decimal ;
      cogt:lastUsedAt      "2026-05-31T20:55:00Z"^^xsd:dateTime .
}
```

Next time the agent picks up `cogt:WriteConceptDoc`, goal management
surfaces this SequenceSkill into the prompt, and the LLM tends to follow
it — closing the loop.

Continue with [`07-goals-and-attention.md`](07-goals-and-attention.md).
