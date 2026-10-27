import { FastifyInstance, FastifyRequest } from 'fastify';
import type { GatewayContext } from '../context.js';
import { createLogger, resolveAgentId } from '@ontofelia/core';
import { GraphUriResolver, SHARED_GRAPHS, importVault, buildVaultExport, QueryTimeoutError, createQueryExecutor } from '@ontofelia/semantic-memory';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AuditLog } from '@ontofelia/tools';
import { fileURLToPath } from 'url';
import { Parser, Generator, type SparqlQuery } from 'sparqljs';
import { checkQueryAst, httpReadableGraphs } from '../sparqlGuard.js';

const PRIMARY_AGENT_ID = 'ontofelia';

/** Maximum number of rows returned by `POST /api/knowledge/sparql`. */
const SPARQL_MAX_ROWS = 1000;

const SPARQL_DEFAULT_TIMEOUT_MS = 5000;
const SPARQL_MIN_TIMEOUT_MS = 100;
const SPARQL_MAX_TIMEOUT_MS = 60000;

function resolveSparqlDeadline(configured: unknown): number {
  const n = typeof configured === 'number' && Number.isFinite(configured) ? configured : SPARQL_DEFAULT_TIMEOUT_MS;
  return Math.min(SPARQL_MAX_TIMEOUT_MS, Math.max(SPARQL_MIN_TIMEOUT_MS, Math.round(n)));
}
const AGENT_GRAPH_ROLES = [
  ['self', GraphUriResolver.getSelfGraph(PRIMARY_AGENT_ID)],
  ['skills', GraphUriResolver.getSkillsGraph(PRIMARY_AGENT_ID)],
  ['setup', GraphUriResolver.getSetupGraph(PRIMARY_AGENT_ID)],
  ['claims', GraphUriResolver.getClaimsGraph(PRIMARY_AGENT_ID)],
  ['evidence', GraphUriResolver.getEvidenceGraph(PRIMARY_AGENT_ID)],
  ['worldview', GraphUriResolver.getWorldviewGraph(PRIMARY_AGENT_ID)],
  ['schema', GraphUriResolver.getSchemaGraph(PRIMARY_AGENT_ID)],
  ['conflicts', GraphUriResolver.getConflictsGraph(PRIMARY_AGENT_ID)],
  ['inferred', GraphUriResolver.getInferredGraph(PRIMARY_AGENT_ID)],
] as const;

const SHARED_GRAPH_ROLES = Object.entries(SHARED_GRAPHS).map(([role, uri]) => [role.toLowerCase(), uri] as const);

function describeKnownGraph(uri: string): { role: string; agentId: string | null; shared: boolean } | null {
  const agentRole = AGENT_GRAPH_ROLES.find(([, graphUri]) => graphUri === uri);
  if (agentRole) {
    return { role: agentRole[0], agentId: PRIMARY_AGENT_ID, shared: false };
  }

  if (uri.startsWith(`urn:${PRIMARY_AGENT_ID}:inferred:user:`)) {
    return { role: 'inferred_user', agentId: PRIMARY_AGENT_ID, shared: false };
  }

  if (uri.startsWith(`urn:${PRIMARY_AGENT_ID}:user:`)) {
    return { role: 'user', agentId: PRIMARY_AGENT_ID, shared: false };
  }

  if (uri.startsWith(`urn:${PRIMARY_AGENT_ID}:session:`)) {
    return { role: 'session', agentId: PRIMARY_AGENT_ID, shared: false };
  }

  const sharedRole = SHARED_GRAPH_ROLES.find(([, graphUri]) => graphUri === uri);
  if (sharedRole) {
    return { role: `shared_${sharedRole[0]}`, agentId: null, shared: true };
  }

  return null;
}

export default async function memoryRoutes(fastify: FastifyInstance, ctx: GatewayContext) {
  const { triplestore, ontologyManager, ontologyBasePath, knowledgeEngine, agents } = ctx;
  const logger = createLogger('routes-memory');

  let lastKnowledgeDelete = 0;

  // The SPARQL endpoint runs queries through an executor so a runaway query can
  // be stopped (worker thread for Oxigraph). It starts its worker lazily.
  const sparqlDeadlineMs = resolveSparqlDeadline(ctx.config?.memory?.sparqlTimeoutMs);
  const sparqlExecutor = ctx.sparqlExecutor ?? createQueryExecutor(triplestore);
  if (!ctx.sparqlExecutor) {
    fastify.addHook('onClose', async () => {
      await sparqlExecutor.close();
    });
  }

  const listRegisteredGraphUris = () => {
    return [
      ...SHARED_GRAPH_ROLES.map(([, uri]) => uri),
      ...AGENT_GRAPH_ROLES.map(([, uri]) => uri),
    ];
  };

  const listMaterializedGraphUris = async () => {
    try {
      const result = await triplestore.query(`
        SELECT DISTINCT ?g WHERE {
          GRAPH ?g { ?s ?p ?o }
        }
        ORDER BY ?g
      `);

      if (result.type !== 'bindings' || !result.bindings) return [];

      return result.bindings
        .map((binding) => binding.g)
        .filter((term): term is NonNullable<typeof term> => term?.type === 'uri')
        .map((term) => term.value)
        .filter((uri) => describeKnownGraph(uri) !== null);
    } catch (e) {
      logger.warn('Could not list materialized Named Graphs: ' + (e as Error).message);
      return [];
    }
  };

  const countTriples = async (graphUri: string): Promise<number | null> => {
    try {
      const result = await triplestore.query(`
        SELECT (COUNT(*) AS ?count) WHERE {
          GRAPH <${graphUri}> { ?s ?p ?o }
        }
      `);
      const value = result.type === 'bindings' ? result.bindings?.[0]?.count?.value : undefined;
      const count = value ? Number.parseInt(value, 10) : Number.NaN;
      return Number.isFinite(count) ? count : null;
    } catch {
      return null;
    }
  };

  fastify.get('/api/knowledge/graphs', async (_request, reply) => {
    try {
      const graphUris = [
        ...new Set([
          ...listRegisteredGraphUris(),
          ...(await listMaterializedGraphUris()),
        ]),
      ].sort();

      const graphs = await Promise.all(graphUris.map(async (uri) => {
        const descriptor = describeKnownGraph(uri);
        try {
          const [turtle, tripleCount] = await Promise.all([
            triplestore.getGraph(uri, 'turtle'),
            countTriples(uri),
          ]);

          return {
            uri,
            role: descriptor?.role ?? 'unknown',
            agentId: descriptor?.agentId ?? null,
            shared: descriptor?.shared ?? false,
            turtle,
            tripleCount,
          };
        } catch (e) {
          return {
            uri,
            role: descriptor?.role ?? 'unknown',
            agentId: descriptor?.agentId ?? null,
            shared: descriptor?.shared ?? false,
            turtle: '',
            tripleCount: null,
            error: (e as Error).message,
          };
        }
      }));

      return {
        agentId: PRIMARY_AGENT_ID,
        graphs,
      };
    } catch (e) {
      logger.error('Failed to read knowledge graphs: ' + (e as Error).message);
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  /**
   * POST /api/knowledge/sparql: read-only SPARQL over HTTP.
   *
   * Body: `{ "query": string }`. Only SELECT and ASK are accepted. The query is
   * parsed strictly (no fallback): a parse error, any other query form, or a
   * SERVICE clause anywhere yields 400. Every triple pattern must lie inside a
   * GRAPH pattern, unless the query has a FROM clause that defines the default
   * graph; otherwise 400 (some backends expose the union of all graphs as the
   * default graph). A GRAPH pattern with a variable name, or any graph IRI
   * (GRAPH, FROM, FROM NAMED) that is not on the allowlist of
   * `httpReadableGraphs`, yields 403. The allowlist holds only graphs the agent
   * shows to every user anyway; the agent-wide graphs that carry other users'
   * data (claims, evidence, conflicts, episodic and the other cog graphs) and all
   * user, inferred-user and session graphs are refused, whoever the caller is.
   * The only credential is the gateway bearer token (see index.ts), which does
   * not identify a user, so no per-caller widening exists.
   *
   * SELECT results are capped at 1000 rows (the query is rewritten to LIMIT
   * min(user limit, 1001); a 1001st row only sets `truncated`).
   *
   * Response 200:
   * - ASK:    `{ "type": "boolean", "boolean": true }`
   * - SELECT: `{ "type": "bindings", "variables": ["s"], "bindings": [{ "s": { "type": "uri", "value": "..." } }], "truncated": false }`
   *   Terms are `{ type: "uri" | "literal" | "bnode", value, datatype?, language? }`.
   *   `variables` is taken from the first row and is empty when there are no rows.
   *
   * Deadline: `memory.sparqlTimeoutMs` (default 5000, clamped to 100..60000).
   * With the Oxigraph backend the query runs in a worker thread that is
   * terminated at the deadline (a fresh worker serves the next query), so a
   * runaway query yields 504 `{ "error": "Query exceeded the time limit of N ms" }`
   * and never blocks the event loop. The worker queries a replica of the
   * persisted dataset, reloaded whenever the data file changes; queries run one
   * at a time and the deadline starts when evaluation starts. With the on-disk
   * Oxigraph store the query runs on a native thread-pool task that the store
   * cancels at the deadline (no replica, no queue). Other backends
   * run in process: no real timeout is possible there (Fuseki aborts its HTTP
   * request after 30 s).
   *
   * Errors: `{ "error": string }` with status 400, 403, 500 or 504.
   */
  fastify.post('/api/knowledge/sparql', async (request: FastifyRequest<{ Body: { query?: unknown } }>, reply) => {
    const query = request.body?.query;
    if (typeof query !== 'string' || query.trim() === '') {
      return reply.code(400).send({ error: 'Body must be a JSON object with a non-empty "query" string' });
    }

    let parsed: SparqlQuery;
    try {
      parsed = new Parser().parse(query);
    } catch (e) {
      return reply.code(400).send({ error: 'SPARQL parse error: ' + (e as Error).message });
    }

    if (parsed.type !== 'query' || (parsed.queryType !== 'SELECT' && parsed.queryType !== 'ASK')) {
      return reply.code(400).send({ error: 'Only SELECT and ASK queries are allowed' });
    }

    // Closed allowlist, rebuilt per request so agents added later are covered.
    const allowedGraphs = httpReadableGraphs([PRIMARY_AGENT_ID, ...(agents ? agents.keys() : [])]);
    const violation = checkQueryAst(parsed, allowedGraphs);
    if (violation) {
      return reply.code(violation.status).send({ error: violation.message });
    }

    let toRun: string;
    try {
      if (parsed.queryType === 'SELECT') {
        parsed.limit = Math.min(parsed.limit ?? SPARQL_MAX_ROWS + 1, SPARQL_MAX_ROWS + 1);
      }
      toRun = new Generator().stringify(parsed);
    } catch (e) {
      return reply.code(400).send({ error: 'Query could not be normalized: ' + (e as Error).message });
    }

    try {
      const result = await sparqlExecutor.execute(toRun, sparqlDeadlineMs);
      if (result.type === 'boolean') {
        return { type: 'boolean', boolean: result.boolean === true };
      }
      if (result.type !== 'bindings') {
        return reply.code(500).send({ error: 'Unexpected result type from the triplestore' });
      }
      const rows = result.bindings ?? [];
      const truncated = rows.length > SPARQL_MAX_ROWS;
      return {
        type: 'bindings',
        variables: result.variables ?? [],
        bindings: truncated ? rows.slice(0, SPARQL_MAX_ROWS) : rows,
        truncated,
      };
    } catch (e) {
      if (e instanceof QueryTimeoutError) {
        return reply.code(504).send({ error: `Query exceeded the time limit of ${sparqlDeadlineMs} ms` });
      }
      logger.error('SPARQL query failed: ' + (e as Error).message);
      return reply.code(500).send({ error: 'Query execution failed: ' + (e as Error).message });
    }
  });

  fastify.delete('/api/knowledge', async (request: FastifyRequest<{ Querystring: { confirm?: string } }>, reply) => {
    try {
      if (request.query.confirm !== 'true') {
        return reply.code(400).send({ error: 'Missing confirm=true query parameter' });
      }

      const now = Date.now();
      if (now - lastKnowledgeDelete < 3600_000) {
        return reply.code(429).send({ error: 'Rate limit exceeded. Knowledge can only be deleted once per hour.' });
      }

      const home = os.homedir();
      const backupDir = path.join(home, '.ontofelia', 'backups');
      await fs.promises.mkdir(backupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `knowledge-${ts}.ttl`);

      const turtle = await triplestore.exportDataset('turtle');
      await fs.promises.writeFile(backupPath, turtle, 'utf-8');

      await triplestore.update(`DROP ALL`);
      lastKnowledgeDelete = now;

      const auditLog = new AuditLog(path.join(home, '.ontofelia'));
      await auditLog.log({
        timestamp: new Date().toISOString(),
        agentId: 'system',
        toolName: 'knowledge_delete',
        input: { reason: 'API request to DELETE /api/knowledge' },
        output: { deleted: true, backupPath },
        success: true,
        duration: 0,
        permissions: ['memory:delete']
      });

      // Re-load the core ontology into TBox
      try {
        const gatewayDirForKg = path.dirname(fileURLToPath(import.meta.url));
        const ttl = await fs.promises.readFile(
          path.resolve(gatewayDirForKg, '..', '..', '..', '..', 'packages', 'semantic-memory', 'dist', 'ontologies', 'ontofelia-core.ttl'),
          'utf-8'
        );
        await triplestore.putGraph('urn:ontofelia:tbox', ttl, 'turtle');
      } catch {
        // TBox reload is best-effort
      }

      logger.info('Knowledge graph cleared');
      return { deleted: true, backupPath, timestamp: new Date().toISOString() };
    } catch (e) {
      logger.error('Failed to clear knowledge: ' + (e as Error).message);
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // Re-apply bootstrap/self.ttl (persona/identity) to the self graph on a live
  // install, WITHOUT wiping runtime-learned facts. seedCoreGraphs only seeds an
  // empty self graph, so this is the only non-destructive way to push persona
  // edits after first boot (the alternative being a full factory reset).
  fastify.post('/api/ontology/reseed-self', async (_request, reply) => {
    try {
      const gatewayDir = path.dirname(fileURLToPath(import.meta.url));
      const bootstrapDir = path.resolve(gatewayDir, '..', '..', '..', '..', 'bootstrap');
      const report = await knowledgeEngine.reseedSelf(bootstrapDir, PRIMARY_AGENT_ID);
      logger.info(
        `Self graph re-seeded from bootstrap/self.ttl: bootstrap ${report.bootstrapBefore} → ${report.bootstrapAfter}, ` +
        `${report.preserved} learned/other triple(s) preserved`,
      );
      // After the persona, never before: the derived self-model reads the behavior
      // directives the reseed just wrote. Only with the self-model flag on (the
      // runtime does nothing with it off); the response gains a field only when
      // something was derived or the derivation failed.
      let selfModel: { capabilities: number; constraints: number } | undefined;
      let selfModelError: string | undefined;
      try {
        selfModel = await agents.get(PRIMARY_AGENT_ID)?.seedDerivedSelfModelIfEnabled();
      } catch (e) {
        selfModelError = (e as Error).message;
        logger.warn('Self-model re-derivation after reseed failed: ' + selfModelError);
      }
      return {
        ...report,
        ...(selfModel ? { selfModel } : {}),
        ...(selfModelError !== undefined ? { selfModelError } : {}),
      };
    } catch (e) {
      logger.error('Failed to reseed self graph: ' + (e as Error).message);
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // --- Vault-LD import (dry run by default) ---
  // Imports are serialised per agent so two apply runs cannot interleave.
  const vaultImportTails = new Map<string, Promise<unknown>>();
  const serialiseVaultImport = <T>(agentId: string, job: () => Promise<T>): Promise<T> => {
    const prev = vaultImportTails.get(agentId) ?? Promise.resolve();
    const run = prev.then(job, job);
    const tail = run.catch(() => undefined);
    vaultImportTails.set(agentId, tail);
    void tail.then(() => {
      if (vaultImportTails.get(agentId) === tail) vaultImportTails.delete(agentId);
    });
    return run;
  };

  fastify.post('/api/knowledge/vault-import', async (
    request: FastifyRequest<{ Body: { root?: string; vaultName?: string; agentId?: string; apply?: boolean } }>,
    reply,
  ) => {
    const body = request.body ?? {};
    const agentId = resolveAgentId(body.agentId);
    if (!agents.get(agentId)) return reply.code(404).send({ error: 'Agent not found' });

    if (typeof body.root !== 'string' || !path.isAbsolute(body.root)) {
      return reply.code(400).send({ error: 'root must be an absolute path' });
    }
    try {
      const st = await fs.promises.stat(body.root);
      if (!st.isDirectory()) return reply.code(400).send({ error: 'root is not a directory' });
    } catch {
      return reply.code(400).send({ error: 'root does not exist' });
    }
    if (typeof body.vaultName !== 'string') {
      return reply.code(400).send({ error: 'vaultName is required' });
    }
    const root = body.root;
    const vaultName = body.vaultName;
    const apply = body.apply === true;

    try {
      return await serialiseVaultImport(agentId, () =>
        importVault(knowledgeEngine, { root, vaultName, agentId, apply }));
    } catch (e) {
      const message = (e as Error).message ?? '';
      if (/^Invalid vaultName/.test(message) || /more than maxFiles/.test(message)) {
        return reply.code(400).send({ error: message });
      }
      logger.error('Vault import failed: ' + message);
      return reply.code(500).send({ error: 'Vault import failed' });
    }
  });

  // --- Vault-LD export (read-only) ---
  // Writes nothing on the server and takes no folder: the notes are returned as
  // JSON and the client decides where (and whether) to write them. Serialised
  // with imports of the same agent so it never reads a half-applied import.
  fastify.get('/api/knowledge/vault-export', async (
    request: FastifyRequest<{ Querystring: { agentId?: string } }>,
    reply,
  ) => {
    const agentId = resolveAgentId(request.query?.agentId);
    if (!agents.get(agentId)) return reply.code(404).send({ error: 'Agent not found' });
    try {
      const report = await serialiseVaultImport(agentId, () =>
        buildVaultExport(knowledgeEngine, { agentId }));
      return {
        notes: report.notes.map(n => ({ path: n.path, content: n.content })),
        totals: report.totals,
      };
    } catch (e) {
      logger.error('Vault export failed: ' + ((e as Error).message ?? ''));
      return reply.code(500).send({ error: 'Vault export failed' });
    }
  });

  // --- Ontology & Reasoning Endpoints ---
  fastify.get('/api/ontology/versions', async () => {
    return ontologyManager.listVersions();
  });

  fastify.get('/api/ontology/proposals', async () => {
    return ontologyManager.listProposals();
  });

  fastify.post('/api/ontology/proposals/:id/approve', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      const v = await ontologyManager.approveProposal(request.params.id);
      return { success: true, version: v };
    } catch (e: unknown) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  fastify.post('/api/ontology/proposals/:id/reject', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      const filePath = path.join(ontologyBasePath, 'proposals', `p-${request.params.id}.json`);
      if (!fs.existsSync(filePath)) {
        return reply.code(404).send({ error: 'Not found' });
      }
      const content = fs.readFileSync(filePath, 'utf-8');
      const proposal = JSON.parse(content);
      proposal.status = 'rejected';
      fs.writeFileSync(filePath, JSON.stringify(proposal, null, 2));
      return { success: true };
    } catch (e: unknown) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  fastify.post('/api/ontology/rollback', async (request: FastifyRequest<{ Body: { version: string } }>, reply) => {
    try {
      const v = await ontologyManager.rollback(request.body.version);
      return { success: true, version: v };
    } catch (e: unknown) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });
}
