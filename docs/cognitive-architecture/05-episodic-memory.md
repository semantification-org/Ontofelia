# 05 · Episodic memory

> **Scope:** what an episode is, how episodes chain into a temporal narrative,
> retrieval, retention, and the **episodic → semantic consolidation** job
> that turns repeated experiences into general knowledge.

---

## 1. Why episodic memory belongs in RDF

Today, Ontofelia stores conversations as JSONL transcripts plus a SQLite
index ([`packages/session-store/src/`](../../packages/session-store/src/)).
That is fine for verbatim audit — and we keep it — but it is the wrong
substrate for **cognitive recall**, because:

- The agent cannot SPARQL across it ("show me every time I called
  `web_fetch` for goal-type `CodeAnalysis`").
- It is not entity-linked. "Last time we talked about Ontofelia, what did I
  conclude?" requires entity resolution at retrieval time, not at write time.
- It cannot carry the causal structure of *episodes*: cause/effect, goal
  served, outcome.

Episodic LTM in RDF gives us a queryable, entity-linked, temporally-ordered
narrative. Verbatim transcripts remain in JSONL; the episode resource refers
to them by transcript ID for fidelity.

---

## 2. What counts as an episode

Anything **observable** from the agent's first-person perspective that
matters for future recall. Concretely:

| Episode kind | Trigger | Written by |
|---|---|---|
| `message-received` | Inbound `MessageEnvelope` | Phase 1 (perception) |
| `tool-called` | Tool invocation begins | Phase 5 (execution) |
| `tool-completed` | Tool invocation ends (success or error) | Phase 5 (execution) |
| `response-sent` | Outbound message via channel | Phase 5 (execution) |
| `goal-pushed` | New goal added to stack | Phase 3 (goal management) |
| `goal-resolved` | Goal status → resolved | Phase 3 or Phase 6 |
| `goal-abandoned` | Goal status → abandoned | Phase 3 or metacog |
| `goal-blocked` | Goal status → blocked (tool or repeated initiative failure) | Tools or the initiative service |
| `impasse-flagged` | Any phase wrote a `cogt:Impasse` | The phase that flagged |
| `meta-reflected` | Phase 6 writes the reflective marker | Phase 6 |
| `consolidation-promoted` | A pattern was promoted from episodic to semantic | Background job |

`impasse-flagged` and `meta-reflected` are written by the metacognition step of
a cycle (`flagMetacognition`) and only when episodes are on
(`flagEpisodicMemory`). Both carry `cogt:cycleId`, `cogt:forUser` and, where the
turn had a goal, `cogt:partOfGoal`. `impasse-flagged` has one episode per impasse
(payload: kind and detector context); `meta-reflected` has one per cycle
(payload: a fixed line of the marker's counts). Impasses raised by the weekly
cross-cycle scan are not written as episodes.

Episodes are **always written**, even when uninteresting. The cost of
"too many episodes" is solved by retention (§7), not by being selective at
write time — that would create blind spots.

---

## 3. Episode schema

```turtle
PREFIX cogt: <urn:shared:ontology#cog/>
PREFIX core: <urn:shared:ontology#>

cog:ep_<utc-iso>_<seq> a cogt:Episode ;
    cogt:episodeId    "ep_2026-05-31T18-04-32Z_001" ;     # required
    cogt:episodeType  "message-received"  ;               # required
    cogt:occurredAt   "..."^^xsd:dateTime ;               # required
    cogt:durationMs   45 ;                                # optional
    cogt:sessionId    "sess_2026-05-31_18-04" ;           # optional but usual
    cogt:cycleId      "cycle_2026-05-31T18-04-32Z_001" ;  # required if inside a cycle
    cogt:channel      "webchat" ;                         # optional
    cogt:actor        <urn:entity:Alice> ;              # who did it (user or agent)
    cogt:about        <urn:entity:OntofeliaProject> ;     # entity this episode is about
    cogt:precededBy   cog:ep_<previous> ;                 # for chaining
    cogt:partOfGoal   cog:goal_<id> ;                     # which goal it served
    cogt:rawText      "..." ;                             # message text or tool args summary
    cogt:transcriptRef "<jsonl_file>:<offset>" ;          # link to verbatim store
    cogt:hasClaim     claim:<id> ;                        # link into existing provenance
    cogt:outcome      "success" ;                         # for tool-completed / goal-resolved
    cogt:errorClass   "..." ;                             # for failure episodes
    cogt:salience     "0.7"^^xsd:decimal ;                # used by retrieval scoring
    cogt:tags         "code-analysis", "doc-writing"      # free-text tags for fast filtering
    .
```

### 3.1 Linking to existing entities

`cogt:actor` and `cogt:about` always point into the existing entity layer
(`urn:entity:…`), reusing the URIs that the semantic-memory ingestion
already mints. This means episodic retrieval can pivot to semantic facts
about the same entity without re-resolution:

```sparql
# Episodes involving OntofeliaProject + current worldview facts about it
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?ep ?when ?text ?p ?o WHERE {
  GRAPH <urn:ontofelia:cog:episodic> {
    ?ep a cogt:Episode ;
        cogt:about      <urn:entity:OntofeliaProject> ;
        cogt:occurredAt ?when ;
        cogt:rawText    ?text .
  }
  GRAPH <urn:ontofelia:worldview> {
    <urn:entity:OntofeliaProject> ?p ?o .
  }
} ORDER BY DESC(?when)
```

---

## 4. The narrative chain

Episodes within a session are chained by `cogt:precededBy`. The chain lets
the agent reconstruct conversational flow:

```turtle
cog:ep_001 a cogt:Episode ;
    cogt:episodeType "message-received" ;
    cogt:rawText "kennst du ontofelia" .

cog:ep_002 a cogt:Episode ;
    cogt:episodeType "response-sent" ;
    cogt:precededBy  cog:ep_001 ;
    cogt:rawText "Nein, sagt mir nichts…" .

cog:ep_003 a cogt:Episode ;
    cogt:episodeType "message-received" ;
    cogt:precededBy  cog:ep_002 ;
    cogt:rawText "hast du Zugriff auf github.com/ORG/ontofelia" .

cog:ep_004 a cogt:Episode ;
    cogt:episodeType "tool-called" ;
    cogt:precededBy  cog:ep_003 ;
    cogt:rawText     "curl -H 'Authorization: token …' …" ;
    cogt:partOfGoal  cog:goal_check_git_access .

cog:ep_005 a cogt:Episode ;
    cogt:episodeType "tool-completed" ;
    cogt:precededBy  cog:ep_004 ;
    cogt:outcome     "success" ;
    cogt:durationMs  237 .

cog:ep_006 a cogt:Episode ;
    cogt:episodeType "response-sent" ;
    cogt:precededBy  cog:ep_005 ;
    cogt:rawText "Ja, Zugriff funktioniert: angemeldet als alice (Admin)…" .
```

A SPARQL property-path walk reconstructs the conversation:

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?ep ?type ?when ?text WHERE {
  GRAPH <urn:ontofelia:cog:episodic> {
    cog:ep_006 cogt:precededBy* ?ep .
    ?ep cogt:episodeType ?type ;
        cogt:occurredAt  ?when ;
        cogt:rawText     ?text .
  }
} ORDER BY ?when
```

---

## 5. Retrieval

Comprehension (Phase 2) queries episodic LTM in three patterns:

### 5.1 Entity-anchored recall

"Tell me what I know about *this* entity from past episodes."

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?ep ?when ?type ?text WHERE {
  GRAPH <urn:ontofelia:cog:episodic> {
    ?ep cogt:about      ?entity ;
        cogt:occurredAt ?when ;
        cogt:episodeType ?type ;
        cogt:rawText    ?text .
  }
  VALUES ?entity { <urn:entity:OntofeliaProject> }
}
ORDER BY DESC(?when)
LIMIT 5
```

### 5.2 Goal-anchored recall

"Last time I had a goal of this type, what happened?"

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?ep ?goal ?text ?outcome WHERE {
  GRAPH <urn:ontofelia:cog:goals:longterm> {
    ?goal cogt:goalType cogt:WriteConceptDoc ;
          cogt:status   "resolved" .
  }
  GRAPH <urn:ontofelia:cog:episodic> {
    ?ep cogt:partOfGoal ?goal ;
        cogt:rawText    ?text ;
        cogt:outcome    ?outcome .
  }
}
```

### 5.3 Temporal recall

"What happened recently in this session?"

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?ep ?when ?type ?text WHERE {
  GRAPH <urn:ontofelia:cog:episodic> {
    ?ep cogt:sessionId   "sess_2026-05-31_18-04" ;
        cogt:occurredAt  ?when ;
        cogt:episodeType ?type ;
        cogt:rawText     ?text .
  }
}
ORDER BY DESC(?when)
LIMIT 10
```

### 5.4 Relevance scoring

```
relevance(episode) =
  entity_overlap * 0.4
  + goal_match    * 0.3
  + recency       * 0.2
  + tag_overlap   * 0.1

where recency = exp(-Δt_hours / 168)   # 1-week half-life-ish decay
```

The relevance score is written into the retrievalBuffer WM entry as
`cogt:retrievalScore`.

---

## 6. Episodic → semantic consolidation

The point of episodic memory is not just recall — it is the **substrate for
generalisation**. Repeated, consistent episodes should crystallise into
semantic facts.

### 6.1 What gets consolidated

Patterns the consolidation job looks for:

1. **Repeated entity assertion.** "Across N independent episodes, the same
   `(s, p, o)` is asserted." → Promote `(s, p, o)` into semantic LTM via the
   existing Claim/Evidence flow (treating episodes as evidence sources).

2. **Recurring goal-outcome pattern.** "Goal-type T succeeded K times with
   tool-sequence S." → Write into procedural LTM (see
   [06](06-procedural-memory.md)).

3. **User preference.** "User accepted suggestion X over Y in N episodes." →
   Write into `urn:<agent>:user:<userId>` as a `core:preference` fact.

4. **Stable channel-routing rule.** "Every Telegram message from sender X is
   followed by tool-call Y." → Stored as procedural pattern with channel
   context.

### 6.2 Algorithm (sketch)

Runs as a scheduled job (default daily); never blocks a cycle.

```
For each entity E referenced in ≥ K episodes in the last window:
  For each (predicate p, object o) frequently co-asserted with E:
    Count distinct evidence groups (transcriptRef, sessionId, day-of-week)
    if count ≥ Q AND no conflicting (E,p,o') with stronger support:
      Mint a core:Claim with status "accepted" in urn:<agent>:claims
        sourceKind: "consolidation-episodic"
        hasSupportClaim: <every constituent episode's claim if any>
        supportScore: sum(salience * recency)
      Insert the triple into urn:<agent>:worldview
```

Default thresholds: `K = 3` (episodes), `Q = 2` (independent evidence
groups). All configurable in `urn:<agent>:setup`.

### 6.3 What does *not* get consolidated

- Single-occurrence episodes — never promoted alone (would be hearsay).
- Episodes from sessions flagged `cogt:sessionUntrusted` (e.g. test/dry-run
  sessions; default false).
- Episodes whose `cogt:rawText` was retracted via privacy delete (the
  episode itself is hard-deleted, see §7).

### 6.4 As built: pattern 1 (repeated entity assertion)

Behind `cog.flagEpisodicConsolidation` (off by default; `/cog flag
episodicconsolidation on`). A daily job (`cog.consolidate-episodes`) and the
owner-only `/cog consolidate-episodes` run it. It deviates from the sketch in
§6.2 on purpose, as a privacy decision:

- **Target.** A fact is promoted only into the graph `urn:<agent>:user:<key>` of
  the user whose episodes assert it. There is no worldview promotion path and no
  parameter that selects another graph. The owner's key is `owner`, so the
  owner's episodes promote into `urn:<agent>:user:owner`.
- **Which graph.** The inbound episode records the graph the ingestion writes the
  sender's own facts to (`cogt:factGraph`, `urn:<agent>:user:<sender id>`). The
  promotion and the retraction cascade use exactly that graph, not the
  cognitive user key (`cogt:forUser`, which only scopes the cognitive records;
  for the owner it is always `owner`, whatever the sender id). Episodes without
  `cogt:factGraph` (written before it existed) are never promoted from.
- **Evidence never mixes users.** Episodes are read per user and counted only
  towards promotions into that user's graph.
- **Count.** From the claims an episode stored (`cogt:hasClaim`): a triple
  `(s, p, o)` qualifies with at least K distinct episodes in at least Q distinct
  evidence groups. A group is one session on one UTC day; the session is the
  transcript reference without its line index, else the session id, so all
  messages of one session on one day are one group. Setup keys on `urn:<agent>:setup:cognitive`:
  `cog:consolidationMinEpisodes` (K, default 3) and `cog:consolidationMinGroups`
  (Q, default 2); integers 1..100.
- **Exclusions.** A claim that is not `accepted` (retracted claims no longer
  exist; superseded and rejected ones are not accepted), a claim asserted in a
  graph other than the worldview or the user's own graph, a claim that is itself
  a consolidation, secret-classed episodes or claims, and episodes of a session
  flagged `cogt:sessionUntrusted`.
- **Minting.** The existing Claim/Evidence write with `sourceKind
  "consolidation-episodic"`; the evidence lists the source episodes
  (`core:sourceEpisode`) and their claims (`core:supportClaim`). A
  `consolidation-promoted` episode with `forUser` records the claim hash as the
  tag `claim-hash:<sha256>`.
- **Idempotence.** The hash over (user, s, p, o) in that ledger means a rerun
  promotes nothing, and a fact the user retracted after promotion does not come
  back. A triple or accepted claim already in the user's graph is left alone
  (no duplicate, no corroboration evidence).
- **Functional properties.** A promoted claim is superseded by a later value like
  any other. A promotion never overrides a different accepted value the user's
  graph holds now (counted as a conflict).
- **Bounds.** 200 users, the newest 500 claim-bearing episodes per user, 20
  promotions per user and 100 per run. No model call. No watermark: the counts
  need the older episodes, and the ledger already makes a rerun a no-op.

- **Re-assertion links the existing claim.** The ingestion skips a triple that
  already exists and mints no claim, so a repeated fact would never reach K.
  While episodic memory is on, a duplicate instead returns the existing claim
  (`StoreResult.reassertedClaimUri`, `IngestionReport.reassertedClaims`) and the
  episode links it via `cogt:hasClaim`. The existing claim must be accepted, not
  secret-classed, not a consolidation, and asserted in the graph the same routing
  rule picks for this sender (own user graph or worldview), with the same
  subject, predicate and object. An Evidence record (source span, session, time)
  is added to that claim; no second claim and no second triple. With episodic
  memory off a duplicate is skipped exactly as before.
- **Already known.** If the worldview holds an accepted claim for the triple that
  is not one of the episodes' own claims, nothing is promoted (counted as
  `alreadyKnown`).
- **Retraction cascade.** `memory_retract` also hard-deletes the retracting
  user's own `consolidation-episodic` copy of the same triple (triple, claim,
  evidence) in the user graph of that user (`urn:<agent>:user:<sender id>`), then rebuilds the
  inferred graph. Other users' graphs are never touched. The
  `consolidation-promoted` episode stays, so the ledger still blocks a
  re-promotion.

Pattern 3 (user preference, "accepted X over Y") is not built. It needs a capture
of the offered alternatives (which options were on the table and which one was
chosen), and no episode records that yet, so it cannot be detected
deterministically.

---

## 7. Retention

Episodic memory grows unboundedly without retention. Tiered scheme:

| Tier | Age | What is kept |
|---|---|---|
| Hot | 0–30 days | Full episode (all triples, including `rawText`) |
| Warm | 30–90 days | All triples **except** `rawText`; replaced by `transcriptRef` |
| Cold | 90–365 days | One summary triple per *day* per entity (`cogt:DailySummary`) |
| Frozen | > 365 days | Episode IDs only; data hard-deleted |

The retention job is policy-driven (uses `core:retentionPolicy` from
`urn:shared:meta`). Privacy-classed episodes (`core:privacyClass "secret"`)
go cold after 7 days regardless.

### 7.1 Per-user scope

`cog:episodic` is agent-wide, so every episode carries `cogt:forUser`, the
sender's user key (the id of the per-user graph `urn:<agent>:user:<id>`; the
verified owner is `owner`, and initiative and system episodes are the owner's).
Every read (`retrieve`, `findInSession`, `findByEntity`, `recent`, `chainFrom`)
takes a mandatory `userScope`: a user key, or `"all"` for owner/operator code
paths. A scoped read never returns another user's episode, and a chain walk
stops at the user boundary. **Episodes written before the key existed have no
`cogt:forUser` and are treated as owner-only**: they are returned for the
owner's key and for `"all"`, never for another user.

An episode whose payload matches a credential shape is also written with
`core:privacyClass "secret"`, so the rule above (cold after 7 days) applies.
`EpisodicMemory.deleteForUser(userId)` deletes all episodes of one user and
re-links the `cogt:precededBy` chain around them; it is not yet called from a
user-facing command.

Hard-delete cascade (when user requests):
1. Delete the `cogt:Episode` triples.
2. Delete linked `core:Claim` and `core:Evidence` records (existing
   provenance hard-delete path, see KG concept §7).
3. Delete the JSONL transcript span referenced by `transcriptRef`.

---

## 8. Episodes that span cycles

Some episodes have inherent duration (a tool call started in cycle N, the
result observed in cycle N+1 — rare but possible with async tools). Schema
supports it:

```turtle
cog:ep_tool_call a cogt:Episode ;
    cogt:episodeType "tool-called" ;
    cogt:occurredAt  "2026-05-31T18:04:32Z"^^xsd:dateTime ;
    cogt:openedInCycle cog:cycle_001 ;
    cogt:cycleId      "cycle_001" .

cog:ep_tool_done a cogt:Episode ;
    cogt:episodeType  "tool-completed" ;
    cogt:occurredAt   "2026-05-31T18:05:10Z"^^xsd:dateTime ;
    cogt:closedInCycle cog:cycle_002 ;
    cogt:precededBy   cog:ep_tool_call ;
    cogt:completes    cog:ep_tool_call ;
    cogt:durationMs   38000 ;
    cogt:outcome      "success" .
```

The pair is linked by `cogt:completes`; relevance scoring treats both
episodes as one event.

---

## 9. Read API (TypeScript sketch)

```typescript
// packages/semantic-memory/src/cognitive/EpisodicMemory.ts

export class EpisodicMemory {
  constructor(
    private triplestore: TriplestoreAdapter,
    private agentId: string,
  ) {}

  graphUri(): string {
    return GraphUriResolver.getCogEpisodicGraph(this.agentId);
  }

  async record(ep: EpisodeInput): Promise<EpisodeId> { /* ... */ }

  async findByEntity(entity: string, opts: FindOpts): Promise<EpisodeHit[]> { /* ... */ }
  async findByGoal(goalUri: string, opts: FindOpts): Promise<EpisodeHit[]> { /* ... */ }
  async findInSession(sessionId: string, opts: FindOpts): Promise<EpisodeHit[]> { /* ... */ }

  async walkChain(fromEpisodeId: string, direction: 'back'|'forward', max: number): Promise<EpisodeHit[]> { /* ... */ }

  async retentionTick(now: Date): Promise<RetentionReport> { /* ... */ }
}

export interface EpisodeInput {
  episodeType: EpisodeType;
  occurredAt: Date;
  cycleId?: string;
  sessionId?: string;
  channel?: string;
  actor?: string;              // URI
  about?: string[];            // URI list
  precededBy?: string;         // episode URI
  partOfGoal?: string;         // URI
  rawText?: string;
  transcriptRef?: string;
  outcome?: 'success'|'error'|'partial';
  errorClass?: string;
  tags?: string[];
  salience?: number;           // defaults per episodeType
}

export interface EpisodeHit {
  uri: string;
  episodeType: EpisodeType;
  occurredAt: Date;
  relevanceScore: number;
  payload: { rawText?: string; outcome?: string; durationMs?: number };
  about?: string[];
}
```

---

## 10. Worked example

The cycle in [03](03-cognitive-cycle.md) §5 writes one episode (the user's
`"ontofelia"` message). After Phase 6, episodic memory contains:

```turtle
GRAPH <urn:ontofelia:cog:episodic> {
  cog:ep_2026-05-31T18-04-32Z_001 a cogt:Episode ;
      cogt:episodeType "message-received" ;
      cogt:occurredAt  "2026-05-31T18:04:32Z"^^xsd:dateTime ;
      cogt:sessionId   "sess_2026-05-31_18-04" ;
      cogt:cycleId     "cycle_2026-05-31T18-04-32Z_001" ;
      cogt:channel     "webchat" ;
      cogt:actor       <urn:entity:Alice> ;
      cogt:about       <urn:entity:OntofeliaProject> ;
      cogt:rawText     "ontofelia" ;
      cogt:salience    "0.6"^^xsd:decimal ;
      cogt:tags        "topic-reference", "minimal-input" ;
      cogt:hasClaim    claim:20260531_180432_001 ;
      cogt:transcriptRef "sess_2026-05-31_18-04.jsonl:offset_8412" .

  cog:ep_2026-05-31T18-04-32Z_002 a cogt:Episode ;
      cogt:episodeType "response-sent" ;
      cogt:occurredAt  "2026-05-31T18:04:35Z"^^xsd:dateTime ;
      cogt:precededBy  cog:ep_2026-05-31T18-04-32Z_001 ;
      cogt:cycleId     "cycle_2026-05-31T18-04-32Z_001" ;
      cogt:channel     "webchat" ;
      cogt:actor       <urn:ontofelia:self#Ontofelia> ;
      cogt:about       <urn:entity:OntofeliaProject> ;
      cogt:rawText     "Snapshot Ontofelia (OpenProject, …)" ;
      cogt:partOfGoal  cog:goal_20260531_204900_concept ;
      cogt:transcriptRef "sess_2026-05-31_18-04.jsonl:offset_8419" .
}
```

Now a future cycle can ask: "what did I last say about OntofeliaProject?"

```sparql
PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?text ?when WHERE {
  GRAPH <urn:ontofelia:cog:episodic> {
    ?ep cogt:episodeType "response-sent" ;
        cogt:about       <urn:entity:OntofeliaProject> ;
        cogt:occurredAt  ?when ;
        cogt:rawText     ?text .
  }
} ORDER BY DESC(?when) LIMIT 1
```

Continue with [`06-procedural-memory.md`](06-procedural-memory.md).
