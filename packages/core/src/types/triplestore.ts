import { HealthResult } from './common.js';

/**
 * The identifier of the primary, always-present agent.
 *
 * This value flows into every agent-scoped Named Graph URI
 * (`urn:<agentId>:claims`, `urn:<agentId>:user:<id>`, …). It MUST be a
 * lowercase, concept-conformant agent identifier — never a placeholder like
 * "default", which would silently produce non-conformant graphs.
 */
export const PRIMARY_AGENT_ID = 'ontofelia';

/**
 * Resolve a caller-supplied agent identifier to a concrete agent id.
 *
 * The CLI and several API surfaces use the placeholder `"default"` (and
 * some callers pass nothing at all) to mean "the primary agent". This helper
 * is the single source of truth for that mapping — use it everywhere an
 * external `agentId` reaches an `agents.get(...)` lookup, so that a
 * `"default"` never silently misses the agent registry (e.g. cron jobs
 * created by `ontofelia cron add` firing into the void).
 */
export function resolveAgentId(agentId?: string | null): string {
  return !agentId || agentId === 'default' ? PRIMARY_AGENT_ID : agentId;
}

export interface TriplestoreAdapter {
  readonly backend: "fuseki" | "oxigraph" | "memory";
  readonly status: "stopped" | "starting" | "running" | "error";

  initialize(config: TriplestoreConfig): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  healthCheck(): Promise<HealthResult>;

  // SPARQL Operations
  query(sparql: string, namedGraph?: string): Promise<SparqlResult>;
  update(sparql: string): Promise<void>;

  // Graph Store Protocol
  getGraph(graphUri: string, format?: RdfFormat): Promise<string>;
  putGraph(graphUri: string, data: string, format?: RdfFormat): Promise<void>;
  deleteGraph(graphUri: string): Promise<void>;

  // Convenience
  insertTriples(graphUri: string, triples: Triple[]): Promise<void>;
  deleteTriples(graphUri: string, triples: Triple[]): Promise<void>;
  ask(sparql: string): Promise<boolean>;

  // Export/Import
  exportDataset(format: RdfFormat): Promise<string>;
  importDataset(data: string, format: RdfFormat): Promise<void>;

  // Backup
  backup(targetDir: string): Promise<string>;
  restore(backupPath: string): Promise<void>;
}

export interface TriplestoreConfig {
  backend: "fuseki" | "oxigraph" | "memory";
  type: "sidecar" | "remote" | "embedded";
  dataDir: string;
  port: number;
  endpoint: string;
  fusekiBinaryPath?: string;
  fusekiConfigPath?: string;
  javaPath?: string;
  healthCheckIntervalMs?: number;
  restartOnCrash?: boolean;
  maxRestartAttempts?: number;
}

export interface Triple {
  subject: string;
  predicate: string;
  object: string | { value: string; type?: string; language?: string };
}

export interface SparqlResult {
  type: "bindings" | "boolean" | "graph";
  variables?: string[];
  bindings?: Record<string, RdfTerm>[];
  boolean?: boolean;
  graph?: string;
}

export interface RdfTerm {
  type: "uri" | "literal" | "bnode";
  value: string;
  datatype?: string;
  language?: string;
}

export type RdfFormat = "turtle" | "jsonld" | "ntriples" | "rdfxml" | "trig";
