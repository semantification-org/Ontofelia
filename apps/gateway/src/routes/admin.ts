import { FastifyInstance, FastifyRequest } from 'fastify';
import type { GatewayContext } from '../context.js';
import { MessageEnvelope, PRIMARY_AGENT_ID } from '@ontofelia/core';

export default async function adminRoutes(fastify: FastifyInstance, ctx: GatewayContext) {
  const { agents, scheduler, webhookRegistry, sandboxAdapter,
    skillRegistry, pluginRegistry } = ctx;

  fastify.post('/api/cron-trigger', async (request: FastifyRequest<{ Body: { message?: string; agentId?: string } }>) => {
    const { message = 'Cron-Wakeup: Du wurdest von einem geplanten Job geweckt.', agentId = PRIMARY_AGENT_ID } = request.body || {};
    const agent = agents.get(agentId);
    if (!agent) return { error: 'Agent not found' };

    const envelope: MessageEnvelope = {
      id: crypto.randomUUID(),
      channel: 'system', accountId: 'cron', chatType: 'dm',
      sender: { id: 'cron', channelPrefix: 'system', isOwner: true },
      timestamp: new Date().toISOString(), text: message,
      mentions: [], attachments: [],
    };
    const response = await agent.handleMessage(envelope);
    return { success: true, response: response.text };
  });

  // Cognitive-architecture observability (doc 09 §9). Per-graph counts and
  // cycle-latency stats for the cognitive named graphs.
  fastify.get('/api/cog/health', async (request: FastifyRequest<{ Querystring: { agentId?: string } }>, reply) => {
    const agentId = request.query.agentId || PRIMARY_AGENT_ID;
    const agent = agents.get(agentId);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    const health = await agent.cogHealth();
    if (!health) return reply.code(503).send({ error: 'Cognitive architecture not active' });
    return health;
  });

  // Cognitive debug panel (doc 09 §10). Read-only projections behind the
  // cog.flagDebugPanel flag: 403 until an operator opts in. No route mutates
  // the cognitive graphs.
  fastify.get('/api/cog/inspect/cycles', async (
    request: FastifyRequest<{ Querystring: { agentId?: string; sessionId?: string; limit?: string } }>,
    reply,
  ) => {
    const agent = agents.get(request.query.agentId || PRIMARY_AGENT_ID);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    if (!request.query.sessionId) return reply.code(400).send({ error: 'sessionId required' });
    const ins = await agent.cogInspector();
    if (!ins) return reply.code(403).send({ error: 'Cognitive debug panel disabled' });
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    return ins.listCycles(request.query.sessionId, limit);
  });

  fastify.get('/api/cog/inspect/cycle', async (
    request: FastifyRequest<{ Querystring: { agentId?: string; sessionId?: string; cycleId?: string } }>,
    reply,
  ) => {
    const agent = agents.get(request.query.agentId || PRIMARY_AGENT_ID);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    if (!request.query.sessionId || !request.query.cycleId)
      return reply.code(400).send({ error: 'sessionId and cycleId required' });
    const ins = await agent.cogInspector();
    if (!ins) return reply.code(403).send({ error: 'Cognitive debug panel disabled' });
    const detail = await ins.getCycle(request.query.sessionId, request.query.cycleId);
    if (!detail) return reply.code(404).send({ error: 'Cycle not found' });
    return detail;
  });

  fastify.get('/api/cog/inspect/goals', async (
    request: FastifyRequest<{ Querystring: { agentId?: string; sessionId?: string } }>,
    reply,
  ) => {
    const agent = agents.get(request.query.agentId || PRIMARY_AGENT_ID);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    if (!request.query.sessionId) return reply.code(400).send({ error: 'sessionId required' });
    const ins = await agent.cogInspector();
    if (!ins) return reply.code(403).send({ error: 'Cognitive debug panel disabled' });
    return ins.listGoals(request.query.sessionId);
  });

  fastify.get('/api/cog/inspect/episodes', async (
    request: FastifyRequest<{ Querystring: { agentId?: string; entity?: string; limit?: string } }>,
    reply,
  ) => {
    const agent = agents.get(request.query.agentId || PRIMARY_AGENT_ID);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    const ins = await agent.cogInspector();
    if (!ins) return reply.code(403).send({ error: 'Cognitive debug panel disabled' });
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    return ins.listEpisodes(request.query.entity, limit);
  });

  fastify.get('/api/cog/inspect/explain', async (
    request: FastifyRequest<{ Querystring: { agentId?: string; sessionId?: string; cycleId?: string } }>,
    reply,
  ) => {
    const agent = agents.get(request.query.agentId || PRIMARY_AGENT_ID);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    if (!request.query.sessionId || !request.query.cycleId)
      return reply.code(400).send({ error: 'sessionId and cycleId required' });
    const ins = await agent.cogInspector();
    if (!ins) return reply.code(403).send({ error: 'Cognitive debug panel disabled' });
    return ins.explainResponse(request.query.sessionId, request.query.cycleId);
  });

  fastify.get('/api/skills', async () => {
    return skillRegistry.list().map(s => ({
      name: s.manifest.name,
      description: s.manifest.description,
      source: s.source
    }));
  });

  fastify.get('/api/plugins', async () => {
    return pluginRegistry.list().map(p => ({
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      active: p.active,
      trusted: p.trusted
    }));
  });

  fastify.post('/api/plugins/:name/activate', async (request: FastifyRequest<{ Params: { name: string } }>, reply) => {
    try {
      await pluginRegistry.activate(request.params.name);
      return { success: true };
    } catch (e: unknown) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  fastify.post('/api/plugins/:name/deactivate', async (request: FastifyRequest<{ Params: { name: string } }>, reply) => {
    try {
      await pluginRegistry.deactivate(request.params.name);
      return { success: true };
    } catch (e: unknown) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  fastify.get('/api/cron', async () => {
    return {
      cronJobs: scheduler.listCronJobs(),
      oneTimeJobs: scheduler.listOneTimeJobs()
    };
  });

  fastify.post('/api/cron', async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    try {
      const job = await scheduler.addCronJob(request.body as Parameters<typeof scheduler.addCronJob>[0]);
      return { success: true, job };
    } catch (e: unknown) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  fastify.delete('/api/cron/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const removed = await scheduler.removeJob(request.params.id);
    if (!removed) return reply.code(404).send({ error: 'Job not found' });
    return { success: true };
  });

  fastify.post('/api/cron/:id/trigger', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      await scheduler.triggerJob(request.params.id);
      return { success: true };
    } catch (e: unknown) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  fastify.get('/api/sandboxes', async () => {
    return sandboxAdapter.list();
  });

  fastify.delete('/api/sandboxes/:id', async (request: FastifyRequest<{ Params: { id: string } }>) => {
    await sandboxAdapter.destroy(request.params.id);
    return { success: true };
  });

  fastify.post('/api/sandboxes/prune', async (request: FastifyRequest<{ Body: { idleHours?: number; maxAgeDays?: number } }>, reply) => {
    try {
      const removed = await sandboxAdapter.prune(request.body || {});
      return { success: true, removed };
    } catch (e: unknown) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  fastify.get('/api/webhooks', async () => {
    return webhookRegistry.list();
  });

  fastify.post('/api/webhooks', async (request: FastifyRequest<{ Body: unknown }>, reply) => {
    try {
      const webhook = await webhookRegistry.create(request.body as Parameters<typeof webhookRegistry.create>[0]);
      return { success: true, webhook };
    } catch (e: unknown) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  fastify.delete('/api/webhooks/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const removed = await webhookRegistry.delete(request.params.id);
    if (!removed) return reply.code(404).send({ error: 'Webhook not found' });
    return { success: true };
  });
}