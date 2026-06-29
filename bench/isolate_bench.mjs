#!/usr/bin/env node
/**
 * isolate_bench.mjs — break down the per-store cost at scale.
 *
 * For each fact size N, builds a synthetic KG of N facts, then times:
 *   - reason() alone (inferTriples on TBox + worldview turtle)
 *   - getGraph() alone (serialise worldview to turtle)
 *   - adapter.update() alone (single INSERT DATA)
 *   - implicit flush (whole-dataset persist) — observed via wall time of update
 *   - SPARQL ASK against claims (the supersession lookup)
 */

import { performance } from 'node:perf_hooks';
import { mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';

import {
  OxigraphAdapter, GraphRegistry, GraphUriResolver,
} from '../packages/semantic-memory/dist/index.js';
import { inferTriples } from '../packages/reasoner/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TBOX_PATH = path.resolve(
  __dirname, '..', 'packages', 'semantic-memory', 'dist', 'ontologies', 'ontofelia-core.ttl',
);

const WORLDVIEW = 'urn:ontofelia:worldview';
const CLAIMS = 'urn:ontofelia:claims';
const EVIDENCE = 'urn:ontofelia:evidence';

const CORE = (frag) => `urn:ontofelia:core#${frag}`;
const ONTO = (frag) => `urn:shared:ontology#${frag}`;
const ENT = (slug) => `urn:ontofelia:entity:${slug}`;

function makeWorldviewTriples(count) {
  const lines = [];
  const cities = Math.max(50, Math.floor(count / 100));
  const orgs = Math.max(20, Math.floor(count / 200));
  for (let i = 0; i < cities; i++) {
    lines.push(`<${ENT(`City_${i}`)}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${CORE('Place')}> .`);
  }
  for (let i = 0; i < orgs; i++) {
    lines.push(`<${ENT(`Org_${i}`)}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${CORE('Organization')}> .`);
  }
  for (let i = 0; i < count; i++) {
    const p = ENT(`Person_${i}`);
    const c = ENT(`City_${i % cities}`);
    const o = ENT(`Org_${i % orgs}`);
    lines.push(`<${p}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${CORE('Person')}> .`);
    lines.push(`<${p}> <${CORE('livesIn')}> <${c}> .`);
    lines.push(`<${p}> <${CORE('worksAt')}> <${o}> .`);
  }
  return lines;
}

function makeClaimsTriples(count) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    const cl = `urn:claim:bench_${i}`;
    const p = ENT(`Person_${i}`);
    const obj = ENT(`City_${i % 50}`);
    lines.push(`<${cl}> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${ONTO('Claim')}> .`);
    lines.push(`<${cl}> <${ONTO('claimSubject')}> <${p}> .`);
    lines.push(`<${cl}> <${ONTO('claimPredicate')}> <${CORE('livesIn')}> .`);
    lines.push(`<${cl}> <${ONTO('claimObject')}> <${obj}> .`);
    lines.push(`<${cl}> <${ONTO('status')}> "accepted" .`);
    lines.push(`<${cl}> <${ONTO('assertedInGraph')}> <${WORLDVIEW}> .`);
  }
  return lines;
}

async function bulkInsert(triplestore, graph, triples) {
  const CHUNK = 5000;
  for (let i = 0; i < triples.length; i += CHUNK) {
    const slice = triples.slice(i, i + CHUNK).join('\n');
    await triplestore.update(`INSERT DATA { GRAPH <${graph}> { ${slice} } }`);
  }
}

async function bench(facts) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ontofelia-iso-'));
  const dataDir = path.join(tmp, 'triplestore');
  mkdirSync(dataDir, { recursive: true });

  const triplestore = new OxigraphAdapter();
  await triplestore.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });

  const tboxTtl = await readFile(TBOX_PATH, 'utf-8');
  await triplestore.putGraph('urn:shared:ontology', tboxTtl, 'turtle');

  // Bulk load
  const wv = makeWorldviewTriples(facts);
  const cl = makeClaimsTriples(facts);
  await bulkInsert(triplestore, WORLDVIEW, wv);
  await bulkInsert(triplestore, CLAIMS, cl);

  // total
  const totalRes = await triplestore.query(`SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s ?p ?o } }`);
  const total = Number(totalRes.bindings?.[0]?.c?.value ?? -1);

  // 1. getGraph(worldview)
  let t = performance.now();
  const aboxTtl = await triplestore.getGraph(WORLDVIEW, 'turtle');
  const getGraphMs = performance.now() - t;
  const aboxKB = (aboxTtl.length / 1024) | 0;

  // 2. Reasoner alone — TWICE (mirrors materialize)
  t = performance.now();
  const newTriple = '<urn:ex:Test> <urn:ontofelia:core#livesIn> <urn:ontofelia:entity:City_0> .';
  inferTriples(tboxTtl, aboxTtl);
  const reason1Ms = performance.now() - t;
  t = performance.now();
  inferTriples(tboxTtl, aboxTtl + '\n' + newTriple);
  const reason2Ms = performance.now() - t;

  // 3. SPARQL ASK (supersede check)
  t = performance.now();
  await triplestore.ask(`
    PREFIX core: <urn:shared:ontology#>
    ASK {
      GRAPH <${CLAIMS}> {
        ?c a core:Claim ;
           core:claimSubject <urn:ontofelia:entity:Person_0> ;
           core:claimPredicate <urn:ontofelia:core#livesIn> ;
           core:claimObject ?o ;
           core:status "accepted" .
      }
    }
  `);
  const askMs = performance.now() - t;

  // 4. SELECT for conflicting claims (the real path in retireSupersededClaim)
  t = performance.now();
  await triplestore.query(`
    PREFIX core: <urn:shared:ontology#>
    SELECT ?c ?o WHERE {
      GRAPH <${CLAIMS}> {
        ?c a core:Claim ;
           core:claimSubject <urn:ontofelia:entity:Person_0> ;
           core:claimPredicate <urn:ontofelia:core#livesIn> ;
           core:claimObject ?o ;
           core:status "accepted" .
      }
    }
  `);
  const selectClaimsMs = performance.now() - t;

  // 5. Single INSERT DATA (includes implicit flush by adapter)
  t = performance.now();
  await triplestore.update(`INSERT DATA { GRAPH <${WORLDVIEW}> { <urn:ex:BenchSingle> <urn:ontofelia:core#livesIn> <urn:ontofelia:entity:City_0> . } }`);
  const insertWithFlushMs = performance.now() - t;

  // 6. dataset.nq size after one mutation
  const dsBytes = statSync(path.join(dataDir, 'dataset.nq')).size;

  try { await triplestore.stop(); } catch {}
  rmSync(tmp, { recursive: true, force: true });

  return {
    facts,
    total,
    aboxKB,
    datasetMB: +(dsBytes / 1024 / 1024).toFixed(1),
    getGraphMs: Math.round(getGraphMs),
    reason1Ms: Math.round(reason1Ms),
    reason2Ms: Math.round(reason2Ms),
    askMs: Math.round(askMs),
    selectClaimsMs: Math.round(selectClaimsMs),
    insertFlushMs: Math.round(insertWithFlushMs),
  };
}

const levelsArg = process.argv[2];
const LEVELS = levelsArg
  ? levelsArg.split(',').map(n => Number.parseInt(n, 10))
  : [1000, 5000, 15000, 30000, 60000];

console.error('Levels:', LEVELS.join(', '));
const results = [];
for (const n of LEVELS) {
  console.error(`\n=== Facts: ${n} ===`);
  try {
    const r = await bench(n);
    console.error(`  total:        ${r.total} triples`);
    console.error(`  ABox dump:    ${r.aboxKB} KB`);
    console.error(`  getGraph:     ${r.getGraphMs} ms`);
    console.error(`  reason base:  ${r.reason1Ms} ms`);
    console.error(`  reason ext:   ${r.reason2Ms} ms`);
    console.error(`  ASK claims:   ${r.askMs} ms`);
    console.error(`  SELECT clms:  ${r.selectClaimsMs} ms`);
    console.error(`  INSERT+flush: ${r.insertFlushMs} ms`);
    console.error(`  dataset.nq:   ${r.datasetMB} MB`);
    results.push(r);
  } catch (e) {
    console.error(`  FAILED: ${e.message}`);
    results.push({ facts: n, error: e.message });
  }
}

console.log(JSON.stringify(results, null, 2));
