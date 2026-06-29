# ADR 0001 — LLM-driven intent routing, querying, and graph-aware ingestion

- **Status:** Proposed
- **Date:** 2026-06-04
- **Deciders:** Alex M. (architect), claude-session
- **Supersedes:** the deterministic, alias-table named-graph routing in
  `KnowledgeEngine.resolveTargetGraph` (`packages/semantic-memory/src/KnowledgeEngine.ts`)

## Context

A live ingestion test on 2026-06-03 (a CV sent via Telegram) exposed two defects
in the current pipeline:

1. **Wrong named-graph routing / no entity resolution.** Routing is a hard-coded
   code rule (`resolveTargetGraph`) keyed on a static `USER_ALIASES = {user, me, i}`
   set. The CV was phrased in the third person ("Alex M., Software
   Engineer at …"), so its subject did not match an alias and every fact was
   routed to `worldview` (treated as a *third party*). The owner node
   (`entity:user:owner`) and the extracted person (`entity:Alex_M`) were
   never unified — **no `owl:sameAs`** links them.
2. **Career history collapsed by over-eager belief revision.** `worksAt` /
   `hasRole` / `memberOf` are **not** declared `owl:FunctionalProperty`, yet
   `findConflictingClaims` supersedes any prior accepted claim with the same
   `(subject, predicate)`. The CV's multi-job history (Company A, Company B, Company C,
   Company D, University X/University Y) was therefore reduced to the single last-ingested value;
   the accepted worldview wrongly states "Software Engineer at University Y"
   (earliest role) instead of "Software Engineer at Company A" (current).

Root insight: the **LLM never decides the named graph** today. The
`SemanticParser` system prompt has "exactly ONE job: extract facts" and its output
schema (`subject, predicate, object, types, confidence, sourceSpan, kind`) has **no
graph field**. The graph is chosen by code afterwards. The architect's decision is
to move that intelligence into the LLM, which must therefore know the *purpose* of
every named graph — while the system keeps the auditable, consistent bookkeeping
that is Ontofelia's actual differentiator (North Star: reliability beyond naive
LLM/RAG).

## Decision

Replace the single extract-then-route pipeline with an **LLM-driven, segmented,
intent-routed pipeline**, guarded by deterministic gateways.

### Architect's decisions (locked)
1. **The LLM authors SPARQL UPDATEs directly** (not just structured facts). The
   system does *not* hand-assemble the write; it **validates and sandboxes** what
   the LLM emits.
2. **Ontology extensions apply automatically** as long as the resulting model stays
   consistent (reasoner + SHACL), backed by **robust versioning** (every change is
   a reversible, provenance-stamped version).
3. **Per-message segmentation is mandatory** — one message may carry several
   intents; each segment is classified and handled independently, results composed.

### Pipeline (per inbound message)

```
message
  └─▶ [0] SEGMENTER/ROUTER (LLM)  → ordered segments, each tagged ACTION | QUESTION | INFO
        ├─ ACTION   → [1] plan (LLM) → tool-loop (existing agent-runtime + security/policy)
        ├─ QUESTION → [2] NL→SPARQL (LLM) → READ-GATEWAY → store.query → verbalize+cite
        └─ INFO     → [3] graph-aware UPDATE (LLM) → WRITE-GATEWAY → versioned commit
  └─▶ compose per-segment results into one coherent reply
```

INFO segments are processed before QUESTION segments within the same message so a
question can see facts just stated.

### [0] Segmenter / Intent Router  *(new)*
One LLM call returns an ordered list of `{ span, intent ∈ {ACTION, QUESTION, INFO} }`.
Multi-intent is first-class. No graph/semantic decision here — only routing.

### [1] ACTION handler  *(mostly existing)*
LLM turns the span into a concrete plan ("what exactly, how"), then the existing
tool registry + tool-loop (`packages/agent-runtime`) executes under the existing
policy/sandbox (`packages/security`).

### [2] QUESTION handler — NL→SPARQL  *(new; today the parser explicitly emits NO SPARQL)*
- **Prompt context:** the TBox (classes/properties + aliases) **and the Graph
  Catalog** (see below) **and** entity hints.
- LLM emits a SPARQL `SELECT`/`ASK`.
- **READ-GATEWAY (deterministic):** parse the query; **reject any write/mgmt verb**
  (`INSERT|DELETE|DROP|CLEAR|LOAD|MOVE|COPY`); inject `LIMIT` + a hard timeout;
  validate that referenced classes/properties exist in the schema (catch
  hallucinated vocabulary). Execute, then the LLM verbalizes the result **with
  provenance** (cite the backing claims / `sourceSpan`).
- **"Cannot express" ≠ "empty result".** The LLM must distinguish *missing
  vocabulary* (→ ontology-extension proposal, see [4]) from *unknown fact* (→ honest
  "I don't know", optionally ask a follow-up). Empty bindings alone never trigger an
  ontology change.

### [3] INFO handler — graph-aware, LLM-authored UPDATE  *(new + reuses provenance)*
- **Prompt context:** TBox + **Graph Catalog (purpose + writability per graph)** +
  **entity-resolution context** (existing URIs for the owner and recently-seen
  entities, so the LLM *reuses* nodes instead of duplicating them) + the
  **provenance pattern** (Claim/Evidence vocabulary) + the segment text.
- **LLM emits a SPARQL UPDATE** that (a) targets the correct named graph(s),
  (b) reuses resolved entity URIs, and (c) **includes the provenance triples**
  (a `Claim` node per asserted base fact, with `sourceSpan`, `confidence`,
  `evidence`, `sessionId`), plus (d) an optional ontology-delta if vocabulary is
  missing.
- **WRITE-GATEWAY (the core guardrail — this is how decision 1 stays safe):**
  1. **Parse** the UPDATE into algebra.
  2. **Authorize:** allow only `INSERT DATA` / `DELETE DATA` / `DELETE/INSERT … WHERE`;
     reject `DROP|CLEAR|LOAD|MOVE|COPY`; enforce **per-graph writability** via the
     Graph Catalog (never write `urn:<agent>:self` or pipeline-managed
     `claims|evidence|conflicts|inferred` outside their owners).
  3. **Provenance enforcement (SHACL):** reject "naked" base-fact inserts that lack
     the Claim/Evidence pattern — the audit trail cannot be bypassed even though the
     LLM wrote the query.
  4. **Dry-run on a staging graph + consistency check** (reasoner + SHACL). On
     inconsistency, return diagnostics to the LLM for **one** repair attempt, else
     reject.
  5. **Versioned commit:** snapshot/delta before commit; commit atomically; append a
     **changeset** (source, session, timestamp, diff) for rollback.
- **Belief revision (fixes defect 2):** runs at commit but respects **functional vs
  non-functional** properties and **temporal scope**. Multi-valued facts (a career
  history) are retained; only genuinely functional properties or explicit
  contradictions supersede. Employment/roles should be time-scoped (`start`/`end`)
  rather than overwritten.

### [4] Ontology evolution  *(decision 2)*
Extension proposals (from INFO, or suggested by QUESTION) are **auto-applied iff**
the resulting TBox + ABox passes the reasoner + SHACL consistency gate; otherwise
rejected/queued. **Versioning:** build on the existing `OntologyManager`
(`packages/semantic-memory/src/ontology/OntologyManager.ts`, already has a
`versions/vNNN` store) — every accepted delta becomes a new version with a diff,
provenance, and a reversible undo; ABox changesets are logged alongside. Rollback =
restore version + replay/undo changeset.

### The Graph Catalog (single source of truth)  *(new, foundational)*
Extend `GraphRegistry` (`packages/semantic-memory/src/utils/GraphRegistry.ts`,
already tracks `writableBy`/`assertWritable`) so each named graph has a precise
**machine- and LLM-readable description + write policy**. This one catalog feeds
*both* the LLM prompts (so the model knows what each graph is for) *and* the
gateways (so the code enforces it). No more divergence between "what the prompt says"
and "what the code does".

## Consequences

**Positive**
- Real LLM intelligence decides routing, queries, and graph placement — the
  architect's goal.
- Directly fixes both observed defects (entity resolution; multi-valued history).
- NL→SPARQL is the auditable, reasoner-backed answering path — the H2 (multi-hop) /
  H4 (provenance) differentiators for the paper.
- Self-extending ontology with safety and reversibility.

**Negative / risks (and mitigations)**
- *LLM-authored UPDATEs are high-risk.* → The WRITE-GATEWAY (parse/authorize/
  SHACL/dry-run/version) is load-bearing and must be airtight; treat it as the
  security boundary.
- *Hallucinated-but-valid SPARQL* (runs, wrong meaning). → schema validation +
  result verbalization with provenance + an eval suite of question/answer pairs.
- *Ontology drift.* → consistency gate + versioning + periodic curation; reuse
  `similarExistingTerms`/`map_to_existing` already in proposals.
- *More LLM calls / latency / non-determinism.* → acceptable per project principle
  (no token budgets); tests use snapshot-based acceptance, not exact-output asserts.

**Reused vs. new**
- *Reuse:* `SemanticParser` (becomes the INFO extraction helper), `GraphRegistry`
  (+writability), Claim/Evidence provenance (`ClaimProvenanceService`),
  `reasoner.materialize`, `ReflectionRunner` (belief revision), `OntologyManager`
  (versioning), agent tool-loop, `triplestore.query/update`.
- *New:* Segmenter/IntentRouter; NL→SPARQL question handler; READ- and WRITE-gateways;
  SHACL shapes + consistency gate (no SHACL in the code today); Graph-Catalog
  descriptions surfaced into prompts; entity-resolution context builder; fixed
  belief revision (functional/temporal).

## Implementation plan (phased)

- **P0 — Foundations:** Graph Catalog (descriptions + write policy in
  `GraphRegistry`); entity-resolution context builder (owner + recent entities).
- **P1 — Segmenter/IntentRouter:** Stage 0 LLM call → tagged segments; wire to
  existing handlers; compose replies.
- **P2 — INFO + WRITE-GATEWAY:** LLM-authored UPDATE; gateway (authorize,
  provenance-SHACL, dry-run+consistency, versioned commit); fixed belief revision
  (functional/temporal).
- **P3 — QUESTION + READ-GATEWAY:** NL→SPARQL; read sandbox; provenance-cited NL
  answers; cannot-express → proposal.
- **P4 — Ontology auto-evolution:** consistency gate + versioning/rollback;
  proposal handling.
- **P5 — ACTION refinement:** intent→plan→tools polish (largely existing).

## Acceptance test (runs every phase)

Re-ingest the 2026-06-03 CV, then assert:
1. CV facts land in `urn:<agent>:user:<owner>` (not `worldview`).
2. Owner is **resolved** to one node (no `user:owner` vs `Alex_M` split;
   linked/merged).
3. The **full career history is preserved** (no false supersession); functional
   facts (name, email) remain single-valued.
4. Every base fact has a Claim + Evidence with `sourceSpan`.
5. Asking "Where does Alex M. work?" returns the **current** role via SPARQL, with a
   provenance citation.

## Open questions
- SHACL engine for Node (e.g. `rdf-validate-shacl`) vs a custom checker.
- Exact signal for the LLM's "cannot express in SPARQL" (explicit field vs
  confidence threshold).
- Transaction granularity (per-segment vs per-message) for the versioned changeset.
