import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { OntofeliaConfig } from '@ontofelia/config';
import type { Logger } from 'pino';
import { PRIMARY_AGENT_ID } from '@ontofelia/core';
import {
  FusekiManager, FusekiAdapter, InMemoryAdapter, OxigraphAdapter,
  OntologyManager, ConflictDetector, ReflectionRunner, KnowledgeEngine,
  FusekiWatchdog, GraphRegistry
} from '@ontofelia/semantic-memory';

export async function initTriplestore(config: OntofeliaConfig, currentDir: string, logger: Logger) {
  let triplestore;
  let fusekiManager: FusekiManager | null = null;
  let fusekiWatchdog: FusekiWatchdog | null = null;

  if (config.memory.backend === 'fuseki') {
    const fusekiHome = path.join(os.homedir(), '.ontofelia', 'triplestore', 'fuseki');
    const dataDir = path.join(os.homedir(), '.ontofelia', 'triplestore', 'tdb2');
    const configPath = path.join(os.homedir(), '.ontofelia', 'triplestore', 'fuseki-config.ttl');

    fusekiManager = new FusekiManager({
      dataDir, port: 18787, configPath, fusekiHome,
      javaPath: '/usr/bin/java', dataset: 'ontofelia', reasoning: true
    });

    logger.info('Ensuring Fuseki distribution...');
    await fusekiManager.ensureFuseki();
    logger.info('Starting Fuseki...');
    await fusekiManager.start();

    triplestore = new FusekiAdapter();
    await triplestore.initialize({
      backend: 'fuseki', type: 'sidecar', dataDir, port: 18787,
      endpoint: 'http://127.0.0.1:18787/ontofelia',
    });

    fusekiWatchdog = new FusekiWatchdog('http://127.0.0.1:18787/ontofelia', async () => {
      logger.warn('Restarting Fuseki via Watchdog...');
      await fusekiManager!.start();
    }, logger);
    fusekiWatchdog.start();
  } else if (config.memory.backend === 'oxigraph') {
    const dataDir = path.join(os.homedir(), '.ontofelia', 'triplestore', 'oxigraph');
    triplestore = new OxigraphAdapter();
    await triplestore.initialize({
      backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: ''
    });
    logger.info('Started Oxigraph Triplestore in embedded mode.');
  } else {
    triplestore = new InMemoryAdapter();
    await triplestore.initialize({
      backend: 'memory', type: 'embedded', dataDir: '', port: 0, endpoint: ''
    });
  }

  // Initialize KnowledgeEngine with the Named Graph whitelist. The registry
  // is seeded with the primary agent; provisioning a new agent must call
  // knowledgeEngine.registry.registerAgent(<id>).
  const graphRegistry = GraphRegistry.create([PRIMARY_AGENT_ID]);
  const knowledgeEngine = new KnowledgeEngine(triplestore, undefined, graphRegistry);
  try {
    const coreOntologyForTBox = await fs.promises.readFile(
      path.resolve(currentDir, '..', '..', '..', 'packages', 'semantic-memory', 'dist', 'ontologies', 'ontofelia-core.ttl'),
      'utf-8'
    );
    await triplestore.putGraph('urn:shared:ontology', coreOntologyForTBox, 'turtle');
    logger.info('Core ontology loaded into urn:shared:ontology graph');
  } catch (e) {
    logger.warn('Could not load core ontology into TBox: ' + (e as Error).message);
  }

  // Seed core Named Graphs
  try {
    const bootstrapDir = path.resolve(currentDir, '..', '..', '..', 'bootstrap');
    const { seeded } = await knowledgeEngine.seedCoreGraphs(bootstrapDir, PRIMARY_AGENT_ID);
    if (seeded.length > 0) {
      logger.info(`Core graphs seeded: ${seeded.join(', ')}`);
    }
  } catch (e) {
    logger.warn('Could not seed core graphs: ' + (e as Error).message);
  }

  // Ontology & Reasoning
  const ontologyBasePath = path.join(os.homedir(), '.ontofelia', 'ontology', 'agents', PRIMARY_AGENT_ID);
  const coreOntologyPath = path.resolve(currentDir, '..', '..', '..', 'packages', 'semantic-memory', 'dist', 'ontologies', 'ontofelia-core.ttl');
  const ontologyManager = new OntologyManager(PRIMARY_AGENT_ID, ontologyBasePath);
  await ontologyManager.initialize(coreOntologyPath);

  const conflictDetector = new ConflictDetector(triplestore);
  const reflectionRunner = new ReflectionRunner(triplestore, conflictDetector, ontologyManager);

  return { triplestore, fusekiManager, fusekiWatchdog, knowledgeEngine, ontologyManager, conflictDetector, reflectionRunner, ontologyBasePath };
}
