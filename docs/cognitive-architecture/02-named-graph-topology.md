# 02 · Named-graph topology (extended)

> **Scope:** every new graph this concept introduces, its URI, its role, who
> may write it, retention, and the precise extensions to
> [`GraphRegistry`](../../packages/semantic-memory/src/utils/GraphRegistry.ts).
>
> **Constraint:** the existing graphs in
> [`docs/knowledge-graph-concept.md` §2](../knowledge-graph-concept.md) keep
> their URIs and semantics unchanged. New graphs are additive.

---

## 1. URI scheme

All cognitive-architecture graphs live under a dedicated infix `:cog:` so they
do not collide with the existing topology:

```
urn:<agent>:cog:<module>[:<scope>]
```

| Segment | Meaning | Valid values |
|---|---|---|
| `<agent>` | Agent identifier (already constrained: `^[a-z][a-z0-9_-]*$`) | e.g. `ontofelia`, `john` |
| `cog` | Fixed infix marking the cognitive layer | always literal `cog` |
| `<module>` | The owning cognitive module | `episodic`, `procedural`, `goals`, `working`, `meta`, `cycles` |
| `<scope>` | Optional, parameterised. Session ID, cycle ID, etc. | depends on module |

The infix `cog` is intentionally short and read-friendly in SPARQL prefixes.

### 1.1 Turtle prefixes

Add to the existing prefix block:

```turtle
@prefix cog: <urn:ontofelia:cog:>           .   # alias for "this agent's cognitive layer"
@prefix cogt: <urn:shared:ontology#cog/>    .   # vocabulary (classes & predicates)
```

`cog:` is per-agent (parallels existing `onto:`); `cogt:` is the shared
**vocabulary** used by all cognitive graphs.

---

## 2. New graph catalog

Nine new graphs per agent. Three are fixed; six are parameterised by session
or cycle ID.

### 2.1 Fixed graphs (one per agent)

| URI | Role | Writable by | Retention |
|---|---|---|---|
| `urn:<agent>:cog:episodic` | Episodic LTM. All `cog:Episode` records. | `perception`, `execution`, `learning` phases (pipeline) | Tiered: full for 30 d, summarised for 1 y, deleted on user request |
| `urn:<agent>:cog:procedural` | Procedural LTM. `cog:SkillTrace` + `cog:Skill` summaries. | `action-selection`, `learning` phases (pipeline) | Indefinite; traces older than 90 d may be compressed to skill summaries |
| `urn:<agent>:cog:meta` | Reflective markers (one per cycle) + cross-cycle metacognitive notes | `learning` phase + scheduled metacog jobs | Indefinite, but rotated: detailed for 30 d, summary thereafter |

### 2.2 Parameterised graphs (per session and per cycle)

| URI pattern | Role | Lifetime |
|---|---|---|
| `urn:<agent>:cog:working:<sessionId>:<cycleId>` | Working memory for one cycle. All buffers. | Cleared at cycle close; high-salience entries copied to next cycle's WM |
| `urn:<agent>:cog:goals:<sessionId>` | Goal stack for one session. Goals can outlive the session if they have a deadline beyond it; in that case they migrate to `urn:<agent>:cog:goals:longterm`. | Session lifetime + migration |
| `urn:<agent>:cog:goals:longterm` | Goals with deadline > session boundary. Fixed graph but added here because it parallels the session one. | Indefinite until resolved/abandoned |
| `urn:<agent>:cog:cycles:<sessionId>` | Cycle metadata — one `cog:Cycle` resource per turn, with phase records. | Session lifetime + 30 d for replay/debug |

The cycle ID format is `cycle_<utc-iso>_<seq>`, e.g.
`cycle_2026-05-31T18-04-32Z_001`.

### 2.3 Shared additions

One new shared graph for the **vocabulary** (classes and predicates used
across all agents' cognitive layers):

| URI | Role | Writable by |
|---|---|---|
| `urn:shared:ontology#cog/*` *(not a graph; vocabulary inside `urn:shared:ontology`)* | All `cogt:` classes and predicates (e.g. `cogt:Episode`, `cogt:Goal`, `cogt:hasCapability`) | admin only |

We do **not** introduce a separate `urn:shared:cog:vocabulary` graph because
the TBox should remain a single source of schema truth (`urn:shared:ontology`).

---

## 3. Vocabulary (`cogt:` classes and predicates)

The full TBox of the cognitive layer. Lives inside `urn:shared:ontology`.

### 3.1 Classes

```turtle
PREFIX cogt: <urn:shared:ontology#cog/>
PREFIX core: <urn:shared:ontology#>
PREFIX owl:  <http://www.w3.org/2002/07/owl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>

cogt:CognitiveEntity a owl:Class ;
    rdfs:label "Cognitive Entity" ;
    rdfs:comment "Abstract superclass of everything introduced by the cognitive architecture." .

cogt:Episode a owl:Class ;
    rdfs:subClassOf cogt:CognitiveEntity ;
    rdfs:label "Episode" ;
    rdfs:comment "One discrete event the agent experienced." .

cogt:Cycle a owl:Class ;
    rdfs:subClassOf cogt:CognitiveEntity ;
    rdfs:label "Cognitive Cycle" ;
    rdfs:comment "One pass through the six phases triggered by an incoming message." .

cogt:Phase a owl:Class ;
    rdfs:subClassOf cogt:CognitiveEntity ;
    rdfs:label "Cycle Phase" ;
    rdfs:comment "One of perception/comprehension/goal-management/action-selection/execution/learning." .

cogt:WorkingMemoryEntry a owl:Class ;
    rdfs:subClassOf cogt:CognitiveEntity ;
    rdfs:label "Working Memory Entry" .

cogt:Buffer a owl:Class ;
    rdfs:subClassOf cogt:CognitiveEntity ;
    rdfs:label "Buffer" ;
    rdfs:comment "A named slot in working memory owned by one module." .

cogt:Goal a owl:Class ;
    rdfs:subClassOf cogt:CognitiveEntity ;
    rdfs:label "Goal" .

cogt:GoalType a owl:Class ;
    rdfs:subClassOf cogt:CognitiveEntity ;
    rdfs:label "Goal Type" ;
    rdfs:comment "A categorisation used by procedural memory to retrieve relevant skills." .

cogt:SkillTrace a owl:Class ;
    rdfs:subClassOf cogt:CognitiveEntity ;
    rdfs:label "Skill Trace" ;
    rdfs:comment "One execution record of a tool or tool-sequence." .

cogt:Skill a owl:Class ;
    rdfs:subClassOf cogt:CognitiveEntity ;
    rdfs:label "Skill" ;
    rdfs:comment "Aggregated summary of repeated successful skill traces of one kind." .

cogt:Capability a owl:Class ;
    rdfs:subClassOf cogt:CognitiveEntity ;
    rdfs:label "Capability" ;
    rdfs:comment "Something the agent is allowed and able to do (declarative side of self-model)." .

cogt:Constraint a owl:Class ;
    rdfs:subClassOf cogt:CognitiveEntity ;
    rdfs:label "Constraint" ;
    rdfs:comment "A limit on agent behaviour (declarative side of self-model)." .

cogt:ReflectiveMarker a owl:Class ;
    rdfs:subClassOf cogt:CognitiveEntity ;
    rdfs:label "Reflective Marker" ;
    rdfs:comment "Metacognition output — what was decided/deferred/missing in a cycle." .

cogt:Impasse a owl:Class ;
    rdfs:subClassOf cogt:CognitiveEntity ;
    rdfs:label "Impasse" ;
    rdfs:comment "A phase that could not complete normally; triggers metacognitive intervention." .
```

### 3.2 Predicates (selection)

```turtle
# Cycle structure
cogt:hasPhase    a owl:ObjectProperty ;
    rdfs:domain cogt:Cycle ; rdfs:range cogt:Phase .
cogt:phaseIndex  a owl:DatatypeProperty ;
    rdfs:domain cogt:Phase ; rdfs:range xsd:int .
cogt:startedAt   a owl:DatatypeProperty ;
    rdfs:domain cogt:Phase ; rdfs:range xsd:dateTime .
cogt:endedAt     a owl:DatatypeProperty ;
    rdfs:domain cogt:Phase ; rdfs:range xsd:dateTime .
cogt:phaseInput  a owl:ObjectProperty ;
    rdfs:domain cogt:Phase ; rdfs:range cogt:CognitiveEntity .
cogt:phaseOutput a owl:ObjectProperty ;
    rdfs:domain cogt:Phase ; rdfs:range cogt:CognitiveEntity .

# Episodes
cogt:occurredAt  a owl:DatatypeProperty ;
    rdfs:domain cogt:Episode ; rdfs:range xsd:dateTime .
cogt:precededBy  a owl:ObjectProperty ;
    rdfs:domain cogt:Episode ; rdfs:range cogt:Episode .
cogt:episodeType a owl:DatatypeProperty ;
    rdfs:domain cogt:Episode ; rdfs:range xsd:string .
cogt:actor       a owl:ObjectProperty ;
    rdfs:domain cogt:Episode ; rdfs:range core:Person .

# Working memory
cogt:writtenTo   a owl:ObjectProperty ;
    rdfs:domain cogt:WorkingMemoryEntry ; rdfs:range cogt:Buffer .
cogt:salience    a owl:DatatypeProperty ;
    rdfs:domain cogt:WorkingMemoryEntry ; rdfs:range xsd:decimal .
cogt:writtenAt   a owl:DatatypeProperty ;
    rdfs:domain cogt:WorkingMemoryEntry ; rdfs:range xsd:dateTime .
cogt:writtenBy   a owl:ObjectProperty ;
    rdfs:domain cogt:WorkingMemoryEntry ; rdfs:range cogt:Phase .
cogt:payload     a owl:DatatypeProperty ;
    rdfs:domain cogt:WorkingMemoryEntry ; rdfs:range xsd:string .

# Goals
cogt:goalType         a owl:ObjectProperty ;
    rdfs:domain cogt:Goal ; rdfs:range cogt:GoalType .
cogt:status           a owl:DatatypeProperty ;
    rdfs:domain cogt:Goal ; rdfs:range xsd:string .
cogt:parentGoal       a owl:ObjectProperty ;
    rdfs:domain cogt:Goal ; rdfs:range cogt:Goal .
cogt:priority         a owl:DatatypeProperty ;
    rdfs:domain cogt:Goal ; rdfs:range xsd:decimal .
cogt:successCriterion a owl:DatatypeProperty ;
    rdfs:domain cogt:Goal ; rdfs:range xsd:string .
cogt:deadline         a owl:DatatypeProperty ;
    rdfs:domain cogt:Goal ; rdfs:range xsd:dateTime .
cogt:triggeredByEpisode a owl:ObjectProperty ;
    rdfs:domain cogt:Goal ; rdfs:range cogt:Episode .

# Procedural
cogt:forGoalType  a owl:ObjectProperty ;
    rdfs:domain cogt:SkillTrace ; rdfs:range cogt:GoalType .
cogt:toolSequence a owl:DatatypeProperty ;
    rdfs:domain cogt:SkillTrace ; rdfs:range rdf:List .
cogt:outcome      a owl:DatatypeProperty ;
    rdfs:domain cogt:SkillTrace ; rdfs:range xsd:string .
cogt:durationMs   a owl:DatatypeProperty ;
    rdfs:domain cogt:SkillTrace ; rdfs:range xsd:int .
cogt:userSatisfied a owl:DatatypeProperty ;
    rdfs:domain cogt:SkillTrace ; rdfs:range xsd:boolean .
cogt:successCount a owl:DatatypeProperty ;
    rdfs:domain cogt:Skill ; rdfs:range xsd:int .
cogt:failureCount a owl:DatatypeProperty ;
    rdfs:domain cogt:Skill ; rdfs:range xsd:int .
cogt:hasTrace     a owl:ObjectProperty ;
    rdfs:domain cogt:Skill ; rdfs:range cogt:SkillTrace .

# Self-model extensions
cogt:hasCapability a owl:ObjectProperty ;
    rdfs:domain core:Agent ; rdfs:range cogt:Capability .
cogt:hasConstraint a owl:ObjectProperty ;
    rdfs:domain core:Agent ; rdfs:range cogt:Constraint .

# Metacognition
cogt:reflectsOn   a owl:ObjectProperty ;
    rdfs:domain cogt:ReflectiveMarker ; rdfs:range cogt:Cycle .
cogt:noted        a owl:DatatypeProperty ;
    rdfs:domain cogt:ReflectiveMarker ; rdfs:range xsd:string .
cogt:flaggedImpasse a owl:ObjectProperty ;
    rdfs:domain cogt:ReflectiveMarker ; rdfs:range cogt:Impasse .
```

These predicates are registered in `urn:shared:ontology` by the admin bootstrap
(extends `bootstrap/` scripts — see [09](09-integration-and-migration.md)).

---

## 4. `GraphRegistry` extension

`GraphRegistry` (see file
[`packages/semantic-memory/src/utils/GraphRegistry.ts`](../../packages/semantic-memory/src/utils/GraphRegistry.ts))
gains three things:

### 4.1 New `GraphRole` values

```typescript
export type GraphRole =
  | 'shared'
  | 'self' | 'skills' | 'setup'
  | 'claims' | 'evidence'
  | 'worldview' | 'schema' | 'conflicts' | 'inferred'
  | 'user' | 'session'
  // NEW:
  | 'cog-episodic'      // urn:<agent>:cog:episodic
  | 'cog-procedural'    // urn:<agent>:cog:procedural
  | 'cog-meta'          // urn:<agent>:cog:meta
  | 'cog-working'       // urn:<agent>:cog:working:<sessionId>:<cycleId>
  | 'cog-goals-session' // urn:<agent>:cog:goals:<sessionId>
  | 'cog-goals-long'    // urn:<agent>:cog:goals:longterm
  | 'cog-cycles';       // urn:<agent>:cog:cycles:<sessionId>
```

### 4.2 New entries in `registerAgent`

Per-agent fixed graphs added to the `fixed` array:

```typescript
[GraphUriResolver.getCogEpisodicGraph(agentId),    'cog-episodic'],
[GraphUriResolver.getCogProceduralGraph(agentId),  'cog-procedural'],
[GraphUriResolver.getCogMetaGraph(agentId),        'cog-meta'],
[GraphUriResolver.getCogGoalsLongtermGraph(agentId),'cog-goals-long'],
```

### 4.3 New pattern validator for parameterised graphs

Today `describe` accepts only `user` and `session` parameterised graphs (one
regex). We add a second regex covering all three cognitive parameterised
families:

```typescript
// Pattern: urn:<agent>:cog:(working|goals|cycles):<scope>[ :<sub> ]
const COG_PARAM =
  /^urn:([a-z][a-z0-9_-]*):cog:(working|goals|cycles):([^:]+)(?::([^:]+))?$/;

const m = COG_PARAM.exec(graphUri);
if (m) {
  const [, agentId, family, scope1, scope2] = m;
  if (!this.agents.has(agentId)) return null;
  // working/cycles need session + cycle, goals just session
  if (family === 'working' && !scope2) return null;
  return {
    uri: graphUri,
    role:
      family === 'working' ? 'cog-working' :
      family === 'goals'   ? 'cog-goals-session' :
                             'cog-cycles',
    agentId,
    parameterised: true,
  };
}
```

`urn:<agent>:cog:goals:longterm` is intentionally **not** parameterised
(it's a fixed graph), even though its URI lexically looks like the goals-by-
session pattern. The `register` step adds it to `exact`, so it matches before
the regex runs.

### 4.4 New helper methods in `GraphUriResolver`

```typescript
// add to packages/semantic-memory/src/utils/GraphUriResolver.ts

static getCogEpisodicGraph(agentId: string): string {
  return `urn:${agentId}:cog:episodic`;
}
static getCogProceduralGraph(agentId: string): string {
  return `urn:${agentId}:cog:procedural`;
}
static getCogMetaGraph(agentId: string): string {
  return `urn:${agentId}:cog:meta`;
}
static getCogWorkingGraph(agentId: string, sessionId: string, cycleId: string): string {
  return `urn:${agentId}:cog:working:${sessionId}:${cycleId}`;
}
static getCogGoalsSessionGraph(agentId: string, sessionId: string): string {
  return `urn:${agentId}:cog:goals:${sessionId}`;
}
static getCogGoalsLongtermGraph(agentId: string): string {
  return `urn:${agentId}:cog:goals:longterm`;
}
static getCogCyclesGraph(agentId: string, sessionId: string): string {
  return `urn:${agentId}:cog:cycles:${sessionId}`;
}
```

`SHARED_GRAPHS` stays unchanged — none of the cognitive graphs are shared,
they are always per-agent.

---

## 5. `urn:shared:meta` entries

The graph metadata catalog (`urn:shared:meta`, see [§2 KG concept](../knowledge-graph-concept.md))
records every new graph:

```turtle
GRAPH <urn:shared:meta> {
  <urn:ontofelia:cog:episodic> a core:NamedGraph ;
      core:graphType    "cog-episodic" ;
      core:writableBy   "pipeline" ;
      core:visibility   "agent-only" ;
      core:retentionDays 365 ;
      core:retentionPolicy "tiered-summarise" .

  <urn:ontofelia:cog:procedural> a core:NamedGraph ;
      core:graphType    "cog-procedural" ;
      core:writableBy   "pipeline" ;
      core:visibility   "agent-only" ;
      core:retentionPolicy "indefinite-compressed" .

  <urn:ontofelia:cog:meta> a core:NamedGraph ;
      core:graphType    "cog-meta" ;
      core:writableBy   "pipeline" ;
      core:visibility   "agent-only" ;
      core:retentionPolicy "rotated" .

  <urn:ontofelia:cog:goals:longterm> a core:NamedGraph ;
      core:graphType    "cog-goals" ;
      core:writableBy   "pipeline" ;
      core:visibility   "agent-only" ;
      core:retentionPolicy "until-resolved" .
}
```

Parameterised graphs (working, goals:session, cycles) are described once at
the pattern level:

```turtle
GRAPH <urn:shared:meta> {
  <urn:ontofelia:cog:working:*> a core:NamedGraphPattern ;
      core:graphType    "cog-working" ;
      core:writableBy   "pipeline" ;
      core:visibility   "agent-only" ;
      core:retentionPolicy "per-cycle" .

  <urn:ontofelia:cog:goals:*> a core:NamedGraphPattern ;
      core:graphType    "cog-goals" ;
      core:writableBy   "pipeline" ;
      core:visibility   "agent-only" ;
      core:retentionPolicy "session-lifetime-plus-migration" .

  <urn:ontofelia:cog:cycles:*> a core:NamedGraphPattern ;
      core:graphType    "cog-cycles" ;
      core:writableBy   "pipeline" ;
      core:visibility   "agent-only" ;
      core:retentionDays 30 .
}
```

(`core:NamedGraphPattern` is introduced for this purpose. Alternative: keep
the existing `core:NamedGraph` class and add a `core:isPattern true` flag.
Open question for review.)

---

## 6. Retention summary

| Graph | Hot retention | Cold retention | Hard-delete |
|---|---|---|---|
| `cog:episodic` | 30 days full | 90 days summarised, 365 days episode-IDs only | On user request, or after 365 d |
| `cog:procedural` | Traces 90 d | Skill summaries forever | Skill summaries only on agent-reset |
| `cog:meta` | 30 d full | Forever as rotated summary | On agent-reset |
| `cog:working:*` | One cycle | — | Cleared at cycle end (high-salience entries copied forward) |
| `cog:goals:<session>` | Session lifetime | — | Migrates to `goals:longterm` if `deadline > sessionEnd`; otherwise deleted |
| `cog:goals:longterm` | Until resolved/abandoned | Forever (with status `resolved`/`abandoned`) | On user request |
| `cog:cycles:<session>` | Session lifetime + 30 d | — | Cleared 30 d after session end |

Retention is enforced by a scheduled job (see
[`packages/scheduler/src/`](../../packages/scheduler/src/)) reading
`core:retentionPolicy` from `urn:shared:meta`.

---

## 7. Worked example — agent provisioning

When a new agent `john` is registered, the existing
`GraphRegistry.registerAgent('john')` is called. With the extension above, it
now whitelists:

```
urn:john:self                     (existing)
urn:john:skills                   (existing)
urn:john:setup                    (existing)
urn:john:claims                   (existing)
urn:john:evidence                 (existing)
urn:john:worldview                (existing)
urn:john:schema                   (existing)
urn:john:conflicts                (existing)
urn:john:inferred                 (existing)
urn:john:cog:episodic             (NEW)
urn:john:cog:procedural           (NEW)
urn:john:cog:meta                 (NEW)
urn:john:cog:goals:longterm       (NEW)

# patterns valid for john (NEW):
urn:john:cog:working:<sessionId>:<cycleId>
urn:john:cog:goals:<sessionId>
urn:john:cog:cycles:<sessionId>
```

---

## 8. Open questions for review

- [ ] Should `cog:working:<sessionId>:<cycleId>` be one graph per cycle, or
      one graph per session with cycle IDs as resources inside? The
      one-per-cycle choice makes retention trivial (drop the graph at cycle
      end) but produces many tiny graphs. *Recommendation:* one per cycle for
      simplicity; revisit if Oxigraph performance degrades.
- [ ] Should impasse handling produce a **separate graph**
      `urn:<agent>:cog:impasses` or live inside `cog:meta`? *Recommendation:*
      inside `cog:meta` for now; promote later if volume warrants.
- [ ] Are RDF lists (`rdf:List` for `cog:toolSequence`) the right encoding?
      Reasonable about lists is awkward. *Recommendation:* use a sequence
      of `cogt:step` resources with `cogt:stepIndex`, not `rdf:List`.

Continue with [`03-cognitive-cycle.md`](03-cognitive-cycle.md).
