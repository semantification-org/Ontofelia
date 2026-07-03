#!/usr/bin/env bash
# Recipe 02 — Contradiction detected (truth maintenance)
# Teach a fact, contradict it, and watch the old belief get superseded
# instead of accumulating next to the new one. See README.md here.
set -euo pipefail
cd "$(dirname "$0")"
source ../common.sh

require_gateway
require_real_provider
echo

echo "== 1. Teach a fact =="
chat "Ben Okafor is a person. He lives in Berlin."

echo "== 2. The belief right now (worldview graph) =="
show_graph worldview Ben

echo "== 3. Contradict it =="
chat "Correction: Ben Okafor has moved. He lives in Lisbon now."

echo "== 4. The belief after the correction — Berlin is gone, not duplicated =="
show_graph worldview Ben

echo "== 5. The audit trail — the old claim is kept, marked 'superseded' =="
show_graph claims Ben

echo "== 6. The supersession record in the conflicts graph =="
show_graph conflicts supersession

echo "== 7. Ask the agent (reply is LLM-dependent) =="
chat "Where does Ben Okafor live?"

echo "Done. The graph revised its belief; the history stayed auditable."
