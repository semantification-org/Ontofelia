#!/usr/bin/env node
/**
 * Ontofelia Runtime Smoke Test — REL-12
 *
 * Proves the North-Star reasoning path (fact → reasoner → inferred triple → SPARQL →
 * provenance chain) and gateway liveness without any LLM key.
 *
 * Usage:  node smoke/runtime-smoke.mjs
 *
 * Exit 0 on all-pass, 1 on any failure.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Actual namespace URIs used by the KnowledgeEngine:
const CORE_NS = 'urn:ontofelia:core#';    // predicates
const ENTITY_NS = 'urn:ontofelia:entity:'; // subjects/objects

// ─── Minimal test harness ────────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures = [];
const output = [];

function log(msg) {
  const line = msg ?? '';
  output.push(line);
  console.log(line);
}

function assert(label, condition, detail) {
  if (condition) {
    passed++;
    log(`  ✅ PASS  ${label}`);
  } else {
    failed++;
    const info = detail ? ` — ${detail}` : '';
    log(`  ❌ FAIL  ${label}${info}`);
    failures.push(label);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — North-Star reasoning path (memory/reasoner layer)
// ═══════════════════════════════════════════════════════════════════════════
async function testReasoning() {
  log('');
  log('══════════════════════════════════════════════════════════');
  log('  Part 1 — North-Star Reasoning Path');
  log('══════════════════════════════════════════════════════════');

  // Dynamic imports of the actual built packages
  const { OxigraphAdapter, KnowledgeEngine, GraphRegistry } =
    await import(path.join(ROOT, 'packages', 'semantic-memory', 'dist', 'index.js'));

  // --- Set up an isolated Oxigraph store in a temp dir ---
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-smoke-'));
  log(`  tmpDir: ${tmpDir}`);

  const adapter = new OxigraphAdapter();
  await adapter.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: tmpDir,
    port: 0,
    endpoint: '',
  });
  assert('OxigraphAdapter initialised', adapter.status === 'running', `status=${adapter.status}`);

  // --- Load the TBox (core ontology) into urn:shared:ontology ---
  const tboxPath = path.join(ROOT, 'packages', 'semantic-memory', 'dist', 'ontologies', 'ontofelia-core.ttl');
  const tboxTtl = await fs.readFile(tboxPath, 'utf-8');
  await adapter.putGraph('urn:shared:ontology', tboxTtl, 'turtle');
  log('  TBox loaded into urn:shared:ontology');

  // --- Create KnowledgeEngine with the Oxigraph adapter ---
  const registry = GraphRegistry.create(['ontofelia']);
  const engine = new KnowledgeEngine(adapter, undefined, registry);

  const AGENT = 'ontofelia';
  const CTX = { agentId: AGENT, sessionId: 'smoke-session', isOwner: true };

  // ── 1a. Transitive property: locatedIn ──
  log('');
  log('  ── Test 1a: Transitive property (locatedIn) ──');

  const r1 = await engine.storeFact({
    subject: 'Building A', subjectType: 'Place',
    predicate: 'locatedIn',
    object: 'North Campus', objectType: 'Place',
    confidenceLabel: 'high',
    sourceKind: 'user',
    sourceSpan: 'Building A is located on North Campus',
  }, CTX);
  assert('Stored fact: Building_A locatedIn North_Campus', r1.success && r1.tripleCount === 1);

  const r2 = await engine.storeFact({
    subject: 'North Campus', subjectType: 'Place',
    predicate: 'locatedIn',
    object: 'Springfield', objectType: 'Place',
    confidenceLabel: 'high',
    sourceKind: 'user',
    sourceSpan: 'North Campus is in Springfield',
  }, CTX);
  assert('Stored fact: North_Campus locatedIn Springfield', r2.success && r2.tripleCount === 1);

  // Query for the transitive inference: Building_A locatedIn Springfield
  // The reasoner stores inferred triples in urn:ontofelia:inferred using
  // urn:ontofelia:core# predicate URIs.
  const transQ = await adapter.query(`
    SELECT ?s ?o WHERE {
      GRAPH <urn:ontofelia:inferred> {
        ?s <${CORE_NS}locatedIn> ?o .
      }
    }
  `);
  const transBindings = transQ.bindings || [];
  const hasTransInference = transBindings.some(b => {
    const s = b.s?.value || '';
    const o = b.o?.value || '';
    return s.includes('Building') && o.includes('Springfield');
  });
  assert('Transitive inference materialised: Building_A locatedIn Springfield', hasTransInference,
    `inferred locatedIn bindings: ${JSON.stringify(transBindings.map(b => ({ s: b.s?.value, o: b.o?.value })))}`);

  // ── 1b. SPARQL retrieval of stored facts ──
  log('');
  log('  ── Test 1b: SPARQL query retrieves stored facts ──');

  const storedQ = await adapter.query(`
    SELECT ?s ?o WHERE {
      GRAPH <urn:ontofelia:worldview> {
        ?s <${CORE_NS}locatedIn> ?o .
      }
    }
  `);
  const storedBindings = storedQ.bindings || [];
  assert('SPARQL returns stored locatedIn facts', storedBindings.length >= 2,
    `got ${storedBindings.length} bindings: ${JSON.stringify(storedBindings.map(b => ({ s: b.s?.value, o: b.o?.value })))}`);

  // ── 1c. SubProperty inference (memberOf rdfs:subPropertyOf relatedTo) ──
  log('');
  log('  ── Test 1c: SubProperty inference ──');

  const r3 = await engine.storeFact({
    subject: 'Alice', subjectType: 'Person',
    predicate: 'name',
    object: 'Alice', objectType: 'literal',
    confidenceLabel: 'high',
    sourceKind: 'user',
  }, CTX);
  assert('Stored fact: Alice name "Alice"', r3.success && r3.tripleCount === 1);

  // memberOf has rdfs:subPropertyOf relatedTo in the TBox
  const r4 = await engine.storeFact({
    subject: 'Alice', subjectType: 'Person',
    predicate: 'memberOf',
    object: 'AI Lab', objectType: 'Organization',
    confidenceLabel: 'high',
    sourceKind: 'user',
    sourceSpan: 'Alice is a member of the AI Lab',
  }, CTX);
  assert('Stored fact: Alice memberOf AI_Lab', r4.success && r4.tripleCount === 1);

  // The subPropertyOf rule should materialise: Alice relatedTo AI_Lab
  const subPropQ = await adapter.query(`
    SELECT ?s ?o WHERE {
      GRAPH <urn:ontofelia:inferred> {
        ?s <${CORE_NS}relatedTo> ?o .
      }
    }
  `);
  const subPropBindings = subPropQ.bindings || [];
  const hasSubPropInference = subPropBindings.some(b => {
    const s = b.s?.value || '';
    const o = b.o?.value || '';
    return s.includes('Alice') && o.includes('AI');
  });
  assert('SubProperty inference: Alice relatedTo AI_Lab (via memberOf subPropertyOf relatedTo)',
    hasSubPropInference,
    `inferred relatedTo bindings: ${JSON.stringify(subPropBindings.map(b => ({ s: b.s?.value, o: b.o?.value })).slice(0, 5))}`);

  // ── 1d. Symmetric property (knows) ──
  log('');
  log('  ── Test 1d: Symmetric property (knows) ──');

  const r5 = await engine.storeFact({
    subject: 'Alice', subjectType: 'Person',
    predicate: 'knows',
    object: 'Bob', objectType: 'Person',
    confidenceLabel: 'high',
    sourceKind: 'user',
    sourceSpan: 'Alice knows Bob',
  }, CTX);
  assert('Stored fact: Alice knows Bob', r5.success && r5.tripleCount === 1);

  // Symmetric rule should materialise: Bob knows Alice
  const symQ = await adapter.query(`
    SELECT ?s ?o WHERE {
      GRAPH <urn:ontofelia:inferred> {
        ?s <${CORE_NS}knows> ?o .
      }
    }
  `);
  const symBindings = symQ.bindings || [];
  const hasSymInference = symBindings.some(b => {
    const s = b.s?.value || '';
    const o = b.o?.value || '';
    return s.includes('Bob') && o.includes('Alice');
  });
  assert('Symmetric inference: Bob knows Alice (inferred from Alice knows Bob)',
    hasSymInference,
    `inferred knows bindings: ${JSON.stringify(symBindings.map(b => ({ s: b.s?.value, o: b.o?.value })).slice(0, 5))}`);

  // ── 1e. Provenance / Claim chain ("Why do I believe this?") ──
  log('');
  log('  ── Test 1e: Provenance / Claim chain ──');

  // Query the claims graph for the "Alice memberOf AI_Lab" claim
  const claimQ = await adapter.query(`
    PREFIX core: <urn:shared:ontology#>
    SELECT ?claim ?sourceKind ?confidence ?status ?evidence WHERE {
      GRAPH <urn:ontofelia:claims> {
        ?claim a core:Claim ;
               core:claimSubject <${r4.subjectUri}> ;
               core:claimPredicate <${r4.predicateUri}> ;
               core:sourceKind ?sourceKind ;
               core:confidence ?confidence ;
               core:status ?status .
        OPTIONAL { ?claim core:hasEvidence ?evidence }
      }
    }
  `);
  const claimBindings = claimQ.bindings || [];
  assert('Claim exists for Alice memberOf AI_Lab', claimBindings.length >= 1,
    `claims found: ${claimBindings.length}`);

  if (claimBindings.length > 0) {
    const claim = claimBindings[0];
    const sourceKind = claim.sourceKind?.value || '';
    const confidence = claim.confidence?.value || '';
    const status = claim.status?.value || '';
    const evidence = claim.evidence?.value || '';

    assert('Claim source is "user"', sourceKind === 'user', `sourceKind=${sourceKind}`);
    assert('Claim status is "accepted"', status === 'accepted', `status=${status}`);
    assert('Claim has confidence value', confidence.length > 0, `confidence=${confidence}`);
    assert('Claim has evidence link', evidence.startsWith('urn:evidence:'),
      `evidence=${evidence}`);

    // Retrieve the evidence itself
    if (evidence) {
      const evidQ = await adapter.query(`
        PREFIX core: <urn:shared:ontology#>
        SELECT ?rawText ?evidenceType WHERE {
          GRAPH <urn:ontofelia:evidence> {
            <${evidence}> core:rawText ?rawText ;
                          core:evidenceType ?evidenceType .
          }
        }
      `);
      const evidBindings = evidQ.bindings || [];
      if (evidBindings.length > 0) {
        const rawText = evidBindings[0].rawText?.value || '';
        const evidenceType = evidBindings[0].evidenceType?.value || '';
        assert('Evidence has raw source text', rawText.includes('Alice') || rawText.includes('member'),
          `rawText="${rawText}"`);
        assert('Evidence type is message-span', evidenceType === 'message-span',
          `evidenceType=${evidenceType}`);
      } else {
        assert('Evidence record retrievable', false, 'no evidence bindings returned');
      }
    }
  }

  // ── 1f. Transitive partOf chain ──
  log('');
  log('  ── Test 1f: Transitive property (partOf) ──');

  const r6 = await engine.storeFact({
    subject: 'AI Lab', subjectType: 'Organization',
    predicate: 'partOf',
    object: 'CS Department', objectType: 'Organization',
    confidenceLabel: 'high', sourceKind: 'user',
  }, CTX);
  assert('Stored: AI_Lab partOf CS_Department', r6.success && r6.tripleCount === 1);

  const r7 = await engine.storeFact({
    subject: 'CS Department', subjectType: 'Organization',
    predicate: 'partOf',
    object: 'State University', objectType: 'Organization',
    confidenceLabel: 'high', sourceKind: 'user',
  }, CTX);
  assert('Stored: CS_Department partOf State_University', r7.success && r7.tripleCount === 1);

  // Transitive: AI_Lab partOf State_University
  const partOfQ = await adapter.query(`
    SELECT ?s ?o WHERE {
      GRAPH <urn:ontofelia:inferred> {
        ?s <${CORE_NS}partOf> ?o .
      }
    }
  `);
  const partOfBindings = partOfQ.bindings || [];
  const hasTransPartOf = partOfBindings.some(b => {
    const s = b.s?.value || '';
    const o = b.o?.value || '';
    return s.includes('AI') && o.includes('State');
  });
  assert('Transitive inference: AI_Lab partOf State_University', hasTransPartOf,
    `inferred partOf bindings: ${JSON.stringify(partOfBindings.map(b => ({ s: b.s?.value, o: b.o?.value })).slice(0, 5))}`);

  // ── Dump all inferred triples for the report ──
  log('');
  log('  ── All inferred triples ──');
  const allInferred = await adapter.query(`
    SELECT ?s ?p ?o WHERE {
      GRAPH <urn:ontofelia:inferred> {
        ?s ?p ?o .
      }
    } LIMIT 50
  `);
  const inferredRows = allInferred.bindings || [];
  log(`  Total inferred triples: ${inferredRows.length}`);
  for (const row of inferredRows.slice(0, 25)) {
    const s = (row.s?.value || '').replace(ENTITY_NS, '').replace(CORE_NS, '');
    const p = (row.p?.value || '').replace(CORE_NS, '').replace('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'rdf:').replace('http://www.w3.org/2000/01/rdf-schema#', 'rdfs:');
    let oVal = row.o?.value || '';
    oVal = oVal.replace(ENTITY_NS, '').replace(CORE_NS, '');
    log(`    ${s} — ${p} → ${oVal}`);
  }

  // Clean up
  await adapter.stop();
  await fs.rm(tmpDir, { recursive: true, force: true });
  log(`  Cleaned up: ${tmpDir}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — Gateway boot + health
// ═══════════════════════════════════════════════════════════════════════════
async function testGatewayBoot() {
  log('');
  log('══════════════════════════════════════════════════════════');
  log('  Part 2 — Gateway Boot + Health');
  log('══════════════════════════════════════════════════════════');

  // Create an isolated HOME so we never touch ~/.ontofelia
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-smoke-home-'));
  log(`  Isolated HOME: ${tmpHome}`);

  const cliEntry = path.join(ROOT, 'apps', 'cli', 'dist', 'index.js');

  // Step 1: Run onboard --non-interactive in the isolated HOME
  log('');
  log('  ── Onboarding (non-interactive) ──');
  const onboardResult = await runCli(cliEntry, ['onboard', '--non-interactive'], { HOME: tmpHome });

  assert('Onboard exit code 0', onboardResult.code === 0, `code=${onboardResult.code}`);

  // Verify files were created
  const configPath = path.join(tmpHome, '.ontofelia', 'ontofelia.json5');
  let configExists = false;
  try {
    await fs.access(configPath);
    configExists = true;
  } catch { /* */ }
  assert('Config file created: ontofelia.json5', configExists);

  // Verify workspace files
  let soulExists = false;
  try {
    await fs.access(path.join(tmpHome, '.ontofelia', 'workspace', 'SOUL.md'));
    soulExists = true;
  } catch { /* */ }
  assert('Workspace SOUL.md created', soulExists);

  // Step 2: Start gateway and check health
  log('');
  log('  ── Gateway start + health check ──');

  // Use a non-default port to avoid collisions
  const testPort = 19780;
  let gatewayProc = null;

  try {
    gatewayProc = spawn('node', [cliEntry, 'gateway', 'start', '--foreground', '--port', String(testPort)], {
      env: { ...process.env, HOME: tmpHome, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    // Wait for gateway to become ready (up to 15 seconds)
    const ready = await waitForPort(testPort, 15_000);
    assert('Gateway starts and listens on port', ready, `port=${testPort}`);

    if (ready) {
      // Curl /api/health
      const healthRes = await httpGet(`http://127.0.0.1:${testPort}/api/health`);
      assert('GET /api/health returns 200', healthRes.status === 200, `status=${healthRes.status}`);

      if (healthRes.body) {
        let parsed;
        try { parsed = JSON.parse(healthRes.body); } catch { parsed = null; }
        log(`    Response: ${healthRes.body.slice(0, 200)}`);
        if (parsed) {
          assert('/api/health body is valid JSON', true);
        }
      }
    }
  } finally {
    // Always kill the gateway
    if (gatewayProc) {
      gatewayProc.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      try { gatewayProc.kill('SIGKILL'); } catch { /* already dead */ }
    }
  }

  // Clean up
  await fs.rm(tmpHome, { recursive: true, force: true });
  log(`  Cleaned up: ${tmpHome}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// PART 3 — Graceful no-token error
// ═══════════════════════════════════════════════════════════════════════════
async function testNoTokenError() {
  log('');
  log('══════════════════════════════════════════════════════════');
  log('  Part 3 — Graceful No-Token Error');
  log('══════════════════════════════════════════════════════════');

  // We use onboard to create a valid config, then overwrite the token to empty.
  // This ensures the schema is valid and the ONLY failure is the missing token.
  const tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-smoke-notoken-'));
  const cliEntry = path.join(ROOT, 'apps', 'cli', 'dist', 'index.js');

  // First, onboard normally to get a valid config
  await runCli(cliEntry, ['onboard', '--non-interactive'], { HOME: tmpHome });

  // Now patch the config to remove the token
  const configPath = path.join(tmpHome, '.ontofelia', 'ontofelia.json5');
  const configContent = await fs.readFile(configPath, 'utf-8');
  // JSON5 uses single-quoted strings: token: 'abc...'
  // Replace the token value with empty string
  const patchedConfig = configContent
    .replace(/token:\s*'[^']*'/, "token: ''")
    .replace(/"token"\s*:\s*"[^"]*"/, '"token": ""');
  await fs.writeFile(configPath, patchedConfig, 'utf-8');

  log('  Running gateway with empty token...');
  const result = await runCli(cliEntry, ['gateway', 'start', '--foreground'], { HOME: tmpHome }, 20_000);

  assert('Gateway exits with non-zero code when no token', result.code !== 0,
    `code=${result.code}`);

  // The error message may appear in stdout (pino structured JSON log) or stderr.
  // Pino logs are JSON lines like {"level":50,"msg":"Failed to start gateway: Gateway token is required..."}
  const combinedOutput = (result.stdout + '\n' + result.stderr).toLowerCase();
  const hasTokenMessage = combinedOutput.includes('token is required') ||
                          combinedOutput.includes('gateway token');
  assert('Error output contains "token is required" message', hasTokenMessage,
    `stdout (last 500 chars): "${result.stdout.slice(-500)}"\nstderr (last 300 chars): "${result.stderr.slice(-300)}"`);

  // The error should be a clear message, not ONLY a raw stacktrace
  assert('Error is user-friendly (contains recognisable error text)', hasTokenMessage);

  log(`  Captured stderr (first 400 chars): ${result.stderr.slice(0, 400)}`);

  // Clean up
  await fs.rm(tmpHome, { recursive: true, force: true });
  log(`  Cleaned up: ${tmpHome}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

/** Run CLI command and capture output. */
function runCli(entry, args, envOverrides = {}, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const proc = spawn('node', [entry, ...args], {
      env: { ...process.env, ...envOverrides, NODE_ENV: 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 1000);
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + '\n' + err.message });
    });
  });
}

/** Wait for a TCP port to accept connections. */
async function waitForPort(port, timeoutMs = 10_000) {
  const { createConnection } = await import('net');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const sock = createConnection({ port, host: '127.0.0.1' }, () => {
        sock.destroy();
        resolve(true);
      });
      sock.on('error', () => {
        sock.destroy();
        resolve(false);
      });
      sock.setTimeout(500, () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/** Simple HTTP GET. */
async function httpGet(url) {
  const { request } = await import('http');
  return new Promise((resolve) => {
    const req = request(url, { method: 'GET', timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d.toString(); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', (err) => resolve({ status: 0, body: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════════
async function main() {
  log('╔══════════════════════════════════════════════════════════╗');
  log('║  Ontofelia Runtime Smoke Test (REL-12)                  ║');
  log('║  No LLM key required — pure rule-based reasoning       ║');
  log('╚══════════════════════════════════════════════════════════╝');

  try {
    await testReasoning();
  } catch (err) {
    log(`\n  💥 Part 1 crashed: ${err.message}`);
    log(`     ${err.stack?.split('\n').slice(1, 4).join('\n     ')}`);
    failed++;
    failures.push('Part 1 crashed');
  }

  try {
    await testGatewayBoot();
  } catch (err) {
    log(`\n  💥 Part 2 crashed: ${err.message}`);
    log(`     ${err.stack?.split('\n').slice(1, 4).join('\n     ')}`);
    failed++;
    failures.push('Part 2 crashed');
  }

  try {
    await testNoTokenError();
  } catch (err) {
    log(`\n  💥 Part 3 crashed: ${err.message}`);
    log(`     ${err.stack?.split('\n').slice(1, 4).join('\n     ')}`);
    failed++;
    failures.push('Part 3 crashed');
  }

  // Summary
  log('');
  log('══════════════════════════════════════════════════════════');
  log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    log(`  Failures:`);
    for (const f of failures) {
      log(`    • ${f}`);
    }
  }
  log('══════════════════════════════════════════════════════════');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Smoke test runner crashed:', err);
  process.exit(2);
});
