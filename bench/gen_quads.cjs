#!/usr/bin/env node
/**
 * gen_quads.cjs — generate synthetic N-Quads for stress testing.
 *
 * Layout (per "fact" ≈ 3 quads in worldview):
 *   ex:Person_{i} a core:Person .
 *   ex:Person_{i} core:livesIn ex:City_{j} .
 *   ex:Person_{i} core:worksAt ex:Org_{k} .
 *
 * Plus claim+evidence provenance (≈ 12 + 5 = 17 quads in claims/evidence).
 *
 * Usage: node gen_quads.cjs <count> [outFile]
 *   <count>    number of "facts" — each yields ~3 worldview quads + provenance
 *   [outFile]  default ./dataset.nq
 */

const fs = require('fs');

const FACT_COUNT = Math.max(1, Number.parseInt(process.argv[2] || '10000', 10));
const OUT = process.argv[3] || './dataset.nq';

const WORLDVIEW = '<urn:ontofelia:worldview>';
const CLAIMS = '<urn:ontofelia:claims>';
const EVIDENCE = '<urn:ontofelia:evidence>';

const ENTITY = (slug) => `<urn:ontofelia:entity:${slug}>`;
const CORE = (frag) => `<urn:ontofelia:core#${frag}>`;
const ONTO = (frag) => `<urn:shared:ontology#${frag}>`;

const ws = fs.createWriteStream(OUT, { flags: 'w' });

function w(s) {
  if (!ws.write(s)) {
    return new Promise(r => ws.once('drain', r));
  }
}

const cityCount = Math.max(50, Math.floor(FACT_COUNT / 100));
const orgCount = Math.max(20, Math.floor(FACT_COUNT / 200));

(async () => {
  const start = Date.now();

  // Entity classes for cities and orgs (small set)
  for (let i = 0; i < cityCount; i++) {
    const c = ENTITY(`City_${i}`);
    await w(`${c} <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ${CORE('Place')} ${WORLDVIEW} .\n`);
    await w(`${c} <http://www.w3.org/2000/01/rdf-schema#label> "City_${i}" ${WORLDVIEW} .\n`);
  }
  for (let i = 0; i < orgCount; i++) {
    const o = ENTITY(`Org_${i}`);
    await w(`${o} <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ${CORE('Organization')} ${WORLDVIEW} .\n`);
    await w(`${o} <http://www.w3.org/2000/01/rdf-schema#label> "Org_${i}" ${WORLDVIEW} .\n`);
  }

  for (let i = 0; i < FACT_COUNT; i++) {
    const p = ENTITY(`Person_${i}`);
    const cIdx = i % cityCount;
    const oIdx = i % orgCount;
    const c = ENTITY(`City_${cIdx}`);
    const o = ENTITY(`Org_${oIdx}`);

    // 3 worldview quads per person
    await w(`${p} <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ${CORE('Person')} ${WORLDVIEW} .\n`);
    await w(`${p} ${CORE('livesIn')} ${c} ${WORLDVIEW} .\n`);
    await w(`${p} ${CORE('worksAt')} ${o} ${WORLDVIEW} .\n`);
    await w(`${p} <http://www.w3.org/2000/01/rdf-schema#label> "Person_${i}" ${WORLDVIEW} .\n`);

    // 2 claims per person (livesIn + worksAt) ≈ 16 quads each → 32 / person in claims
    for (const [j, [pred, obj]] of [
      ['livesIn', c],
      ['worksAt', o],
    ].entries()) {
      const claimUri = `<urn:claim:bench_${i}_${j}>`;
      await w(`${claimUri} <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ${ONTO('Claim')} ${CLAIMS} .\n`);
      await w(`${claimUri} ${ONTO('claimSubject')} ${p} ${CLAIMS} .\n`);
      await w(`${claimUri} ${ONTO('claimPredicate')} ${CORE(pred)} ${CLAIMS} .\n`);
      await w(`${claimUri} ${ONTO('claimObject')} ${obj} ${CLAIMS} .\n`);
      await w(`${claimUri} ${ONTO('assertedInGraph')} <urn:ontofelia:worldview> ${CLAIMS} .\n`);
      await w(`${claimUri} ${ONTO('status')} "accepted" ${CLAIMS} .\n`);
      await w(`${claimUri} ${ONTO('confidence')} "0.95"^^<http://www.w3.org/2001/XMLSchema#decimal> ${CLAIMS} .\n`);
      await w(`${claimUri} ${ONTO('confidenceLabel')} "high" ${CLAIMS} .\n`);
      await w(`${claimUri} ${ONTO('sourceKind')} "bench" ${CLAIMS} .\n`);
      await w(`${claimUri} ${ONTO('learnedAt')} "2026-05-20T00:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> ${CLAIMS} .\n`);

      const evUri = `<urn:evidence:bench_${i}_${j}>`;
      await w(`${claimUri} ${ONTO('hasEvidence')} ${evUri} ${CLAIMS} .\n`);
      await w(`${claimUri} ${ONTO('evidenceGraph')} <urn:ontofelia:evidence> ${CLAIMS} .\n`);

      await w(`${evUri} <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> ${ONTO('Evidence')} ${EVIDENCE} .\n`);
      await w(`${evUri} ${ONTO('evidenceType')} "bench" ${EVIDENCE} .\n`);
      await w(`${evUri} ${ONTO('rawText')} "synthetic fact ${i}/${j}" ${EVIDENCE} .\n`);
      await w(`${evUri} ${ONTO('capturedAt')} "2026-05-20T00:00:00.000Z"^^<http://www.w3.org/2001/XMLSchema#dateTime> ${EVIDENCE} .\n`);
    }

    if (i % 25000 === 0 && i > 0) {
      const ms = Date.now() - start;
      process.stderr.write(`  ${i}/${FACT_COUNT} (${ms} ms)\n`);
    }
  }
  await new Promise(r => ws.end(r));
  const ms = Date.now() - start;

  const stats = fs.statSync(OUT);
  console.log(JSON.stringify({
    facts: FACT_COUNT,
    cities: cityCount,
    orgs: orgCount,
    bytes: stats.size,
    fileMB: (stats.size / 1024 / 1024).toFixed(1),
    elapsedMs: ms,
  }));
})();
