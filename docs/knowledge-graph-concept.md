# Ontofelia's Knowledge Graph – Concept

This document defines the complete named-graph topology, the naming conventions,
the Claim/Evidence provenance model, and the knowledge-maturation pipeline for
Ontofelia and all future agents in the multi-agent system.

---

## 1. Naming conventions

The system distinguishes two URI namespaces:

| Scope | Pattern | Example |
|-------|--------|----------|
| **Cross-agent** | `urn:shared:<graph>` | `urn:shared:ontology` |
| **Agent-specific** | `urn:<agent>:<graph>` | `urn:ontofelia:self`, `urn:john:worldview` |

The `<agent>` part is the agent's unique, lowercase identifier (e.g. `ontofelia`, `john`).

### Namespace prefixes (Turtle)

```turtle
@prefix shared:  <urn:shared:> .
@prefix onto:    <urn:ontofelia:> .
@prefix core:    <urn:shared:ontology#> .
@prefix claim:   <urn:claim:> .
@prefix ev:      <urn:evidence:> .
@prefix xsd:     <http://www.w3.org/2001/XMLSchema#> .
@prefix rdfs:    <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl:     <http://www.w3.org/2002/07/owl#> .
@prefix sh:      <http://www.w3.org/ns/shacl#> .
```

---

## 2. Named-graph topology

### Layer 1: Shared knowledge (cross-agent)

These graphs apply to **all** agents. No agent may write here directly —
changes happen only through administration or the consolidation process (→ section 5).

#### `urn:shared:ontology` – the foundational model (TBox)

Defines the classes and properties permitted across the whole system.
Static, versioned, changeable only by administration.

```turtle
# Example content of urn:shared:ontology
GRAPH <urn:shared:ontology> {
  core:Person    a owl:Class ; rdfs:label "Person" .
  core:Project   a owl:Class ; rdfs:label "Project" .
  core:Tool      a owl:Class ; rdfs:label "Tool" .
  core:Agent     a owl:Class ; rdfs:label "Agent" ;
                 rdfs:subClassOf core:Person .

  core:livesIn   a owl:ObjectProperty ;
                 rdfs:domain core:Person ;
                 rdfs:range  core:Place ;
                 rdfs:label  "lives in" .

  core:worksOn   a owl:ObjectProperty ;
                 rdfs:domain core:Person ;
                 rdfs:range  core:Project ;
                 rdfs:label  "works on" .

  core:usesTool  a owl:ObjectProperty ;
                 rdfs:domain core:Agent ;
                 rdfs:range  core:Tool ;
                 rdfs:label  "uses tool" .
}
```

#### `urn:shared:meta` – the graph registry

Metadata about every existing graph: who may read/write,
which SHACL shapes apply, which retention policy.

```turtle
GRAPH <urn:shared:meta> {
  <urn:shared:ontology> a core:NamedGraph ;
      core:graphType    "tbox" ;
      core:writableBy   "admin" ;
      core:visibility   "public" ;
      core:shapeSet     <urn:shared:shapes#OntologyShape> .

  <urn:ontofelia:self> a core:NamedGraph ;
      core:graphType    "self-model" ;
      core:writableBy   "admin" ;
      core:visibility   "agent-only" ;
      core:owner        <urn:ontofelia:self#Ontofelia> .

  <urn:ontofelia:schema> a core:NamedGraph ;
      core:graphType    "schema" ;
      core:writableBy   "pipeline" ;
      core:visibility   "agent-only" .

  <urn:ontofelia:claims> a core:NamedGraph ;
      core:graphType    "claims" ;
      core:writableBy   "pipeline" ;
      core:visibility   "agent-only" .

  <urn:ontofelia:evidence> a core:NamedGraph ;
      core:graphType    "evidence" ;
      core:writableBy   "pipeline" ;
      core:visibility   "agent-only" ;
      core:retentionDays 365 .

  <urn:shared:claims> a core:NamedGraph ;
      core:graphType    "shared-claims" ;
      core:writableBy   "consolidation" ;
      core:visibility   "public" .

  <urn:shared:evidence> a core:NamedGraph ;
      core:graphType    "shared-evidence" ;
      core:writableBy   "consolidation" ;
      core:visibility   "public" .
}
```

#### `urn:shared:shapes` – SHACL constraints

Validation rules checked before every write.

```turtle
GRAPH <urn:shared:shapes> {
  core:PersonShape a sh:NodeShape ;
      sh:targetClass core:Person ;
      sh:property [
          sh:path  rdfs:label ;
          sh:minCount 1 ;
          sh:datatype xsd:string ;
      ] ;
      sh:property [
          sh:path  core:livesIn ;
          sh:maxCount 1 ;
          sh:class core:Place ;
      ] .
}
```

#### `urn:shared:world` – consensus truth

General world knowledge promoted here via multi-agent consolidation.
No agent writes directly — facts are adopted from individual worldviews
when the consolidation policy finds enough independent evidence, trust, and
conflict-freedom (→ section 5).

```turtle
GRAPH <urn:shared:world> {
  <urn:entity:Berlin> a core:Place ;
      rdfs:label "Berlin" ;
      core:isCapitalOf <urn:entity:Germany> .

  <urn:entity:Oxigraph> a core:Tool ;
      rdfs:label "Oxigraph" ;
      core:category "Embedded RDF Triplestore" .
}
```

---

### Layer 2: Agent self-model

These graphs define a single agent's identity, capabilities, and environment.
**Write-protected** — changeable only by administration or tightly controlled guardian policies.

#### `urn:<agent>:self` – identity and persona

```turtle
GRAPH <urn:ontofelia:self> {
  onto:self#Ontofelia a core:Agent ;
      rdfs:label       "Ontofelia" ;
      core:personality  "empathetic, curious, analytical" ;
      core:language     "en" ;
      core:autonomyLevel "semi-autonomous" ;
      core:coreGoal     "Semantic knowledge management for the user" ;
      core:greeting     "Hi! I'm Ontofelia." .
}
```

#### `urn:<agent>:skills` – available tools and MCP services

Generated **automatically from the MCP tool registration** at startup, not maintained by hand.
Read-only for all other components.

```turtle
GRAPH <urn:ontofelia:skills> {
  onto:skills#memory_ask a core:Skill ;
      rdfs:label   "memory_ask" ;
      core:type    "mcp-tool" ;
      core:description "Asks a question against the knowledge graph" .

  onto:skills#web_search a core:Skill ;
      rdfs:label   "web_search" ;
      core:type    "mcp-tool" ;
      core:description "Searches the web" .
}
```

#### `urn:<agent>:setup` – technical environment

```turtle
GRAPH <urn:ontofelia:setup> {
  onto:setup#Environment a core:Setup ;
      core:hostname     "example-server.example.org" ;
      core:sandboxLevel "restricted" ;
      core:triplestoreBackend "oxigraph" ;
      core:reasonerBackend "reasonable" ;
      core:hasFilesystemAccess true .
}
```

---

### Layer 3: Agent knowledge (long-term memory)

#### `urn:<agent>:user:<USER_ID>` – user-specific knowledge

Dedicated per user. Strict isolation: agent X only sees its own user graphs.

```turtle
GRAPH <urn:ontofelia:user:testuser> {
  <urn:entity:Alice> a core:Person ;
      rdfs:label       "Alice" ;
      core:profession  "Software Engineer" ;
      core:livesIn     <urn:entity:Berlin> ;
      core:interest    "reading", "hiking", "technology" ;
      core:expectation "Autonomous knowledge assistant" .
}
```

**Claim provenance** (→ section 4):

```turtle
GRAPH <urn:ontofelia:claims> {
  claim:20260518_143000_001 a core:Claim ;
      core:claimSubject    <urn:entity:Alice> ;
      core:claimPredicate  core:livesIn ;
      core:claimObject     <urn:entity:Berlin> ;
      core:assertedInGraph <urn:ontofelia:user:testuser> ;
      core:learnedAt       "2026-05-18T14:30:00Z"^^xsd:dateTime ;
      core:acceptedAt      "2026-05-18T14:30:03Z"^^xsd:dateTime ;
      core:confidence      "0.95"^^xsd:decimal ;
      core:confidenceLabel "high" ;
      core:sourceKind      "user" ;
      core:sourceMessageId "msg_20260518_143000_001" ;
      core:ingestionRunId  "ing_20260518_143000" ;
      core:assertedBy      <urn:ontofelia:self#Ontofelia> ;
      core:privacyClass    "profile" ;
      core:retentionPolicy "user-controlled" ;
      core:status          "accepted" ;
      core:hasEvidence     ev:msg_20260518_143000_001 ;
      core:evidenceGraph   <urn:ontofelia:evidence> .
}

GRAPH <urn:ontofelia:evidence> {
  ev:msg_20260518_143000_001 a core:Evidence ;
      core:evidenceType    "message-span" ;
      core:sourceMessageId "msg_20260518_143000_001" ;
      core:sessionId       "sess_abc123" ;
      core:channel         "chat" ;
      core:actor           <urn:entity:Alice> ;
      core:rawText         "I live in Berlin" ;
      core:capturedAt      "2026-05-18T14:30:00Z"^^xsd:dateTime .
}
```

#### `urn:<agent>:worldview` – individual world view

The agent's individual world knowledge — facts the agent actively uses.
Extends `urn:shared:world` with individual findings. Facts land here
immediately as accepted on arrival (truth-maintenance model, → section 5).

```turtle
GRAPH <urn:ontofelia:worldview> {
  <urn:entity:Ontofelia_Project> a core:Project ;
      rdfs:label    "Ontofelia" ;
      core:techStack "TypeScript, Oxigraph, Reasonable, Turborepo" ;
      core:repoUrl  "https://github.com/ORG/ontofelia" .
}

GRAPH <urn:ontofelia:claims> {
  claim:20260518_150000_001 a core:Claim ;
      core:claimSubject    <urn:entity:Ontofelia_Project> ;
      core:claimPredicate  core:techStack ;
      core:claimObject     "TypeScript, Oxigraph, Reasonable, Turborepo" ;
      core:assertedInGraph <urn:ontofelia:worldview> ;
      core:learnedAt       "2026-05-18T15:00:00Z"^^xsd:dateTime ;
      core:acceptedAt      "2026-05-18T15:00:02Z"^^xsd:dateTime ;
      core:confidence      "0.95"^^xsd:decimal ;
      core:confidenceLabel "high" ;
      core:sourceKind      "user" ;
      core:sourceMessageId "msg_20260518_150000_001" ;
      core:ingestionRunId  "ing_20260518_150000" ;
      core:assertedBy      <urn:ontofelia:self#Ontofelia> ;
      core:privacyClass    "project" ;
      core:retentionPolicy "project-memory" ;
      core:status          "accepted" ;
      core:hasEvidence     ev:msg_20260518_150000_001 ;
      core:evidenceGraph   <urn:ontofelia:evidence> .
}

GRAPH <urn:ontofelia:evidence> {
  ev:msg_20260518_150000_001 a core:Evidence ;
      core:evidenceType    "message-span" ;
      core:sourceMessageId "msg_20260518_150000_001" ;
      core:sessionId       "sess_abc123" ;
      core:channel         "chat" ;
      core:actor           <urn:entity:Alice> ;
      core:rawText         "Ontofelia uses TypeScript, Oxigraph, Reasonable, and Turborepo" ;
      core:capturedAt      "2026-05-18T15:00:00Z"^^xsd:dateTime .
}
```

#### `urn:<agent>:schema` – agent-local schema extension

Ontofelia follows a **truth-maintenance model**: a new fact is treated as true
on arrival (`status "accepted"`). There is no proposal staging for uncertain
facts — contradictions are resolved afterwards via belief revision (→ section 4),
not by an upfront review.

This shifts the problem from the *facts* to the *predicates*: the
`SemanticParser` continually extracts new predicates (`workedAt`, `hasPhone`,
`studiedAt`, …) that are not in the admin-only TBox `urn:shared:ontology`.
These are **not** written into the shared TBox but into the agent-local schema
graph `urn:<agent>:schema`. That keeps the shared TBox protected while the agent
can use new predicates immediately.

`urn:<agent>:schema` holds only lightweight predicate registrations
(`rdf:Property` + `rdfs:label`). Domain/range and OWL characteristics are
deliberately not set here — that enrichment is reserved for administration or a
later schema-consolidation process.

```turtle
GRAPH <urn:ontofelia:schema> {
  core:workedAt  a rdf:Property ; rdfs:label "workedAt" .
  core:hasPhone  a rdf:Property ; rdfs:label "hasPhone" .
  core:studiedAt a rdf:Property ; rdfs:label "studiedAt" .
}
```

The corresponding fact is written normally and immediately accepted into its
target graph (e.g. `urn:<agent>:user:<ID>`), with a `core:Claim` in
`urn:<agent>:claims` — exactly like a fact with an already-known predicate.

#### `urn:<agent>:conflicts` – detected contradictions

A standalone graph. Conflicts are not annotations but standalone objects with
context and a resolution status.

Since every fact is accepted immediately, a conflict typically arises between
two accepted claims with the same `claimSubject`/`claimPredicate` but a
different `claimObject` (→ section 4, belief revision).

```turtle
GRAPH <urn:ontofelia:conflicts> {
  onto:conflicts#c_20260518_001 a core:Conflict ;
      core:subject       <urn:entity:Alice> ;
      core:property      core:livesIn ;
      core:valueA        <urn:entity:Berlin> ;
      core:valueB        <urn:entity:Munich> ;
      core:detectedAt    "2026-05-18T17:00:00Z"^^xsd:dateTime ;
      core:status        "unresolved" ;
      core:claimA        claim:20260518_143000_001 ;
      core:claimB        claim:20260601_090000_001 ;
      core:description   "Contradiction: Alice lives in Berlin vs. Munich — two accepted claims." .
}
```

The agent must act: research, ask, or as a last resort contact the user
(derive the user URI from `urn:<agent>:user:<ID>`).

---

### Layer 4: Working memory (short-term memory)

#### `urn:<agent>:session:<SESSION_ID>` – conversation context

Short-lived. Holds the current working context: loaded documents, intermediate
results, temporary facts.

```turtle
GRAPH <urn:ontofelia:session:sess_abc123> {
  onto:session#sess_abc123 a core:Session ;
      core:startedAt  "2026-05-18T14:00:00Z"^^xsd:dateTime ;
      core:userId     <urn:entity:Alice> ;
      core:topic      "Memory Architecture Review" .

  onto:session#sess_abc123 core:activeDocument "/path/to/Ontofelia/docs/memory-architecture.md" .
  onto:session#sess_abc123 core:intermediateResult "15 TODOs identified, 4 priority levels" .
}
```

**Lifecycle:** session inactive > 4h → archivable. Summary → `user:<ID>`.
The session graph is then deleted (removed without a trace).

---

## 3. Complete overview

```
urn:shared:ontology           TBox – classes & properties (static)
urn:shared:meta               graph registry & policies
urn:shared:shapes             SHACL validation rules
urn:shared:world              consensus truth (multi-agent consolidation)
urn:shared:claims             provenance for consensus facts
urn:shared:evidence           evidence for public consensus facts
│
├── urn:ontofelia:self         identity & persona
├── urn:ontofelia:skills       MCP tools (auto-generated, read-only)
├── urn:ontofelia:setup        technical environment
├── urn:ontofelia:user:*       per-user knowledge
├── urn:ontofelia:claims       claim provenance
├── urn:ontofelia:evidence     evidence / source material
├── urn:ontofelia:worldview    individual world knowledge
├── urn:ontofelia:schema       agent-local predicate definitions
├── urn:ontofelia:conflicts    detected contradictions
├── urn:ontofelia:session:*    conversation context (short-lived)
│
├── urn:john:self              (same structure for agent "John")
├── urn:john:skills
├── urn:john:worldview
└── ...
```

---

## 4. Provenance model: Claim/Evidence

As its stable core model, Ontofelia uses **not RDF-star annotations** but
explicit `core:Claim` and `core:Evidence` objects. The actual fact stays a
normal RDF triple in the target graph. Claims and evidence are deliberately
separated:

- `urn:<agent>:claims` holds all of the agent's claim objects (accepted,
  superseded, retracted).
- `urn:<agent>:evidence` holds the agent's evidence objects and source material.
- `urn:shared:claims` holds consolidation claims for `urn:shared:world`.
- `urn:shared:evidence` holds public evidence for consensus facts, if any.

Claims reference evidence objects via `core:hasEvidence` and the graph that holds
that evidence via `core:evidenceGraph`.

This model is deliberately RDF-1.1 compatible. Oxigraph can partly support
RDF-star/SPARQL-star, but provenance must not depend on an experimental
statement syntax. For inference, Reasonable receives only the accepted knowledge
graphs, not the Claim/Evidence metadata.

### Why Claim/Evidence?

- **Backend-robust** – works with Oxigraph, backups, exports, and plain SPARQL
- **Reasoner-friendly** – Reasonable sees only real facts, not metadata about facts
- **Revisable** – accepted, superseded, rejected, and retracted are normal status values
- **Sourceable** – multiple pieces of evidence can support or refute the same claim
- **Separable** – claims can live longer while raw evidence is deleted or anonymized earlier
- **Deletable** – fact, claim, and evidence can be removed together by policy

### Mandatory fields per claim

Every fact extracted by the `SemanticParser` **must** carry these fields as a claim:

| Field | Type | Required | Description |
|------|-----|---------|--------------|
| `core:claimSubject` | IRI | Yes | Subject of the asserted fact |
| `core:claimPredicate` | IRI | Yes | Predicate of the asserted fact |
| `core:claimObject` | IRI or literal | Yes | Object of the asserted fact |
| `core:assertedInGraph` | IRI | Yes | Graph in which the base fact is asserted |
| `core:learnedAt` | `xsd:dateTime` | Yes | Time of extraction |
| `core:confidence` | `xsd:decimal` | Yes | Internal certainty, e.g. `0.95` (a marker, not an acceptance gate) |
| `core:confidenceLabel` | `xsd:string` | Yes | Human-readable level: `"high"`, `"medium"`, `"low"` |
| `core:sourceKind` | `xsd:string` | Yes | `"user"`, `"agent"`, `"tool"`, `"consolidation"` |
| `core:ingestionRunId` | `xsd:string` | Yes | Unique run of the ingestion pipeline |
| `core:status` | `xsd:string` | Yes | `"accepted"`, `"superseded"`, `"rejected"`, `"retracted"` |

### Supplementary fields per claim

These fields are not always required but should be set whenever the information
is available. They make provenance auditable, explainable, and policy-capable.

| Field | Type | Description |
|------|-----|--------------|
| `core:sourceMessageId` | `xsd:string` | ID of the originating message, if the claim comes from communication |
| `core:sessionId` | `xsd:string` | Session ID of the source |
| `core:sourceSpan` | `xsd:string` | Text span the fact was learned from |
| `core:assertedBy` | IRI | Agent, human, or service that accepted/asserted the claim |
| `core:extractedBy` | IRI | Parser, agent, or tool that extracted the claim |
| `core:reviewedBy` | IRI | Agent, human, or policy that reviewed the claim |
| `core:acceptedAt` | `xsd:dateTime` | Time of acceptance |
| `core:rejectedAt` | `xsd:dateTime` | Time of rejection |
| `core:rejectionReason` | `xsd:string` | Reason for rejection |
| `core:validFrom` | `xsd:dateTime` | Start of validity, if the fact is time-bound |
| `core:validUntil` | `xsd:dateTime` | End of validity, if known |
| `core:supersedes` | IRI | Old claim this claim replaces |
| `core:supersededBy` | IRI | New claim that replaces this one |
| `core:privacyClass` | `xsd:string` | e.g. `"public"`, `"project"`, `"profile"`, `"private"`, `"secret"` |
| `core:retentionPolicy` | `xsd:string` | Deletion/archival rule, e.g. `"user-controlled"` |
| `core:hasSupportClaim` | IRI | Claim that supports a consolidation |
| `core:supportScore` | `xsd:decimal` | Weighted sum of supporting claims |
| `core:supportRatio` | `xsd:decimal` | Ratio of supporting claims vs. relevant counter/alternative claims |
| `core:supportAgentCount` | `xsd:int` | Number of distinct supporting agents |
| `core:independentSourceCount` | `xsd:int` | Number of independent source groups |
| `core:hasEvidence` | IRI | Reference to evidence objects |
| `core:evidenceGraph` | IRI | Named graph holding the linked evidence objects |

### Evidence objects

`core:Evidence` describes the concrete source of a claim. A claim can have
several pieces of evidence, e.g. a user statement, a tool result, and later web
research. Evidence objects are **not** stored in the claims graph but in
`urn:<agent>:evidence` or `urn:shared:evidence`.

| Field | Type | Description |
|------|-----|--------------|
| `core:evidenceType` | `xsd:string` | `"message-span"`, `"tool-result"`, `"document"`, `"web-source"`, `"manual-review"` |
| `core:sourceMessageId` | `xsd:string` | ID of the message the evidence comes from |
| `core:sessionId` | `xsd:string` | Session context |
| `core:channel` | `xsd:string` | Communication channel, e.g. `"chat"`, `"cli"`, `"telegram"`, `"web"` |
| `core:actor` | IRI | User, agent, or tool that produced the evidence |
| `core:rawText` | `xsd:string` | Original text or a short span |
| `core:sourceUri` | IRI | Document, file, or web URI, if available |
| `core:sourceGraph` | IRI | Named graph the evidence content originates from, if applicable |
| `core:contentHash` | `xsd:string` | Hash for repeatable matching without full text |
| `core:capturedAt` | `xsd:dateTime` | Time of capture |

### Example: accepted fact with claim

```turtle
GRAPH <urn:ontofelia:user:testuser> {
  <urn:entity:Alice> core:profession "Software Engineer" .
}

GRAPH <urn:ontofelia:claims> {
  claim:20260518_143000_002 a core:Claim ;
      core:claimSubject    <urn:entity:Alice> ;
      core:claimPredicate  core:profession ;
      core:claimObject     "Software Engineer" ;
      core:assertedInGraph <urn:ontofelia:user:testuser> ;
      core:learnedAt       "2026-05-18T14:30:00Z"^^xsd:dateTime ;
      core:acceptedAt      "2026-05-18T14:30:03Z"^^xsd:dateTime ;
      core:confidence      "0.95"^^xsd:decimal ;
      core:confidenceLabel "high" ;
      core:sourceKind      "user" ;
      core:sourceMessageId "msg_20260518_143000_002" ;
      core:ingestionRunId  "ing_20260518_143000" ;
      core:sourceSpan      "I am a Software Engineer" ;
      core:sessionId       "sess_abc123" ;
      core:assertedBy      <urn:ontofelia:self#Ontofelia> ;
      core:privacyClass    "profile" ;
      core:retentionPolicy "user-controlled" ;
      core:status          "accepted" ;
      core:hasEvidence     ev:msg_20260518_143000_002 ;
      core:evidenceGraph   <urn:ontofelia:evidence> .
}

GRAPH <urn:ontofelia:evidence> {
  ev:msg_20260518_143000_002 a core:Evidence ;
      core:evidenceType    "message-span" ;
      core:sourceMessageId "msg_20260518_143000_002" ;
      core:sessionId       "sess_abc123" ;
      core:channel         "chat" ;
      core:actor           <urn:entity:Alice> ;
      core:rawText         "I am a Software Engineer" ;
      core:capturedAt      "2026-05-18T14:30:00Z"^^xsd:dateTime .
}
```

### Example: query over facts and provenance

```sparql
# All accepted facts about Alice with provenance
PREFIX core: <urn:shared:ontology#>
SELECT ?p ?o ?when ?conf ?src ?privacy ?evidence ?evidenceGraph WHERE {
  GRAPH <urn:ontofelia:user:testuser> {
    <urn:entity:Alice> ?p ?o .
  }
  GRAPH <urn:ontofelia:claims> {
    ?claim a core:Claim ;
        core:claimSubject    <urn:entity:Alice> ;
        core:claimPredicate  ?p ;
        core:claimObject     ?o ;
        core:assertedInGraph <urn:ontofelia:user:testuser> ;
        core:learnedAt       ?when ;
        core:confidence      ?conf ;
        core:sourceKind      ?src ;
        core:status          "accepted" .
    OPTIONAL { ?claim core:privacyClass ?privacy . }
    OPTIONAL { ?claim core:hasEvidence ?evidence . }
    OPTIONAL { ?claim core:evidenceGraph ?evidenceGraph . }
  }
}
ORDER BY DESC(?when)
```

### Belief revision on contradictions

When a new claim contradicts an existing fact, it is not overwritten directly.
The `ConflictDetector` looks for claims with the same `claimSubject` and
`claimPredicate` but a different `claimObject`.

```sparql
# Find known livesIn claims for Alice
PREFIX core: <urn:shared:ontology#>
SELECT ?claim ?place ?when ?conf WHERE {
  GRAPH <urn:ontofelia:claims> {
    ?claim a core:Claim ;
        core:claimSubject    <urn:entity:Alice> ;
        core:claimPredicate  core:livesIn ;
        core:claimObject     ?place ;
        core:assertedInGraph <urn:ontofelia:user:testuser> ;
        core:learnedAt       ?when ;
        core:confidence      ?conf ;
        core:status          "accepted" .
  }
}
ORDER BY DESC(?when)
```

The agent must actively resolve the conflict: research, ask, or contact the
user. On resolution the old claim is typically set to `"superseded"` and the
active base fact replaced. A **traceless hard delete** remains a separate
privacy/retention operation (see section 7).

```turtle
GRAPH <urn:ontofelia:claims> {
  claim:20260518_143000_001 core:status "superseded" ;
      core:supersededBy claim:20260601_090000_001 .

  claim:20260601_090000_001 a core:Claim ;
      core:claimSubject    <urn:entity:Alice> ;
      core:claimPredicate  core:livesIn ;
      core:claimObject     <urn:entity:Berlin> ;
      core:assertedInGraph <urn:ontofelia:user:testuser> ;
      core:supersedes      claim:20260518_143000_001 ;
      core:validFrom       "2026-06-01T09:00:00Z"^^xsd:dateTime ;
      core:learnedAt       "2026-06-01T09:00:00Z"^^xsd:dateTime ;
      core:acceptedAt      "2026-06-01T09:00:05Z"^^xsd:dateTime ;
      core:confidence      "0.90"^^xsd:decimal ;
      core:confidenceLabel "high" ;
      core:sourceKind      "user" ;
      core:ingestionRunId  "ing_20260601_090000" ;
      core:reviewedBy      <urn:ontofelia:self#Ontofelia> ;
      core:privacyClass    "profile" ;
      core:retentionPolicy "user-controlled" ;
      core:status          "accepted" .
}
```

---

## 5. Knowledge-maturation pipeline

Ontofelia follows a **truth-maintenance model**: there is no objective,
non-arbitrary criterion for when a source is "trustworthy enough" to accept a
fact — `confidence` is itself only an LLM estimate. Rather than invent such a
gate, every new fact is treated as true on arrival and becomes active
immediately. Contradictions are resolved afterwards via belief revision
(→ section 4), not by an upfront review.

Knowledge therefore passes through two stages:

```
  ┌─────────────────────┐
  │     worldview        │   Stage 1: belief
  │ (accepted on arrival)│   The SemanticParser writes here directly
  └──────────┬──────────┘   (or to user:<ID> / self depending on routing).
             │              The fact is true immediately, status "accepted".
     Multi-agent consolidation:
     independent evidence + trust + conflict-freedom
             │
  ┌──────────▼──────────┐
  │    shared:world      │   Stage 2: consensus truth
  │     (cross-agent)    │   Applies to all agents.
  └─────────────────────┘   Individual worldviews may optionally reference it.
```

### Stage 1: intake (truth maintenance)

The `SemanticIngestionService` writes every fact extracted by the
`SemanticParser` **immediately** as an accepted claim:

1. **Routing:** the fact is written into its target graph — `user:<ID>`,
   `worldview`, or (never written to) the write-protected `self` (→ section 2).
2. **New predicates:** a predicate not yet in `urn:shared:ontology` is registered
   in the agent-local `urn:<agent>:schema` — the shared TBox stays admin-only.
   The fact is usable immediately regardless.
3. **Claim/Evidence:** a `core:Claim` with `status "accepted"` is created in
   `urn:<agent>:claims`, the associated `core:Evidence` in `urn:<agent>:evidence`.
4. **Confidence:** recorded as `core:confidence` / `core:confidenceLabel` on the
   claim — as a marker for later conflict resolution and consolidation, not as an
   acceptance gate.
5. **Duplicate check:** if the exact triple already exists in the target graph,
   nothing is written.

There is no proposal-review step and no `worldview_proposal` graph.

### Conflict resolution instead of review

Contradictions are not prevented *before* intake but detected and resolved
*after* it. The `ConflictDetector` finds accepted claims with the same
`claimSubject`/`claimPredicate` but a different `claimObject`. Resolution runs
via belief revision (→ section 4): the outdated claim is set to
`status "superseded"`, the active base fact replaced. Every knowledge change
thus stays traceable and explainable.

### Stage 1 → 2: multi-agent consolidation

A periodic process (e.g. daily) that compares the accepted worldview claims of
all agents. `urn:shared:world` is not a simple majority graph but a vetted
consensus graph.

#### Promotion criteria

A fact may be promoted to `urn:shared:world` only if all conditions hold:

1. **Promotable fact:** the claim is in an agent `worldview`, has
   `status "accepted"`, and does not belong to self-model, session, user profile,
   or private graphs.
2. **Privacy filter:** `privacyClass` must not be `"profile"`, `"private"`, or
   `"secret"`. User-specific facts stay in `urn:<agent>:user:*`.
3. **Temporal validity:** `validUntil` must not be in the past. Claims with
   unknown temporal validity are weighted lower for volatile properties.
4. **Canonical fact key:** subject, predicate, and object are normalized before
   comparison (entity resolution, `owl:sameAs`, label aliases, datatype
   normalization).
5. **Independent evidence:** at least two independent source groups must support
   the fact. The same `sourceUri`, the same `contentHash`, the same
   `sourceMessageId`, or agents copied from one another do not count multiple times.
6. **Agent quorum:** at least two different agents must support the fact. On small
   installations an admin can explicitly configure a lower quorum.
7. **Weighted support:** the weighted support score must exceed the policy
   threshold. Claim confidence, agent trust, evidence quality, recency, and
   source kind are taken into account.
8. **Conflict veto:** there must be no active, highly trusted counter-claim with
   the same `claimSubject` and `claimPredicate` but a different `claimObject`.
9. **Shape validation:** the fact must validate against `urn:shared:shapes`.

#### Weighting model

Consolidation computes a support contribution per supporting claim:

```
support = confidence * agentTrust * evidenceWeight * recencyWeight * sourceWeight
```

Recommended starting values:

| Factor | Example |
|--------|----------|
| `agentTrust` | owner/admin agent: `1.2`, normal agent: `1.0`, new agent: `0.7` |
| `evidenceWeight` | tool/document evidence: `1.2`, direct user statement: `1.0`, derived statement: `0.7` |
| `recencyWeight` | current: `1.0`, potentially stale: `0.5` |
| `sourceWeight` | independent external source: `1.2`, agent-internal: `0.8` |

Default thresholds:

| Threshold | Value |
|----------|------|
| Minimum agents | `2` |
| Minimum source groups | `2` |
| Minimum support score | `2.0` |
| Minimum support ratio | `0.60` |

#### Conceptual query

```sparql
# Candidates: accepted worldview claims, privacy-filtered and not expired
PREFIX core: <urn:shared:ontology#>
PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>

SELECT ?s ?p ?o
       (COUNT(DISTINCT ?agentId) AS ?agentCount)
       (COUNT(DISTINCT ?sourceGroup) AS ?sourceGroupCount)
       (SUM(?weightedSupport) AS ?supportScore)
WHERE {
  GRAPH ?claimGraph {
    ?claim a core:Claim ;
        core:claimSubject    ?s ;
        core:claimPredicate  ?p ;
        core:claimObject     ?o ;
        core:assertedInGraph ?worldview ;
        core:confidence      ?confidence ;
        core:sourceKind      ?sourceKind ;
        core:status          "accepted" .

    OPTIONAL { ?claim core:privacyClass ?privacyClass . }
    OPTIONAL { ?claim core:validUntil ?validUntil . }
  }

  OPTIONAL {
    GRAPH ?claimGraph {
      ?claim core:hasEvidence ?evidence ;
             core:evidenceGraph ?evidenceGraph .
    }
    GRAPH ?evidenceGraph {
      ?evidence a core:Evidence .
      OPTIONAL { ?evidence core:sourceUri ?sourceUri . }
      OPTIONAL { ?evidence core:contentHash ?contentHash . }
      OPTIONAL { ?evidence core:sourceMessageId ?sourceMessageId . }
    }
  }

  FILTER(STRENDS(STR(?worldview), ":worldview"))
  FILTER(STRENDS(STR(?claimGraph), ":claims"))
  FILTER(!BOUND(?privacyClass) || ?privacyClass NOT IN ("profile", "private", "secret"))
  FILTER(!BOUND(?validUntil) || ?validUntil > NOW())

  BIND(REPLACE(STR(?worldview), "^urn:([^:]+):worldview$", "$1") AS ?agentId)
  BIND(COALESCE(?contentHash, STR(?sourceUri), ?sourceMessageId, STR(?claim)) AS ?sourceGroup)
  BIND(IF(?sourceKind = "tool", 1.2, IF(?sourceKind = "user", 1.0, 0.8)) AS ?sourceWeight)
  BIND((xsd:decimal(?confidence) * ?sourceWeight) AS ?weightedSupport)
}
GROUP BY ?s ?p ?o
HAVING (?agentCount >= 2 && ?sourceGroupCount >= 2 && ?supportScore >= 2.0)
```

#### Conflict veto

Before promotion the consolidator checks competing claims:

```sparql
PREFIX core: <urn:shared:ontology#>
PREFIX xsd:  <http://www.w3.org/2001/XMLSchema#>

ASK {
  GRAPH ?claimGraph {
    ?counterClaim a core:Claim ;
        core:claimSubject    ?s ;
        core:claimPredicate  ?p ;
        core:claimObject     ?otherObject ;
        core:confidence      ?counterConfidence ;
        core:status          "accepted" .
  }
  FILTER(?otherObject != ?o)
  FILTER(xsd:decimal(?counterConfidence) >= 0.80)
}
```

If a veto applies, no `shared:world` fact is written. Instead a `core:Conflict`
is created in the affected agent conflict graphs or in a later
`urn:shared:conflicts`.

#### Promotion and consolidation claim

On a successful promotion:

1. Write the base triple to `urn:shared:world`.
2. Create a consolidation claim in `urn:shared:claims`.
3. Link the supporting claims via `core:hasSupportClaim`.
4. Store support metrics (`supportScore`, `supportRatio`,
   `supportAgentCount`, `independentSourceCount`).
5. Do not delete individual worldview facts automatically; they can be marked as
   covered by `shared:world` via a retrieval policy.

```turtle
GRAPH <urn:shared:world> {
  <urn:entity:Oxigraph> core:category "Embedded RDF Triplestore" .
}

GRAPH <urn:shared:claims> {
  claim:consolidation_20260518_230000_001 a core:Claim ;
      core:claimSubject           <urn:entity:Oxigraph> ;
      core:claimPredicate         core:category ;
      core:claimObject            "Embedded RDF Triplestore" ;
      core:assertedInGraph        <urn:shared:world> ;
      core:learnedAt              "2026-05-18T23:00:00Z"^^xsd:dateTime ;
      core:acceptedAt             "2026-05-18T23:00:04Z"^^xsd:dateTime ;
      core:sourceKind             "consolidation" ;
      core:ingestionRunId         "consolidation_20260518_230000" ;
      core:assertedBy             <urn:shared:consolidator> ;
      core:reviewedBy             <urn:shared:consolidator> ;
      core:confidence             "0.91"^^xsd:decimal ;
      core:confidenceLabel        "high" ;
      core:status                 "accepted" ;
      core:supportScore           "3.42"^^xsd:decimal ;
      core:supportRatio           "0.80"^^xsd:decimal ;
      core:supportAgentCount      4 ;
      core:independentSourceCount 3 ;
      core:privacyClass           "public" ;
      core:retentionPolicy        "shared-world" ;
      core:hasSupportClaim        claim:ontofelia_20260518_150000_001,
                                  claim:john_20260518_151200_001 ;
      core:hasEvidence            ev:consolidation_report_20260518_230000_001 ;
      core:evidenceGraph          <urn:shared:evidence> .
}

GRAPH <urn:shared:evidence> {
  ev:consolidation_report_20260518_230000_001 a core:Evidence ;
      core:evidenceType "manual-review" ;
      core:actor        <urn:shared:consolidator> ;
      core:rawText      "Consolidation run found 4 supporting agents and 3 independent source groups." ;
      core:capturedAt   "2026-05-18T23:00:04Z"^^xsd:dateTime .
}
```

---

## 6. LLM context injection

### A. Always-on (system prompt) – on every message

| Graph | Purpose |
|-------|-------|
| `urn:<agent>:self` | Who am I? |
| `urn:<agent>:setup` | What can I do here? |
| `urn:<agent>:user:<current_ID>` | Who am I talking to? (core profile only!) |

**Important:** only a compact core profile is injected from the user graph
(name, profession, core goals, language). The full history stays on demand.

### B. Contextual (chat context)

| Graph | Purpose |
|-------|-------|
| `urn:<agent>:session:<current_ID>` | Current working topic |

### C. On-demand (active retrieval via tools)

| Graph | Purpose |
|-------|-------|
| `urn:shared:world` | General world knowledge |
| `urn:shared:claims` | Provenance and support metrics for consensus facts |
| `urn:shared:evidence` | Public evidence for consensus facts |
| `urn:<agent>:worldview` | Individual world knowledge |
| `urn:<agent>:claims` | Claim provenance and review history |
| `urn:<agent>:evidence` | Evidence, source material, and raw spans |
| `urn:shared:ontology` | Schema questions |
| `urn:<agent>:user:<ID>` (history) | Detailed user history |

Retrieval happens via **semantic macro-tools** (not raw SPARQL):
- `get_project_details(name)` → deterministic SPARQL query
- `find_person(name)` → vector search + 1–2 hop traversal
- `search_knowledge(query)` → hybrid GraphRAG pipeline

---

## 7. Deletions

Deleted triples can be removed from the Oxigraph store **without a trace and
permanently** when a privacy or retention policy requires it. The associated
claims and evidence objects must be removed too. Normal belief revision, by
contrast, should preferably use `status "superseded"` or `status "retracted"`
so the agent can explain its knowledge change.

```sparql
# Example: delete a fact and its provenance
PREFIX core: <urn:shared:ontology#>
DELETE {
  GRAPH <urn:ontofelia:user:testuser> {
    <urn:entity:Alice> core:livesIn <urn:entity:Berlin> .
  }
  GRAPH <urn:ontofelia:claims> {
    ?claim ?claimP ?claimO .
  }
  GRAPH <urn:ontofelia:evidence> {
    ?evidence ?evidenceP ?evidenceO .
  }
}
WHERE {
  GRAPH <urn:ontofelia:user:testuser> {
    <urn:entity:Alice> core:livesIn <urn:entity:Berlin> .
  }
  OPTIONAL {
    GRAPH <urn:ontofelia:claims> {
      ?claim a core:Claim ;
          core:claimSubject    <urn:entity:Alice> ;
          core:claimPredicate  core:livesIn ;
          core:claimObject     <urn:entity:Berlin> ;
          core:assertedInGraph <urn:ontofelia:user:testuser> .
      ?claim ?claimP ?claimO .
    }
    OPTIONAL {
      GRAPH <urn:ontofelia:claims> {
        ?claim core:hasEvidence ?evidence .
      }
      GRAPH <urn:ontofelia:evidence> {
        ?evidence ?evidenceP ?evidenceO .
      }
    }
  }
}
```

For shared facts the same pattern applies with `urn:shared:world`,
`urn:shared:claims`, and `urn:shared:evidence`.

---

## 8. Implementation order

1. **Oxigraph configuration:** stabilize the embedded store, data directory, backup/restore, and graph export
2. **Reasonable integration:** materialize only over accepted knowledge graphs, not over claims/evidence
3. **Bootstrap shared graphs:** populate `ontology`, `meta`, `shapes` with an init script
4. **GraphUriResolver:** central construction of `urn:<agent>:...` and `urn:shared:...`
5. **Migrate self-model:** merge `soul` + `identity` → `urn:ontofelia:self`
6. **SemanticIngestionService:** route to the target graph (user/worldview/session); every fact is accepted immediately
7. **ClaimProvenanceService + EvidenceStore:** write claims and evidence into separate graphs
8. **Agent schema graph:** register new predicates in `urn:<agent>:schema`, keep `urn:shared:ontology` admin-only
9. **SHACL/shape validation:** check against `urn:shared:shapes` before every write
10. **Conflict detection + belief revision:** detect contradictions over accepted claims → `urn:<agent>:conflicts`, resolve via `status "superseded"`
11. **Multi-agent consolidation:** weighted claim/evidence comparison → `shared:world` promotion
12. **Hybrid retrieval:** vector index + SPARQL templates + graph expansion
</content>
