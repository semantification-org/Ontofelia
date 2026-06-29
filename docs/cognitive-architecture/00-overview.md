# 00 · Overview, principles, glossary

> **Scope:** what we mean by "cognitive architecture", what we are *not*
> trying to build, and the glossary every subsequent document depends on.

---

## 1. What "cognitive architecture" means here

A **cognitive architecture** is a fixed set of memory stores and processing
modules that together give a system the capacity to perceive, comprehend,
remember, decide, act, and learn. It is the *substrate* — domain knowledge
flows through it, but the substrate itself is stable.

Three established architectures inform this design:

| Architecture | Key idea we borrow |
|---|---|
| **SOAR** (Laird, Newell, Rosenbloom) | Single working memory + production rules + universal subgoaling on impasses |
| **ACT-R** (Anderson) | Declarative (chunks) vs. procedural (productions) split + module buffers as the only inter-module channel |
| **Common Model of Cognition** (Laird, Lebiere, Rosenbloom 2017) | Synthesis: working memory as a global blackboard, declarative LTM + procedural LTM + perception/motor modules |

We deliberately **do not** copy any of these literally. ACT-R's production
matching, for instance, is a poor fit for an LLM-driven action selector. What
we copy is the *separation of memory kinds* and the discipline of a *cognitive
cycle*, both of which are missing from Ontofelia today.

We also borrow one idea from **LIDA** (Franklin) — the **Global Workspace**
metaphor for attention: only what is *broadcast* to working memory shapes the
next decision. This gives us a principled answer to "what goes in the prompt".

---

## 2. Design principles

These principles bind every later decision. Reviewers should challenge them
before the details.

### P1 — Substrate is RDF; modules are graph families

Every cognitive module persists in RDF named graphs governed by the existing
[`GraphRegistry`](../../packages/semantic-memory/src/utils/GraphRegistry.ts).
We do not introduce a parallel store (no Redis for working memory, no separate
SQLite for episodes). Reasons:

- One query language (SPARQL) across all memory kinds.
- One backup/restore path.
- One reasoner (`@ontofelia/reasoner`) can in principle materialise across
  multiple modules (e.g. infer that *this* episode is an instance of *that*
  goal type).
- One whitelist enforces topology — neither the LLM nor a buggy code path
  can invent off-topology graphs.

### P2 — One cognitive cycle per turn, synchronous

Every channel message triggers exactly one **cognitive cycle**. The cycle has a
fixed phase order (perception → comprehension → goal-management → action-
selection → execution → learning) and runs synchronously inside
`AgentRuntime.handleMessage`. Background consolidation jobs (episodic →
semantic, sleep-style replay) run out-of-band and never block the cycle.

This is *not* a tick-based loop. The agent does not "think" between turns.

### P3 — Working memory is the only blackboard

Modules communicate **only** via working memory. A goal does not directly
inject into the prompt; it writes a salience-weighted entry into working
memory, and prompt assembly draws from working memory. This makes information
flow auditable: every prompt fragment is traceable to a working-memory write,
which is traceable to a module decision.

### P4 — Episodic ≠ semantic ≠ procedural

Three long-term memory kinds, three distinct graph families:

- **Semantic LTM** — *what is true* (existing `worldview`, `user`, `shared:world`).
- **Episodic LTM** — *what happened, when, who was involved* (new).
- **Procedural LTM** — *what to do in this kind of situation* (new).

This trichotomy is consistent with the cognitive-science literature (Tulving
1972, Squire 1992) and with all three reference architectures. Conflating
them — as the current `worldview`/`user` split does — leads to retrieval that
is either too noisy (semantic floods with episodic chatter) or too narrow
(episodic queries forced through semantic predicates).

### P5 — Every belief is owned by a module

A triple in `urn:<agent>:cog:episodic:…` is the *episodic* module's belief;
the same fact appearing in `worldview` is the *semantic* module's belief.
They can disagree. Belief revision is per-module, with metacognition as the
arbiter. This is the only way to give the agent a principled answer to "I used
to believe X, but I now believe Y" — the answer requires distinguishing the
*kind* of belief.

### P6 — Self-model is a graph, not a prompt template

The agent's identity, persona, capabilities, and limits live in
`urn:<agent>:self` (existing) — but extended so the agent can *query* them
with SPARQL. "Am I allowed to send emails?" becomes a graph query against the
self-model, not a string match against a config blob. This is what makes the
self-model *cognitive* rather than decorative.

### P7 — Metacognition is mandatory, not optional

Every cycle ends with a metacognitive step (even a no-op marker). The agent
records *what* it decided, *why*, and *what it didn't see*. This produces
the trace that procedural learning, consolidation, and impasse-detection
depend on. Without it, no module-level learning is possible.

### P8 — Cycle phases are first-class RDF resources

The cycle itself is reified: every phase produces a triple
`?phase a cog:Phase` with timing and inputs/outputs. This is what makes the
agent's behaviour explainable: "why did you call `web_fetch`?" → SPARQL
walk from the action-selection phase to the goal that motivated it, to the
working-memory entries that supported it, to the episode that brought them in.

---

## 3. What we are NOT building

To prevent scope creep during review:

- **Not a from-scratch reasoner.** `@ontofelia/reasoner` and Reasonable stay.
- **Not a new LLM provider.** Provider loop in
  [`packages/agent-runtime/src/index.ts:1`](../../packages/agent-runtime/src/index.ts)
  is untouched conceptually — the cycle wraps it.
- **Not a planner.** Goal stack supports planning, but no STRIPS-style planner
  is mandated. The LLM continues to do action selection; goals constrain it.
- **Not real-time perception.** Channel adapters stay as-is. Perception in our
  sense means *converting an incoming `MessageEnvelope` into working-memory
  entries*.
- **Not symbolic productions.** Procedural memory stores *traces* of tool
  sequences, not rules a forward-chainer fires.

---

## 4. Glossary

Used consistently across all documents.

| Term | Definition |
|---|---|
| **Cognitive cycle** | The fixed sequence of phases triggered by one incoming message. Always synchronous, always six phases (see [03](03-cognitive-cycle.md)). |
| **Phase** | One of `perception`, `comprehension`, `goal-management`, `action-selection`, `execution`, `learning`. Each is a first-class RDF resource (`cog:Phase`). |
| **Working memory (WM)** | The transient, current-cycle blackboard. Implemented as `urn:<agent>:cog:working:<sessionId>:<cycleId>`. Cleared at cycle end (with selective carry-over). |
| **Buffer** | A named slot in working memory dedicated to one module: `cog:goalBuffer`, `cog:perceptionBuffer`, etc. Modeled after ACT-R module buffers. |
| **Episode** | One discrete event the agent experienced — a message arriving, a tool call, a goal completion. Stored in `urn:<agent>:cog:episodic`. |
| **Skill trace** | One execution record of a tool or tool-sequence, stored in `urn:<agent>:cog:procedural`. Used to learn "what worked". |
| **Goal** | An explicit intention with type, status, parent, deadline, and success criterion. Lives in `urn:<agent>:cog:goals`. |
| **Salience** | A numeric weight `[0,1]` on each WM entry, governing whether it enters the prompt. Set by the writing module, adjusted by metacognition. |
| **Global Workspace** | The slice of WM with salience ≥ θ that prompt assembly draws from. |
| **Impasse** | A cycle phase that cannot complete (no goal matches, no action selected, tool error). Triggers metacognitive intervention. |
| **Consolidation** | Background process moving stable episodic patterns into semantic LTM, and stable tool sequences into procedural LTM. Out-of-band. |
| **Reflective marker** | RDF resource summarising one cycle — what was decided, what was deferred, what was inconsistent. Lives in `urn:<agent>:cog:meta`. |

---

## 5. Relationship to existing concepts

This document **extends** but does not **replace** the existing
`docs/knowledge-graph-concept.md`. Concrete mapping:

| Existing graph | Cognitive role |
|---|---|
| `urn:shared:ontology` | TBox — schema for *all* cognitive modules |
| `urn:shared:meta` | Graph registry; we extend its entries |
| `urn:shared:world` | Semantic LTM, consensus tier |
| `urn:<agent>:worldview` | Semantic LTM, agent tier |
| `urn:<agent>:user:<id>` | Semantic LTM, user-specific tier |
| `urn:<agent>:self` | Self-model module storage |
| `urn:<agent>:skills` | Procedural memory — *declarative* side (what skills exist) |
| `urn:<agent>:claims` | Provenance — orthogonal to cognitive modules, every module uses it |
| `urn:<agent>:evidence` | Same |
| `urn:<agent>:schema` | TBox extension — every module may register predicates |
| `urn:<agent>:conflicts` | Metacognition input — surfaced contradictions |
| `urn:<agent>:inferred` | Reasoner materialisation target — feeds semantic LTM retrieval |
| `urn:<agent>:session:<id>` | **Replaced** by `urn:<agent>:cog:working:<sessionId>:<cycleId>` topology |

New graphs introduced by this concept are listed in
[`02-named-graph-topology.md`](02-named-graph-topology.md).

---

## 6. Out-of-scope questions (for follow-up)

The following are interesting and probably necessary, but explicitly deferred
to keep this concept reviewable:

- **Affective state.** Mood/emotion as a soft modulator of salience.
- **Theory of mind.** Reasoning about *other agents'* beliefs.
- **Replay / sleep consolidation.** When and how the background consolidation
  job runs (algorithm sketched in [05](05-episodic-memory.md), schedule not
  specified).
- **Multi-agent shared workspace.** Cross-agent working memory.
- **Embodiment.** Sensorimotor grounding (not relevant before Ontofelia gets
  physical actuators).

Continue with [`01-reference-model.md`](01-reference-model.md).
