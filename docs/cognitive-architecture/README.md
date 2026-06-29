# Ontofelia Cognitive Architecture — Concept

> **Status:** Draft for review · **Author:** Architecture Working Group · **Last update:** 2026-05-31
>
> This is the specification of Ontofelia's cognitive architecture. It extends the
> existing Named-Graph topology (see [`../knowledge-graph-concept.md`](../knowledge-graph-concept.md))
> with explicit cognitive modules — working memory, episodic memory, procedural
> memory, goal stack, attention, and metacognition — and defines the cognitive
> cycle that runs on every turn.

---

## Why this document exists

Ontofelia today has a strong **memory backbone** (RDF triples, OWL TBox, OWL-DL
reasoning, claim/evidence provenance, named-graph topology). What it does *not*
have is a **cognitive architecture**: a principled separation between the kinds
of memory and processes that turn perception into action.

Symptoms in the current code:

- **One flat semantic layer.** `urn:<agent>:worldview` mixes general world
  knowledge with topic-of-the-moment facts; `urn:<agent>:user:<id>` mixes
  long-term user profile with last-week's chat detail. There is no episodic
  layer that preserves *what happened when*.
- **No working memory.** The closest analogue, `urn:<agent>:session:<id>`, is
  used loosely and not addressed by a dedicated subsystem. Prompt assembly hard-
  codes a few "always-on" graphs (see
  [`packages/agent-runtime/src/index.ts:1`](../../packages/agent-runtime/src/index.ts)).
- **No procedural memory.** Tools are static definitions
  ([`packages/tools/src/registry/ToolRegistry.ts:1`](../../packages/tools/src/registry/ToolRegistry.ts));
  there is no record of *which tool sequences worked for which kind of goal*.
- **No explicit goal stack.** Intentions live only in the LLM's prompt-window.
  If a multi-step task is interrupted, the agent forgets the goal that was
  driving it.
- **Metacognition is shallow.** `memory_reflect` and
  [`packages/semantic-memory/src/reflection/ReflectionRunner.ts:1`](../../packages/semantic-memory/src/reflection/ReflectionRunner.ts)
  exist but operate on the same flat knowledge graph; the agent cannot reason
  about *its own beliefs as beliefs*.

This concept fixes these gaps by mapping the **Common Model of Cognition**
(Laird, Lebiere, Rosenbloom 2017 — the synthesis of SOAR / ACT-R / Sigma)
onto Ontofelia's RDF substrate. We get the discipline of a cognitive
architecture without throwing away the semantic-memory work already done.

---

## Reading order

| # | Document | Purpose |
|---|----------|---------|
| 0 | [`00-overview.md`](00-overview.md) | Design principles, vision, glossary, mapping to existing code |
| 1 | [`01-reference-model.md`](01-reference-model.md) | The Common Model of Cognition adapted to Ontofelia — modules, buffers, cycle |
| 2 | [`02-named-graph-topology.md`](02-named-graph-topology.md) | Extended URI scheme + additions to `GraphRegistry` |
| 3 | [`03-cognitive-cycle.md`](03-cognitive-cycle.md) | The per-turn lifecycle: perception → comprehension → goal management → action selection → learning |
| 4 | [`04-working-memory.md`](04-working-memory.md) | Buffers, salience, decay; how prompt assembly draws from working memory |
| 5 | [`05-episodic-memory.md`](05-episodic-memory.md) | Time-indexed events, semantic decay, episodic-to-semantic consolidation |
| 6 | [`06-procedural-memory.md`](06-procedural-memory.md) | Skills, productions, tool-use traces, procedural learning |
| 7 | [`07-goals-and-attention.md`](07-goals-and-attention.md) | Goal stack, intention persistence, attention/salience mechanism |
| 8 | [`08-metacognition-and-self-model.md`](08-metacognition-and-self-model.md) | Self-model, belief about beliefs, monitoring, escalation |
| 9 | [`09-integration-and-migration.md`](09-integration-and-migration.md) | Concrete code changes; migration plan from today's state |
| 10 | [`10-worked-example.md`](10-worked-example.md) | A full turn traced end-to-end with RDF, SPARQL, and prompt fragments |

---

## TL;DR (1 page)

We add five cognitive modules on top of the existing semantic-memory layer:

```
                        ┌──────────────────────┐
                        │   Metacognition      │  monitors + revises
                        └──────────┬───────────┘
                                   │
   ┌──────────────┐   ┌────────────▼──────────┐   ┌──────────────┐
   │  Goals       │──▶│   Working Memory      │◀──│  Self-Model  │
   │  (intentions)│   │   (current-turn buffer)│   │  (persona)   │
   └──────┬───────┘   └────────────┬──────────┘   └──────────────┘
          │                        │
          │              ┌─────────┴─────────┐
          │              ▼                   ▼
          │     ┌────────────────┐  ┌────────────────┐
          │     │ Semantic LTM   │  │ Episodic LTM   │
          │     │ (worldview,    │  │ (events with   │
          │     │  user, shared) │  │  time/source)  │
          │     └────────────────┘  └────────┬───────┘
          │                                  │
          │                       consolidation
          │                                  │
          └────────────────▶ ┌────────────────▼─────────────────┐
                             │      Procedural Memory           │
                             │  (skills + tool-use productions) │
                             └──────────────────────────────────┘
```

Each module is a **family of named graphs** under
`urn:<agent>:cog:<module>:…`, governed by the existing `GraphRegistry`
whitelist. The cognitive cycle (one turn) walks these graphs in a fixed order;
prompt assembly is no longer a hand-coded list of graphs but a deterministic
function of the cycle's intermediate results.

The rest of the documents elaborate. Start with
[`00-overview.md`](00-overview.md).

---

## Status of decisions

The following are **proposed** in this draft and require sign-off before
implementation:

- [ ] Five-module decomposition (working / episodic / procedural / goals /
      metacognition) is the right granularity (vs. finer ACT-R-style or
      coarser two-module).
- [ ] Episodic memory lives in RDF (not JSONL alongside transcripts).
- [ ] Procedural memory is RDF-based (not a separate skill DB).
- [ ] Working memory is **persistent across turns within a session** but reset
      on session boundary — not stored only in-prompt.
- [ ] The cognitive cycle is **synchronous within a turn** (no separate
      tick loop). Background consolidation runs out-of-band.
- [ ] Goal stack is mandatory on every turn (even chit-chat creates an
      implicit `RespondTo` goal) — no optional path.

Reviewers, please record decisions inline in each document and in
[`09-integration-and-migration.md`](09-integration-and-migration.md).
