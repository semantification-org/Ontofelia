# 03 — Career history

**What this shows:** the *schema* decides how facts evolve. You tell the agent
about two employers and two cities using the same sentence pattern — and get
different, correct behavior for each: `worksAt` **accumulates** (people have
career histories), `livesIn` **supersedes** (people live in one place). No
prompt engineering involved; it follows from one `owl:FunctionalProperty`
declaration in the ontology.

**Time:** ~2 minutes. **Prerequisites:** running gateway + a real LLM provider
— see [`examples/README.md`](../README.md).

## Run it

```bash
./run.sh
```

## Walkthrough

Four messages, deliberately parallel in shape:

```
>> Carla Reyes is a person. She works at Volta Motors.
>> Carla Reyes works at Helios Robotics.
>> Carla Reyes lives in Madrid.
>> Carla Reyes lives in Toronto.
```

**The graph afterwards** (`source ../common.sh; show_graph worldview Carla`) —
real output from a run:

```
--- graph urn:ontofelia:worldview (28 triples) ---
<urn:ontofelia:entity:Carla_Reyes> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <urn:ontofelia:core#Person> .
<urn:ontofelia:entity:Carla_Reyes> <urn:ontofelia:core#livesIn> <urn:ontofelia:entity:Toronto> .
<urn:ontofelia:entity:Carla_Reyes> <urn:ontofelia:core#worksAt> <urn:ontofelia:entity:Helios_Robotics> .
<urn:ontofelia:entity:Carla_Reyes> <urn:ontofelia:core#worksAt> <urn:ontofelia:entity:Volta_Motors> .
```

Both employers. One city. The Madrid claim is retired with
`status "superseded"` in the claims graph, exactly as in
[recipe 02](../02-contradiction-detected/README.md).

**Ask the agent** (output will vary — LLM-dependent):

> \>\> Where has Carla Reyes worked, and where does she live?
>
> Carla Reyes has worked at the following organizations:
> - Helios Robotics
> - Volta Motors
>
> She currently lives in Toronto.

## Why

From `packages/semantic-memory/src/ontologies/ontofelia-core.ttl`:

```turtle
onto:worksAt rdf:type owl:ObjectProperty .                          # multi-valued
onto:livesIn rdf:type owl:ObjectProperty, owl:FunctionalProperty .  # single-valued
```

On every stored fact the KnowledgeEngine checks whether the predicate is
functional. Functional → the previous value is superseded (recipe 02).
Non-functional → the new value is added alongside the old ones. A flat memory
has to guess, per retrieval, whether "works at Helios Robotics" *replaces* or
*extends* "works at Volta Motors". Here the ontology answers that question
once, for every future fact.

Honest footnote: extraction runs through the LLM, so a message can
occasionally fail to parse or a free-tier model can time out mid-run (one of
our verification runs hit two "no models responded" chat errors — and the
facts still landed in the graph, because ingestion happens independently of
the final chat reply). If a fact is missing, rephrase and send it again.
