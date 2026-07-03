#!/usr/bin/env bash
# Recipe 03 — Career history (multi-valued vs single-valued facts)
# Same sentence pattern, different ontology semantics: worksAt accumulates
# (career history), livesIn supersedes (you live in one place). See README.md.
set -euo pipefail
cd "$(dirname "$0")"
source ../common.sh

require_gateway
require_real_provider
echo

echo "== 1. First employer =="
chat "Carla Reyes is a person. She works at Volta Motors."

echo "== 2. Second employer — same phrasing =="
chat "Carla Reyes works at Helios Robotics."

echo "== 3. First city =="
chat "Carla Reyes lives in Madrid."

echo "== 4. Second city — same phrasing =="
chat "Carla Reyes lives in Toronto."

echo "== 5. The graph: two employers kept, one city kept =="
show_graph worldview Carla

echo "== 6. Why: the ontology declares livesIn functional, worksAt not =="
echo "(from packages/semantic-memory/src/ontologies/ontofelia-core.ttl)"
echo "  onto:worksAt rdf:type owl:ObjectProperty ."
echo "  onto:livesIn rdf:type owl:ObjectProperty, owl:FunctionalProperty ."
echo

echo "== 7. Ask the agent (reply is LLM-dependent) =="
chat "Where has Carla Reyes worked, and where does she live?"

echo "Done. The schema — not the LLM's mood — decides what accumulates."
