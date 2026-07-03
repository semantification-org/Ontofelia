# 01 — "Why do you believe that?"

**What this shows:** every fact Ontofelia learns is stored as a real RDF triple
*plus* a **Claim** (status, confidence, timestamps) *plus* **Evidence** — the
exact utterance the fact came from. Ask the agent why it believes something and
it can answer from that chain instead of guessing.

**Time:** ~2 minutes. **Prerequisites:** running gateway + a real LLM provider
— see [`examples/README.md`](../README.md).

## Run it

```bash
./run.sh
```

Or step by step:

## Walkthrough

Set up the connection (skip if `ONTOFELIA_URL`/`ONTOFELIA_TOKEN` are already set):

```bash
export ONTOFELIA_URL=http://127.0.0.1:18780
export ONTOFELIA_TOKEN="$(sed -n "s/.*token: '\([^']*\)'.*/\1/p" ~/.ontofelia/ontofelia.json5)"
```

**1. Teach the agent a fact:**

```bash
curl -s "$ONTOFELIA_URL/api/chat" \
  -H "Authorization: Bearer $ONTOFELIA_TOKEN" -H "Content-Type: application/json" \
  -d '{"message": "Please remember: Ada Marlowe is a person, and she works at Helios Robotics."}'
```

**2. Ask it to justify the belief:**

```bash
curl -s "$ONTOFELIA_URL/api/chat" \
  -H "Authorization: Bearer $ONTOFELIA_TOKEN" -H "Content-Type: application/json" \
  -d '{"message": "Why do you believe that Ada Marlowe works at Helios Robotics?"}'
```

Reply from a real run (output will vary — LLM-dependent):

> I believe that Ada Marlowe works at Helios Robotics based on the information
> you provided. The fact was accepted with high confidence (0.95) from your
> statement: "Ada Marlowe is a person, and she works at Helios Robotics."

That answer is not confabulated — the agent called its `memory_explain` tool
and read the claim from the graph.

**3. Look at the graph yourself.** The gateway exposes all Named Graphs at
`GET /api/knowledge/graphs`; the shared helper filters them:

```bash
source ../common.sh
show_graph worldview Ada    # the fact itself
show_graph claims Ada       # the claim: status, confidence, timestamps
show_graph evidence Ada     # the evidence: the exact source utterance
```

From the same run (claim and evidence IDs will differ):

```
--- graph urn:ontofelia:worldview (8 triples) ---
<urn:ontofelia:entity:Ada_Marlowe> <urn:ontofelia:core#worksAt> <urn:ontofelia:entity:Helios_Robotics> .
...

--- graph urn:ontofelia:claims (29 triples) ---
<urn:claim:...> a <urn:shared:ontology#Claim> ;
  claimSubject   <urn:ontofelia:entity:Ada_Marlowe> ;
  claimPredicate <urn:ontofelia:core#worksAt> ;
  claimObject    <urn:ontofelia:entity:Helios_Robotics> ;
  confidence     "0.95" ; confidenceLabel "high" ; status "accepted" ;
  learnedAt      "2026-07-03T11:50:24.661Z" ;
  hasEvidence    <urn:evidence:...> ;
  sourceSpan     "Ada Marlowe is a person, and she works at Helios Robotics." .

--- graph urn:ontofelia:evidence (5 triples) ---
<urn:evidence:...> a <urn:shared:ontology#Evidence> ;
  evidenceType "message-span" ;
  rawText "Ada Marlowe is a person, and she works at Helios Robotics." ;
  capturedAt "2026-07-03T11:50:24.658Z" .
```

(The API returns one triple per line; the block above is condensed for
readability. `run.sh` shows the raw form.)

## What just happened

When your message arrived, Ontofelia's semantic ingestion parsed it with the
LLM, resolved "Ada Marlowe" to an entity URI, matched "works at" to the
ontology property `onto:worksAt`, and wrote three linked things: the **triple**
(worldview graph), a **Claim** about that triple (claims graph), and the
**Evidence** — your literal sentence (evidence graph). A vector store can tell
you *what text is similar*; this tells you *why a specific belief is held,
since when, and on whose word*.

Next: [02 — Contradiction detected](../02-contradiction-detected/) — what
happens when you tell the agent something that clashes with what it believes.
