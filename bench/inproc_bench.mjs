#!/usr/bin/env node
/**
 * inproc_bench.mjs — measure storage and reasoner cost as the KG grows.
 *
 * Stays in-process so we time the pipeline, not HTTP or the LLM. Each level:
 *   1. mint a fresh OxigraphAdapter pointing at a temp dataDir
 *   2. load TBox + bootstrap shared graphs
 *   3. bulk-load N synthetic quads (worldview + claims + evidence)
 *   4. measure: store one new fact end-to-end via KnowledgeEngine.storeFact
 *      (which exercises reasoner materialize + supersession check + insert +
 *       claim/evidence creation + persistent flush)
 *   5. report timings
 */

import { performance } from 'node:perf_hooks';
import { mkdirSync, rmSync, writeFileSync, statSync, appendFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import {
  OxigraphAdapter, KnowledgeEngine, GraphRegistry, GraphUriResolver, SHARED_GRAPHS,
} from '../packages/semantic-memory/dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TBOX_PATH = path.resolve(
  __dirname, '..', 'packages', 'semantic-memory', 'dist', 'ontologies', 'ontofelia-core.ttl',
);
const BOOTSTRAP_DIR = path.resolve(__dirname, '..', 'bootstrap');

const WORLDVIEW = 'urn:ontofelia:worldview';
const CLAIMS = 'urn:ontofelia:claims';
const EVIDENCE = 'urn:ontofelia:evidence';

const CORE = (frag) => `urn:ontofelia:core#${frag}`;
const ONTO = (frag) => `urn:shared:ontology#${frag}`;
const ENT = (slug) => `urn:ontofelia:entity:${slug}`;

function makeQuads(count) {
  // ~17 quads per fact (4 worldview + 11 claim + 2 evidence)
  const lines = [];
  const cities = Math.max(50, Math.floor(count / 100));
  const orgs = Math.max(20, Math.floor(count / 200));
  for (let i = 0; i < cities; i++) {
    lines.push(`<${ENT(`City_${i}`)}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${CORE('Place')}> <${WORLDVIEW}> .`);
  }
  for (let i = 0; i < orgs; i++) {
    lines.push(`<${ENT(`Org_${i}`)}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${CORE('Organization')}> <${WORLDVIEW}> .`);
  }
  for (let i = 0; i < count; i++) {
    const p = ENT(`Person_${i}`);
    const c = ENT(`City_${i % cities}`);
    const o = ENT(`Org_${i % orgs}`);
    lines.push(`<${p}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${CORE('Person')}> <${WORLDVIEW}> .`);
    lines.push(`<${p}> <${CORE('livesIn')}> <${c}> <${WORLDVIEW}> .`);
    lines.push(`<${p}> <${CORE('worksAt')}> <${o}> <${WORLDVIEW}> .`);
    lines.push(`<${p}> <http://www.w3.org/2000/01/rdf-schema#label> "Person_${i}" <${WORLDVIEW}> .`);
    const cl1 = `urn:claim:bench_${i}_a`;
    const cl2 = `urn:claim:bench_${i}_b`;
    lines.push(`<${cl1}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${ONTO('Claim')}> <${CLAIMS}> .`);
    lines.push(`<${cl1}> <${ONTO('claimSubject')}> <${p}> <${CLAIMS}> .`);
    lines.push(`<${cl1}> <${ONTO('claimPredicate')}> <${CORE('livesIn')}> <${CLAIMS}> .`);
    lines.push(`<${cl1}> <${ONTO('claimObject')}> <${c}> <${CLAIMS}> .`);
    lines.push(`<${cl1}> <${ONTO('status')}> "accepted" <${CLAIMS}> .`);
    lines.push(`<${cl1}> <${ONTO('assertedInGraph')}> <${WORLDVIEW}> <${CLAIMS}> .`);
    lines.push(`<${cl2}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${ONTO('Claim')}> <${CLAIMS}> .`);
    lines.push(`<${cl2}> <${ONTO('claimSubject')}> <${p}> <${CLAIMS}> .`);
    lines.push(`<${cl2}> <${ONTO('claimPredicate')}> <${CORE('worksAt')}> <${CLAIMS}> .`);
    lines.push(`<${cl2}> <${ONTO('claimObject')}> <${o}> <${CLAIMS}> .`);
    lines.push(`<${cl2}> <${ONTO('status')}> "accepted" <${CLAIMS}> .`);
    lines.push(`<${cl2}> <${ONTO('assertedInGraph')}> <${WORLDVIEW}> <${CLAIMS}> .`);
    lines.push(`<urn:evidence:bench_${i}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${ONTO('Evidence')}> <${EVIDENCE}> .`);
    lines.push(`<urn:evidence:bench_${i}> <${ONTO('rawText')}> "synthetic ${i}" <${EVIDENCE}> .`);
  }
  return lines;
}

async function bulkLoad(triplestore, quads) {
  // Load via the adapter's loadNquads path. Oxigraph supports `store.load`
  // with the n-quads format. We dump everything as one string.
  const nq = quads.join('\n') + '\n';
  // Use a SPARQL UPDATE INSERT DATA — works for any backend. Chunk by graph
  // to keep the SPARQL statements manageable.
  const byGraph = new Map();
  for (const line of quads) {
    // crude graph extractor: last `<...>` before final ` .`
    const m = line.match(/^(.*) <([^<>]+)> \.$/);
    if (!m) continue;
    const triple = m[1];
    const g = m[2];
    if (!byGraph.has(g)) byGraph.set(g, []);
    byGraph.get(g).push(triple);
  }
  for (const [g, triples] of byGraph) {
    // chunk into 5000 triples per insert to avoid huge SPARQL strings
    const CHUNK = 5000;
    for (let i = 0; i < triples.length; i += CHUNK) {
      const slice = triples.slice(i, i + CHUNK).join(' .\n') + ' .';
      await triplestore.update(`INSERT DATA { GRAPH <${g}> { ${slice} } }`);
    }
  }
}

async function runOneLevel(facts) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ontofelia-bench-'));
  const dataDir = path.join(tmp, 'triplestore');
  mkdirSync(dataDir, { recursive: true });

  const triplestore = new OxigraphAdapter();
  await triplestore.initialize({
    backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '',
  });

  // Load core TBox
  const tboxTtl = await readFile(TBOX_PATH, 'utf-8');
  await triplestore.putGraph('urn:shared:ontology', tboxTtl, 'turtle');

  // Bootstrap self+meta (small)
  try {
    const selfTtl = await readFile(path.join(BOOTSTRAP_DIR, 'self.ttl'), 'utf-8');
    await triplestore.putGraph(GraphUriResolver.getSelfGraph('ontofelia'), selfTtl, 'turtle');
  } catch {}
  try {
    const metaTtl = await readFile(path.join(BOOTSTRAP_DIR, 'meta.ttl'), 'utf-8');
    await triplestore.putGraph(SHARED_GRAPHS.META, metaTtl, 'turtle');
  } catch {}

  const registry = GraphRegistry.create(['ontofelia']);
  const engine = new KnowledgeEngine(triplestore, undefined, registry);

  // Bulk-load synthetic quads
  const tGen = performance.now();
  const quads = makeQuads(facts);
  const genMs = performance.now() - tGen;

  const tLoad = performance.now();
  await bulkLoad(triplestore, quads);
  const loadMs = performance.now() - tLoad;

  // Measure flush size now
  const datasetFile = path.join(dataDir, 'dataset.nq');
  let datasetBytes = 0;
  try { datasetBytes = statSync(datasetFile).size; } catch {}

  // Total triple count
  const totalRes = await triplestore.query(`SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } }`);
  const total = Number(totalRes.bindings?.[0]?.c?.value ?? -1);

  // Time a graph dump (the operation the reasoner does on every store)
  const tDump = performance.now();
  const dump = await triplestore.getGraph(WORLDVIEW, 'turtle');
  const dumpMs = performance.now() - tDump;
  const dumpKB = (dump.length / 1024) | 0;

  // Time one storeFact through the full pipeline
  // (reasoner materialize + supersede check + insert + claim/evidence + flush)
  const tStore = performance.now();
  const result = await engine.storeFact(
    {
      subject: 'I',
      subjectType: 'Person',
      predicate: 'livesIn',
      object: 'Berlin',
      objectType: 'Place',
      confidenceLabel: 'high',
      sourceSpan: 'I live in Berlin.',
      status: 'accepted',
    },
    {
      agentId: 'ontofelia',
      userId: 'owner',
      sessionId: 'bench',
      isOwner: true,
      channel: 'webchat',
      sourceKind: 'user',
    },
  );
  const storeMs = performance.now() - tStore;

  // Time five consecutive stores to get a steady-state
  let storeMsTotal = 0;
  let steady = [];
  for (let k = 0; k < 5; k++) {
    const t = performance.now();
    await engine.storeFact(
      {
        subject: `BenchPerson_${k}`,
        subjectType: 'Person',
        predicate: 'livesIn',
        object: 'Munich',
        objectType: 'Place',
        confidenceLabel: 'high',
        sourceSpan: `Test fact ${k}`,
        status: 'accepted',
      },
      {
        agentId: 'ontofelia',
        userId: 'owner',
        sessionId: 'bench',
        isOwner: true,
        channel: 'webchat',
        sourceKind: 'user',
      },
    );
    const ms = performance.now() - t;
    steady.push(Math.round(ms));
    storeMsTotal += ms;
  }
  const storeAvg = storeMsTotal / 5;

  // Time a reasoning step on its own (skip the rest of the pipeline)
  // Use the reasoner via the in-engine path that storeFact uses.
  // We measure by calling storeFact again and isolating: actually easier to
  // recompute the dump+twice-reason cost ourselves via the reasoner.

  // Cleanup
  try { await triplestore.stop(); } catch {}
  rmSync(tmp, { recursive: true, force: true });

  return {
    facts,
    total,
    datasetMB: +(datasetBytes / 1024 / 1024).toFixed(1),
    genMs: Math.round(genMs),
    loadMs: Math.round(loadMs),
    dumpMs: Math.round(dumpMs),
    dumpKB,
    firstStoreMs: Math.round(storeMs),
    steadyStoresMs: steady,
    avgStoreMs: Math.round(storeAvg),
  };
}

const levelsArg = process.argv[2];
const LEVELS = levelsArg
  ? levelsArg.split(',').map(n => Number.parseInt(n, 10))
  : [0, 1000, 5000, 15000, 30000, 60000];

console.error('Levels:', LEVELS.join(', '));
const results = [];
for (const n of LEVELS) {
  console.error(`\n=== Facts: ${n} ===`);
  try {
    const r = await runOneLevel(n);
    console.error(`  total triples: ${r.total}`);
    console.error(`  dataset.nq:   ${r.datasetMB} MB`);
    console.error(`  bulk load:    ${r.loadMs} ms`);
    console.error(`  graph dump:   ${r.dumpMs} ms (${r.dumpKB} KB)`);
    console.error(`  first store:  ${r.firstStoreMs} ms`);
    console.error(`  steady avg:   ${r.avgStoreMs} ms (per call)`);
    console.error(`  steady runs:  [${r.steadyStoresMs.join(', ')}] ms`);
    results.push(r);
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    results.push({ facts: n, error: e.message });
  }
}

console.log(JSON.stringify(results, null, 2));
