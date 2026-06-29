import { FastifyInstance, FastifyRequest } from 'fastify';
import type { GatewayContext } from '../context.js';
import { ChannelType, MessageEnvelope, PRIMARY_AGENT_ID } from '@ontofelia/core';

function resolveAgentId(agentId?: string): string {
  return !agentId || agentId === 'default' ? PRIMARY_AGENT_ID : agentId;
}

export default async function agentRoutes(fastify: FastifyInstance, ctx: GatewayContext) {
  const { agents, sessionStore, toolRegistry } = ctx;

  fastify.get('/api/tools', async () => {
    return toolRegistry.list().map(t => ({
      name: t.name,
      description: t.description,
      category: t.category,
      permissions: t.permissions
    }));
  });

  fastify.post('/api/chat', async (request: FastifyRequest<{ Body: { message: string, agentId?: string, channel?: string, senderId?: string, sessionId?: string } }>, reply) => {
    const { message, channel = 'webchat', senderId = 'owner', sessionId } = request.body;
    const agentId = resolveAgentId(request.body.agentId);

    const agent = agents.get(agentId);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const envelope: MessageEnvelope = {
      id: crypto.randomUUID(),
      channel: channel as ChannelType,
      accountId: 'none',
      chatType: 'dm',
      sender: { id: senderId, channelPrefix: channel, isOwner: senderId === 'owner' },
      timestamp: new Date().toISOString(),
      text: message,
      mentions: [],
      attachments: [],
      routingHints: { sessionId }
    };

    const response = await agent.handleMessage(envelope);
    return response;
  });

  fastify.get('/api/agents', async () => {
    return Array.from(agents.values()).map(a => a.getState());
  });

  fastify.get('/api/agents/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const agent = agents.get(resolveAgentId(request.params.id));
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });
    return agent.getState();
  });

  fastify.get('/api/sessions', async (request: FastifyRequest<{ Querystring: { agentId?: string; channel?: string } }>) => {
    const agentId = resolveAgentId(request.query.agentId);
    const channel = request.query.channel;
    let sessions = await sessionStore.listSessions(agentId);
    if (channel) {
      sessions = sessions.filter(s => s.sessionKey.startsWith(channel + ':'));
    }
    return sessions;
  });

  fastify.get('/api/sessions/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const session = await sessionStore.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    return session;
  });

  fastify.get('/api/sessions/:id/transcript', async (request: FastifyRequest<{ Params: { id: string }, Querystring: { limit?: string } }>, reply) => {
    const session = await sessionStore.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    const limit = request.query.limit ? parseInt(request.query.limit) : undefined;
    const entries = await sessionStore.loadTranscript(request.params.id, limit);
    return entries;
  });

  fastify.delete('/api/sessions/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    const deleted = await sessionStore.deleteSession(request.params.id);
    if (!deleted) return reply.code(404).send({ error: 'Session not found' });
    return { success: true };
  });

  fastify.patch('/api/sessions/:id', async (request: FastifyRequest<{ Params: { id: string }, Body: { displayName?: string } }>, reply) => {
    const session = await sessionStore.getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    if (request.body.displayName !== undefined) {
      await sessionStore.updateSession(request.params.id, { displayName: request.body.displayName });
    }
    return { success: true };
  });
}
