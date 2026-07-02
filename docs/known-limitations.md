# Known Limitations (v0.1)

> This document lists known correctness and scaling limitations that
> affect Ontofelia's semantic-memory and knowledge-graph subsystems.
> Each entry states **what** the limitation is, **why** it matters, and
> its **current status**.
>
> For the broader roadmap (features in development, planned, long-term)
> see [Known Gaps & Roadmap](known_gaps.md).

---

## 1. Truth-Maintenance: Multi-Valued Fact Supersession

**What:** The belief-revision layer in `KnowledgeEngine.storeFact` now
only supersedes existing facts when the predicate is declared as
`owl:FunctionalProperty` in the TBox (e.g. `hasBirthday`, `livesIn`).
Non-functional properties (`worksAt`, `hasRole`, `memberOf`, `knows`, …)
correctly accumulate multiple values.

**Prior behaviour (bug):** Every same-(subject, predicate) pair was
treated as single-valued: ingesting "Alice worksAt BigCorp" would
supersede "Alice worksAt Acme", collapsing career history to the
last-ingested value (~17/21 claims wrongly superseded in a CV test).

**Current status:** Fixed in `rel/correctness-bugs`. The fix:
- Added `isFunctionalProperty()` TBox guard on the supersession path.
- Declared `hasBirthday` and `livesIn` as `owl:FunctionalProperty` in
  `ontofelia-core.ttl`.
- Regression tests in `SupersessionMultiValue.test.ts`.

**Residual risk:** Predicates auto-registered at runtime (not in the
admin TBox) default to multi-valued, which is correct per OWL semantics
but may surprise users expecting "latest wins" for some custom property.
If needed, admin users can manually add `owl:FunctionalProperty` typing
to the shared ontology.

---

## 2. Entity Resolution: Owner ↔ Named Person Gap

**What:** The canonical user entity (`urn:ontofelia:entity:user:owner`)
and named-person entities (e.g. `urn:ontofelia:entity:Alice`) were not
linked, so queries about "the owner" or by the user's actual name would
miss each other's facts.

**Current status:** Fixed in `rel/correctness-bugs`. When the user
declares their own name (e.g. "My name is Alice"), an `owl:sameAs` link
is now materialized between the user entity and the named entity.
Regression tests in `OwnerEntityResolution.test.ts`.

**Residual limitation:** `owl:sameAs` expansion at query time is not yet
implemented in all query paths (e.g. `memory_ask` tool,
`getFactsAbout`). The `sameAs` triples are stored and available to the
RDFS/OWL reasoner, but ad-hoc SPARQL queries that use direct URI
matching (without property paths or UNION) will not automatically follow
the link. Full query-time sameAs expansion is planned for v0.2.

---

## 3. Knowledge Graph Scaling

**What:** The embedded Oxigraph triplestore runs in-process and is
single-threaded for writes. Ingestion-heavy workloads (bulk document
upload, rapid multi-session ingestion) may cause latency spikes, and
the working set is limited to available RAM.

**Impact:** For personal assistants with < 100 k triples the current
architecture is sufficient. Larger deployments or multi-user scenarios
will need either the optional Fuseki backend or a future migration to a
dedicated graph database.

**Tracking:** Oxigraph write throughput and KG memory-footprint profiling.

---

## 4. `owl:propertyChainAxiom` Not Yet Wired

**What:** The `reasonable` OWL2 RL reasoner supports property-chain
axioms (e.g. `parent ∘ sibling → uncle`), but no property chains are
declared in `ontofelia-core.ttl` and the `ReasonableEngine` does not
yet expose an API for registering chain axioms at runtime.

**Impact:** Complex relational inferences that depend on property
composition (family relationships, organizational hierarchies beyond
`partOf`/`locatedIn`) require manual user input rather than automatic
reasoning.

**Tracking:** property-chain support in the reasoning layer.

---

## 5. Entity Resolution: Same-Name, Different-Entity Disambiguation

**What:** `KnowledgeEngine.findEntityByLabel()` reuses an existing node
when its `rdfs:label` matches the incoming name case-insensitively.
Previously this match ran across ALL graphs with no type check, so two
genuinely different entities that share a name — the person "Paris" and
the city "Paris" — were silently merged into one node by `resolveEntity`.

**Why:** Merging distinct referents corrupts the graph: facts about the
person and the city accumulate on the same URI, and no later query can
separate them again.

**Current status:** Fixed with a conservative, type-aware guard. When a
`type` is supplied, `resolveEntity` now only reuses a label match that is
type-compatible — either already an instance of the target class, or
carrying no declared type. If the only same-label match has a *different*
declared type, a fresh, disambiguated URI is minted instead (the slug URI
plus a type suffix, e.g. `…:entity:Paris_Person`). Behaviour is unchanged
when no type is passed. Regression tests in
`EntityTypeDisambiguation.test.ts`.

**Residual risk:** Disambiguation is by declared type only — this is not
a full entity-resolution / coreference system. Two entities of the *same*
type that share a name (two different people both called "Alex Müller")
are still merged, and two mentions of the *same* real-world entity under
different names are not linked. Type comparison is exact-class (no
subclass tolerance), so a match typed only with a super-/subclass of the
requested class is treated as a conflict and gets a fresh URI rather than
being reused. Genuine disambiguation across same-type homonyms is planned
for a later entity-resolution pass.
