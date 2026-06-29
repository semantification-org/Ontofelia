import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';
import { KnowledgeEngine } from '../KnowledgeEngine.js';
import { GraphUriResolver } from '../utils/GraphUriResolver.js';

// Regression: re-seeding the setup graph (on every gateway boot) must NOT wipe
// the cognitive feature flags, which live in the SAME graph
// (urn:<agent>:setup:cognitive). Previously seedSetupGraph DROP'd the whole graph.
describe('seedSetupGraph preserves cognitive flags', () => {
  const AGENT = 'ontofelia';
  let dataDir: string;
  let store: OxigraphAdapter;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'onto-setup-'));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
  });

  afterEach(async () => {
    const maybeStoppable = store as { stop?: () => Promise<void> };
    if (typeof maybeStoppable.stop === 'function') await maybeStoppable.stop();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('keeps a cognitive flag triple across a re-seed', async () => {
    const engine = new KnowledgeEngine(store as unknown as ConstructorParameters<typeof KnowledgeEngine>[0]);
    const graph = GraphUriResolver.getSetupGraph(AGENT);
    const cogSubject = `urn:${AGENT}:setup:cognitive`;
    const flagPred = 'urn:shared:ontology#cog/flagCycleManager';

    await engine.seedSetupGraph(AGENT, { gatewayPort: 18780, gatewayHost: '127.0.0.1' });
    // simulate CognitiveConfig writing a flag into the SAME setup graph
    await store.update(
      `INSERT DATA { GRAPH <${graph}> { <${cogSubject}> <${flagPred}> "true"^^<http://www.w3.org/2001/XMLSchema#boolean> . } }`,
    );

    // a second boot re-seeds the environment — must not drop the flag
    await engine.seedSetupGraph(AGENT, { gatewayPort: 18780, gatewayHost: '127.0.0.1' });

    const res = await store.query(
      `SELECT ?v WHERE { GRAPH <${graph}> { <${cogSubject}> <${flagPred}> ?v } }`,
    );
    expect(res.bindings?.[0]?.v?.value).toBe('true');

    // and the environment subject was still refreshed (not duplicated/cleared)
    const env = await store.query(
      `SELECT ?o WHERE { GRAPH <${graph}> { <urn:${AGENT}:setup:Environment> <urn:ontofelia:core#gatewayPort> ?o } }`,
    );
    expect(env.bindings?.[0]?.o?.value).toBe('18780');
  });
});
