#!/usr/bin/env bash
# Recipe 01 — "Why do you believe that?"
# Teach the agent one fact, then show the claim/evidence chain that
# the knowledge graph keeps for it. See README.md in this directory.
set -euo pipefail
cd "$(dirname "$0")"
source ../common.sh

require_gateway
require_real_provider
echo

echo "== 1. Teach the agent a fact =="
chat "Please remember: Ada Marlowe is a person, and she works at Helios Robotics."

echo "== 2. Ask the agent to justify its belief (reply is LLM-dependent) =="
chat "Why do you believe that Ada Marlowe works at Helios Robotics?"

echo "== 3. The fact itself — a real RDF triple in the worldview graph =="
show_graph worldview Ada

echo "== 4. The claim behind the fact — status, confidence, timestamps =="
show_graph claims Ada

echo "== 5. The evidence — the exact utterance the fact was learned from =="
show_graph evidence Ada

echo "Done. Every fact in Ontofelia's memory is auditable like this."
