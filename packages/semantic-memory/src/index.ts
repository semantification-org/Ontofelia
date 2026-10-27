export * from './fuseki/FusekiManager.js';
export * from './adapters/FusekiAdapter.js';
export * from './adapters/InMemoryAdapter.js';
export * from './adapters/OxigraphAdapter.js';
export * from './adapters/OxigraphDiskAdapter.js';
export * from './reasoning/ReasonableEngine.js';
export * from './reasoning/ReasoningGate.js';
export * from './ontology/OntologyManager.js';
export * from './reasoning/ConflictDetector.js';
export * from './reflection/ReflectionRunner.js';
export { reflectOnWorldview } from './reflection/worldviewReflection.js';
export * from './KnowledgeEngine.js';
export * from './ner/EntityMatcher.js';
export * from './FusekiWatchdog.js';

// Named Graph topology — URI resolution, write whitelist, and the registry
export * from './utils/SparqlSyntax.js';
export * from './utils/TripleSyntax.js';
export * from './utils/GraphUriResolver.js';
export * from './utils/GraphRegistry.js';
export * from './utils/GraphCatalog.js';

// Cognitive architecture long-term memory
export * from './cognitive/EpisodicMemory.js';
export * from './cognitive/ProceduralMemory.js';
export * from './cognitive/SelfModel.js';
export * from './cognitive/EpisodicConsolidation.js';
export * from './cognitive/ChoiceCapture.js';
export * from './cognitive/PreferenceConsolidation.js';

// Ontology Learning pipeline (Milestone 1)
export * from './ingestion/types.js';
export * from './ingestion/TrivialMessageDetector.js';
export * from './ingestion/SemanticParser.js';
export * from './ingestion/OntologyContextProvider.js';
export * from './ingestion/SemanticIngestionService.js';
export * from './sparql/scopeGuard.js';
export * from './ingestion/VaultNoteMapper.js';
export * from './ingestion/VaultImporter.js';
export * from './export/VaultExporter.js';
export * from './adapters/QueryExecutor.js';
