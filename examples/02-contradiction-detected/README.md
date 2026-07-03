# 02 — Contradiction detected

**What this shows:** truth maintenance. When you contradict a single-valued
fact ("lives in Berlin" → "lives in Lisbon"), Ontofelia does not stack both
statements in memory and hope retrieval picks the right one. The old belief is
**superseded**: removed from the current worldview, kept in the audit trail,
and the revision itself is recorded.

In our pilot evaluation this regime — contradiction handling and trustworthy
forgetting — is where the knowledge-graph memory measurably beat a fair
vector-RAG baseline (see the README's evaluation section for scope and
caveats; on plain recall the two are tied, and we claim no general
superiority).

**Time:** ~2 minutes. **Prerequisites:** running gateway + a real LLM provider
— see [`examples/README.md`](../README.md).

## Run it

```bash
./run.sh
```

## Walkthrough

Uses the same `POST /api/chat` and `GET /api/knowledge/graphs` calls as
[recipe 01](../01-why-do-you-believe-that/README.md); the helper functions
come from `../common.sh`.

**1. Teach a fact, then contradict it:**

```
>> Ben Okafor is a person. He lives in Berlin.
>> Correction: Ben Okafor has moved. He lives in Lisbon now.
```

**2. The current worldview after the correction** (`show_graph worldview Ben`)
— Berlin is *gone*, not duplicated:

```
--- graph urn:ontofelia:worldview (16 triples) ---
<urn:ontofelia:entity:Ben_Okafor> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <urn:ontofelia:core#Person> .
<urn:ontofelia:entity:Ben_Okafor> <urn:ontofelia:core#livesIn> <urn:ontofelia:entity:Lisbon> .
```

**3. The audit trail** (`show_graph claims Ben`) — the Berlin claim still
exists, marked superseded (real output, condensed; IDs will differ):

```
<urn:claim:...rmbvcq> claimPredicate <urn:ontofelia:core#livesIn> ;
                      claimObject    <urn:ontofelia:entity:Berlin> ;
                      status         "superseded" ;
                      supersededAt   "2026-07-03T11:52:02.329Z" ;
                      sourceSpan     "He lives in Berlin." .
<urn:claim:...eqq1zf> claimPredicate <urn:ontofelia:core#livesIn> ;
                      claimObject    <urn:ontofelia:entity:Lisbon> ;
                      status         "accepted" ;
                      sourceSpan     "He lives in Lisbon now." .
```

**4. The revision record** (`show_graph conflicts supersession`):

```
<urn:ontofelia:conflict:...> a <urn:shared:ontology#Conflict> ;
  conflictType    "supersession" ;
  supersededClaim <urn:claim:...rmbvcq> ;
  status          "resolved" .
```

**5. Ask the agent** (output will vary — LLM-dependent):

> \>\> Where does Ben Okafor live?
>
> Ben Okafor currently lives in Lisbon.

## What just happened

The ontology declares `onto:livesIn` an `owl:FunctionalProperty` — a person
lives in one place. When ingestion stored the Lisbon fact, the KnowledgeEngine
found the conflicting accepted claim, retired it (status → `superseded`),
deleted the stale triple from the worldview, and wrote a `Conflict` record of
type `supersession`. This is deterministic graph governance, not an LLM
deciding to be tidy.

Honest footnote: the *chat reply* in step 1's correction may ramble (one of
our runs had the LLM asking for confirmation to "remove the old entry" — a
tool-permission side quest). The supersession in the graph happened anyway,
because it is done by the ingestion pipeline, not by the model's tool calls.

Next: [03 — Career history](../03-career-history/) — why `worksAt` behaves
differently and history accumulates.
