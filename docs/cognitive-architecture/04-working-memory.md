# 04 · Working memory

> **Scope:** the per-cycle blackboard. Buffers, salience, decay, carry-over,
> and the **global workspace** projection that feeds the LLM prompt.

---

## 1. Why working memory is its own module

The prompt that the LLM sees is the *entire* runtime expression of the agent's
state. Today, that prompt is assembled by hand in
[`packages/agent-runtime/src/index.ts:1`](../../packages/agent-runtime/src/index.ts):
the system prompt is a string template plus a fixed list of "always-on"
graphs, the user message is appended verbatim, and recent session history is
glued on. There is no representation of *why* a fragment is in the prompt or
*who* decided it should be.

Working memory makes prompt assembly **derived, not authored**:

1. Every fragment that ends up in the prompt is an RDF resource
   (`cogt:WorkingMemoryEntry`).
2. Every entry is *owned* by the phase/module that wrote it.
3. Every entry has a numeric salience controlling whether it enters the prompt.
4. Prompt assembly is one deterministic SPARQL+render pass over WM.

The benefit is *not* prettier code — it is **explainability**. "Why did
Ontofelia mention X in its response?" becomes a SPARQL walk from the response
back through the action buffer, the goal that motivated it, the retrieval
that supported it, to the episode that brought it in.

---

## 2. The six buffers

A buffer is just a named-resource marker on a WM entry
(`cogt:writtenTo cogt:perceptionBuffer`). There is no separate storage per
buffer — buffers are a *taxonomy*, not a partition. This lets a single SPARQL
query span buffers when needed.

Buffer assignment rules:

| Buffer | Who writes | What goes in | Typical entries per cycle |
|---|---|---|---|
| `perceptionBuffer` | Perception phase | Message text, sender, NER results, intent label | 5–15 |
| `retrievalBuffer` | Comprehension phase | LTM lookups (semantic + episodic), scored | 3–20 |
| `goalBuffer` | Goal management phase | Top goal + parents, success criterion, deadline | 1–4 |
| `actionBuffer` | Action selection phase | Action proposal + result | 1–N (one per tool round) |
| `selfBuffer` | Self-model module (read into cycle) | Persona, capability, constraint slice for this goal type | 3–6 |
| `metaBuffer` | Metacognition (phase 6 + carry-over) | Reflective notes, impasse markers, carry-from-previous-cycle | 0–5 |

A WM entry **must** belong to exactly one buffer.

---

## 3. Entry schema

```turtle
PREFIX cogt: <urn:shared:ontology#cog/>

cog:wm_<n> a cogt:WorkingMemoryEntry ;
    cogt:writtenTo    cogt:<bufferName>     ;   # required
    cogt:writtenBy    cog:phase_<...>       ;   # required, phase resource
    cogt:writtenAt    "..."^^xsd:dateTime   ;   # required
    cogt:salience     "0.8"^^xsd:decimal    ;   # required, range [0,1]
    cogt:entryKind    "ner-result"          ;   # required, controlled vocab
    cogt:payload      "..."                  ;   # textual, what to render
    cogt:refersTo     <urn:entity:...>      ;   # optional, link to LTM
    cogt:sourceGraph  <urn:...>             ;   # optional, where this came from
    cogt:retrievalScore "0.7"^^xsd:decimal  ;   # optional, only for retrievalBuffer
    cogt:carryForward true                  ;   # optional, default false
    cogt:expiresAfter "1"^^xsd:int          ;   # optional, in cycles
    cogt:forGoal      cog:goal_<...>        ;   # optional, only for actionBuffer
    cogt:carriedFrom  cog:wm_<n_prev>       .   # optional, set by carry-over
```

### 3.1 `cogt:entryKind` — controlled vocabulary

| Value | Used in | Meaning |
|---|---|---|
| `message-text` | perceptionBuffer | The user's incoming text |
| `sender-id` | perceptionBuffer | Who sent the message |
| `ner-result` | perceptionBuffer | A named entity resolved by `EntityMatcher` |
| `parsed-claim` | perceptionBuffer | A `(s,p,o)` extracted by `SemanticParser` |
| `intent` | perceptionBuffer | Intent classification result |
| `fact` | retrievalBuffer | A triple retrieved from an LTM graph |
| `episode-ref` | retrievalBuffer | Reference to a relevant prior episode |
| `goal-active` | goalBuffer | The active top goal |
| `goal-parent` | goalBuffer | An ancestor goal still relevant |
| `action-proposal` | actionBuffer | LLM's proposed next action |
| `action-result` | actionBuffer | Tool result after execution |

Implemented for tool calls (see doc 09 §12 for the differences from this
schema): `action-proposal` carries `toolName`, `callId`, `toolArgs` (argument
keys only, masked paths listed, never a value) and `forGoal` (the active goal,
when the goal stack is on); `action-result` carries `callId`, `outcome`
(`success` or `error`), `denialClass` and `durationMs`. Both are written by the
queued persist with the sender's `forUser`, below the default threshold, so they
are an audit trail and never prompt material.
| `capability` | selfBuffer | A `cogt:Capability` relevant this cycle |
| `constraint` | selfBuffer | A `cogt:Constraint` relevant this cycle |
| `persona-fragment` | selfBuffer | Identity/style note for prompt |
| `reflection` | metaBuffer | A reflective note carried over |
| `impasse-flag` | metaBuffer | A flagged impasse from a prior phase |

---

## 4. Salience — the prompt-or-not decision

Salience `[0,1]` decides who enters the **global workspace**, i.e. the prompt.

The default cutoff is `θ = 0.5`. Entries below θ exist in WM (queryable in
later phases, surfaced in debug logs) but do not enter the prompt.

### 4.1 How salience is assigned

| Source | Default salience | Modifier |
|---|---|---|
| Message text | 1.0 | always max |
| Sender ID | 0.9 | +0.1 if isOwner |
| NER result | 0.7 | + entity-prior(entity, retrievalBuffer); max 1.0 |
| Parsed claim | 0.6 | +0.1 if claim contradicts an LTM fact (forces surfacing) |
| Intent | 0.8 | constant |
| Retrieved fact | `retrievalScore` | (so salience == score) |
| Episode-ref | 0.5 + `recency_factor` | recency in (0, 0.5) |
| Top goal | 1.0 | always max |
| Goal parent | 0.7 | -0.1 per ancestor depth |
| Capability | 0.6 if relevant else 0.0 | binary relevance per goal type |
| Constraint | 0.9 | constraints are sticky |
| Reflection | 0.4 + 0.6·`urgent` | metacog can boost via `urgent` flag |

These are **defaults**, configurable per agent in `urn:<agent>:setup`.

### 4.2 Salience adjustments at runtime

Metacognition (Phase 6) may **re-rank** entries after the fact for the next
cycle's carry-over:

- An action that succeeded → boost the supporting retrieval entries (so they
  are more likely to carry forward).
- An action that the user disapproved of → demote the retrieval entries that
  argued for it.

This is the rudimentary feedback loop that lets the agent learn salience over
time without changing module code.

---

## 5. The global workspace — prompt projection

The **global workspace** is the slice of WM with `salience ≥ θ`. Prompt
assembly is one SPARQL projection + a deterministic render:

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?buffer ?kind ?payload ?salience ?score ?refersTo ?sourceGraph
WHERE {
  GRAPH <urn:ontofelia:cog:working:sess_X:cycle_Y> {
    ?entry a cogt:WorkingMemoryEntry ;
           cogt:writtenTo ?buffer ;
           cogt:entryKind ?kind ;
           cogt:payload   ?payload ;
           cogt:salience  ?salience .
    FILTER(?salience >= 0.5)
    OPTIONAL { ?entry cogt:retrievalScore ?score . }
    OPTIONAL { ?entry cogt:refersTo       ?refersTo . }
    OPTIONAL { ?entry cogt:sourceGraph    ?sourceGraph . }
  }
}
ORDER BY ?buffer DESC(?salience)
```

The render then walks the results buffer-by-buffer and produces the prompt
in a fixed shape (Markdown today; could be JSON for stricter models). The
order is: `selfBuffer → goalBuffer → retrievalBuffer → metaBuffer →
perceptionBuffer` (perception last because the LLM should see context
*before* the question).

### 5.1 Rendered example (excerpt)

```
[Self]
You are Ontofelia, semi-autonomous. Owner: Alice. Constraint:
no destructive operations without owner approval.

[Active goal]
WriteConceptDoc — produce docs/cognitive-architecture/ for review
(priority 0.95, due 2026-06-02)

[Retrieved facts]
• Ontofelia uses Oxigraph + Reasonable for OWL inference
  (urn:ontofelia:worldview)
• Existing graphs: self, skills, setup, claims, evidence, worldview,
  schema, conflicts, inferred (urn:ontofelia:worldview)
• Previous cycle wrote /root/Ontofelia/docs/cognitive-architecture/README.md
  (episode cog:ep_…_201)

[Note]
Previously noted: User uses minimal input; assume continuation of prior
goal unless explicit topic switch.

[Now]
Sender: Alice (owner). Channel: webchat.
Message: "ontofelia"
Intent: topic-reference
```

---

## 6. Carry-over to the next cycle

WM is **per cycle**, but a session is a sequence of cycles. Selective
continuity is essential. At the end of Phase 6:

```
For each WM entry e in cycle_N:
  iff (
    e.buffer == goalBuffer AND e.forGoal.status IN ('active','blocked')
  ) OR (
    e.buffer == metaBuffer AND e.carryForward == true
  ) OR (
    e.buffer == selfBuffer  # session-constant
  ) OR (
    e.carryForward == true AND e.expiresAfter is null OR > 0
  ):
    copy e to cycle_{N+1}.WM with:
      salience' = e.salience * decay   (default decay = 0.7)
      carriedFrom = e
      expiresAfter -= 1 (if set)
```

Carried entries explicitly link back via `cogt:carriedFrom`, so the agent can
reconstruct "this idea has been in my head for three cycles".

---

## 7. WM size limits

To keep the global workspace **cognitively focused** (not for token/cost
reasons — those are out of scope, see §10):

- Hard cap of 200 entries per cycle.
- If the cap is approached, **lowest-salience entries are dropped first**.
- An impasse `wm-overflow` is raised if the cap is hit *and* a write of
  salience > 0.7 is attempted (meaning something important wants to come in
  but there's no room). Metacognition then prunes aggressively.

---

## 8. Read API (TypeScript sketch)

```typescript
// packages/agent-runtime/src/cognitive/WorkingMemory.ts

export class WorkingMemory {
  constructor(
    private triplestore: TriplestoreAdapter,
    private agentId: string,
    private sessionId: string,
    private cycleId: string,
  ) {}

  graphUri(): string {
    return GraphUriResolver.getCogWorkingGraph(
      this.agentId, this.sessionId, this.cycleId,
    );
  }

  async write(entry: WMEntryInput, writtenBy: PhaseRef): Promise<WMEntryId> { /* ... */ }
  async read(filter: WMReadFilter): Promise<WMEntry[]> { /* ... */ }
  async globalWorkspace(theta = 0.5): Promise<WMEntry[]> { /* ... */ }
  async adjustSalience(id: WMEntryId, delta: number): Promise<void> { /* ... */ }
  async carryForward(toCycleId: string): Promise<number> { /* ... */ }
  async close(): Promise<void> { /* drop graph; carried entries already in next cycle */ }
}

export interface WMEntryInput {
  buffer: BufferName;
  entryKind: EntryKind;
  payload: string;
  salience: number;             // [0,1]
  refersTo?: string;            // URI
  sourceGraph?: string;
  retrievalScore?: number;
  carryForward?: boolean;
  expiresAfter?: number;        // in cycles
  forGoal?: string;             // URI
}
```

---

## 9. Debugging WM

For development, a debug query lists every entry that *entered the prompt*
plus the action that resulted:

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?buffer ?kind ?payload ?salience ?action WHERE {
  GRAPH ?wmGraph {
    ?entry a cogt:WorkingMemoryEntry ;
           cogt:writtenTo ?buffer ;
           cogt:entryKind ?kind ;
           cogt:salience  ?salience ;
           cogt:payload   ?payload .
    FILTER(?salience >= 0.5)
  }
  GRAPH ?wmGraph {
    ?action cogt:writtenTo cogt:actionBuffer ;
            cogt:entryKind "action-proposal" ;
            cogt:payload   ?action .
  }
  FILTER(STRSTARTS(STR(?wmGraph), "urn:ontofelia:cog:working:"))
}
```

This is the foundation for the "explain this response" debug button planned
for the Web UI.

---

## 10. Open questions

- [ ] Should retrievalBuffer entries be deduplicated across semantic and
      episodic results, or kept distinct? *Recommendation:* distinct, with a
      `cogt:dedupGroup` predicate so the prompt assembler can pick best.
- [ ] Is θ = 0.5 the right default? *Recommendation:* yes for v1; expose as
      `cogt:salienceThreshold` in `urn:<agent>:setup`.
- [x] **Token budgets are explicitly out of scope.** *Decided (2026-05-31):* we
      do **not** cap or optimise the prompt by token count. LLM context windows
      keep growing and per-token cost keeps falling, so token economy is not a
      design constraint for this architecture. Working memory is bounded only by
      **entry count** (salience-ordered, §7), which exists for *cognitive*
      reasons — keeping the global workspace focused — not for cost. The render
      emits the full salience-≥θ slice; if a model's hard context limit is ever
      hit, the model-side limit truncates safely, and that is acceptable.
      *Amended for the recall blocks:* once recalled text can reach the prompt
      (`flagWorkingMemoryPrompt` with `flagEpisodicRecall`), the entry-count
      caps alone let the cost grow with the user's history. The prompt
      assembler (`cognitive/PromptAssembler.ts`) therefore adds a conservative
      token ceiling for the cognitive blocks only; the rest of the prompt is
      untouched. Tokens are estimated as characters / 4. The `[Recalled]` block
      has a hard cap (default 600), all cognitive blocks together another
      (default 1200); entries are cut whole, lowest score first (recalled) or
      least important block first (total). Both are read per message from the
      setup graph.

### 10.1 Prompt assembler parameters (setup graph)

Numeric triples on `urn:<agent>:setup:cognitive` in `urn:<agent>:setup`
(predicates in the `cogt:` namespace `urn:shared:ontology#cog/`); a missing,
unparseable or out-of-range value falls back to the default.

| Predicate | Meaning | Default |
|---|---|---|
| `salienceThreshold` | θ, the global-workspace cutoff, 0 to 1 | 0.5 |
| `recalledTokenCap` | hard cap of the `[Recalled]` block, estimated tokens | 600 |
| `promptTokenCap` | cap of all cognitive blocks together | 1200 |

Two flags choose the mode per message (both default off): `flagPromptShadow`
runs the assembler beside the normal prompt and records its output and a block
diff in the cycle graph (`cogt:PromptShadow`); `flagWorkingMemoryPrompt` builds
the cognitive blocks from the assembler instead of the legacy strings. Live wins
when both are on. The always-on graph context of the prompt is not replaced.

## 11. Implementation notes: carry-over and attention (cycle manager on)

Done by the queued persist of the next cycle, never on the reply path:

- **Carry.** The previous cycle of the same session and the same user is carried
  into the current one: `selfBuffer` entries, `goalBuffer` entries of goals that
  are still live (the implicit respond-to-user goal excluded), and entries with
  `carryForward = true` (flagged notes). Salience x 0.7, `carriedFrom` to the
  source entry. An entry the current cycle already holds in the same form
  (buffer, kind, payload, goal) is not copied again. Nothing carries across
  users or sessions; the link is held in memory, so the first cycle after a
  restart has nothing to carry.
- **Close.** The previous graph gets a `cogt:closedAt` timestamp and is kept; the
  age-based sweep (7 days) removes it as before.
- **Attention.** Entries that `refersTo` an entity of the active goal get +0.2
  (cap 1.0). A carried entry about an entity of no live goal that no fresh entry
  of the cycle refreshes is damped x 0.7 (on top of the carry decay). A carried
  entry below the floor `min(0.1, θ)` is deleted.
- **Overflow.** When the capacity forces out an entry above salience 0.7, one
  `wm-overflow` impasse is raised for the cycle (metacognition on), carrying
  `cogt:forUser`.
- **Carried entries in the live prompt.** With `flagWorkingMemoryPrompt` on, the
  prompt of a turn also contains what the carry will bring in. The assembler
  reads the previous cycle's graph of the same session and user (read-only, at
  most 20 rows, highest salience first), keeps entries written for exactly this
  sender with `carryForward = true` that are not expired, takes the carry decay
  (salience x 0.7), and keeps those still at or above θ. Self and goal entries
  are not read: they are rebuilt every turn. The text is neutralised like any
  quoted text, and the assembler's own caps apply (three notes, the recalled
  cap, the total cap). Notes appear as `- Previously noted: <text>` in `[Note]`;
  retrieval entries join `[Recalled]` when recall is on. The link to the
  previous cycle is held in memory, so the first turn after a restart has
  nothing to read. With the flag off nothing is read.
- **Setup keys.** `salienceThreshold` (θ, default 0.5) and
  `workingMemoryCapacity` (integer 1 to 10000, default 200).

Continue with [`05-episodic-memory.md`](05-episodic-memory.md).
