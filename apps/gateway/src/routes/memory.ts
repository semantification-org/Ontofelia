import { FastifyInstance, FastifyRequest } from 'fastify';
import type { GatewayContext } from '../context.js';
import { createLogger, resolveAgentId } from '@ontofelia/core';
import { GraphUriResolver, SHARED_GRAPHS, importVault } from '@ontofelia/semantic-memory';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AuditLog } from '@ontofelia/tools';
import { fileURLToPath } from 'url';

const PRIMARY_AGENT_ID = 'ontofelia';
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
      return report;
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
