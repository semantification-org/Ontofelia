import { FastifyInstance, FastifyRequest } from 'fastify';
import type { GatewayContext } from '../context.js';
import { MessageEnvelope, PRIMARY_AGENT_ID } from '@ontofelia/core';
import { safeCompareSecret } from '@ontofelia/security';

export default async function systemRoutes(fastify: FastifyInstance, ctx: GatewayContext) {
  const { agents, config, fusekiManager, triplestore, channelRegistry,
    conflictDetector, reflectionRunner, mediaStore, signedUrlService,
    mimeDetector, nodeRegistry, webhookRegistry } = ctx;

  // Bearer guard for routes that live OUTSIDE the global /api/* auth hook
  // (e.g. /canvas/*). Mirrors the hook semantics: only enforced when the
  // gateway is configured to require a token. Returns false (and replies 401)
  // when the request is unauthorized.
  const requireBearer = (request: FastifyRequest, reply: import('fastify').FastifyReply): boolean => {
    if (!config.gateway.auth.tokenRequired) return true;
    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !safeCompareSecret(authHeader.split(' ')[1], config.gateway.token)) {
      reply.code(401).send({ error: 'Unauthorized' });
      return false;
    }
    return true;
  };

  fastify.get('/api/health', async () => {
    let fusekiHealth = null;
    if (fusekiManager) {
      fusekiHealth = await fusekiManager.healthCheck();
    }
    return { status: 'ok', fuseki: fusekiHealth };
  });

  fastify.get('/api/status', async () => {
    let tripleCount = 0;
    try {
      const countResult = await triplestore.query('SELECT (COUNT(*) AS ?count) WHERE { GRAPH ?g { ?s ?p ?o } }');
      if (countResult?.type === 'bindings' && countResult.bindings?.[0]) {
        tripleCount = parseInt(countResult.bindings[0].count?.value || '0', 10);
      }
    } catch {
      // Triplestore may not be available
    }

    return {
      running: true,
      uptime: process.uptime(),
      version: '0.0.1',
      bind: config.gateway.bind,
      port: config.gateway.port,
      agents: { total: agents.size, running: Array.from(agents.values()).filter(a => a.lifecycle === 'running').length },
      channels: { total: channelRegistry.list().length, connected: channelRegistry.getConnected().length },
      memory: { backend: config.memory.backend, status: triplestore.status, tripleCount }
    };
  });

  fastify.get('/api/version', async () => {
    return { version: '0.0.1', build: 'dev', node: process.version, platform: process.platform };
  });

  fastify.get('/api/channels', async () => {
    return channelRegistry.list().map(c => ({
      type: c.type,
      status: c.status
    }));
  });

  fastify.get('/api/reasoning/conflicts', async () => {
    return conflictDetector.detectConflicts(PRIMARY_AGENT_ID);
  });

  fastify.post('/api/reasoning/reflect', async () => {
    return reflectionRunner.reflect(PRIMARY_AGENT_ID);
  });

  fastify.post('/webhooks/:path', async (request: FastifyRequest<{ Params: { path: string }, Body: unknown }>, reply) => {
    const fullPath = `/webhooks/${request.params.path}`;
    const webhook = webhookRegistry.getByPath(fullPath);
    if (!webhook || !webhook.enabled) return reply.code(404).send({ error: 'Not found' });

    const bodyStr = typeof request.body === 'string' ? request.body : JSON.stringify(request.body);
    if (Buffer.byteLength(bodyStr, 'utf8') > webhook.maxPayloadBytes) return reply.code(413).send({ error: 'Payload too large' });

    const validation = webhookRegistry.validateRequest(webhook, request.headers as Record<string, string | string[] | undefined>, bodyStr);
    if (!validation.valid) return reply.code(401).send({ error: validation.error });

    const nonce = request.headers['x-request-id'] || request.headers['x-nonce'];
    const nonceStr = Array.isArray(nonce) ? nonce[0] : nonce;
    if (nonceStr && webhookRegistry.checkReplay(nonceStr, webhook.replayWindowMs)) {
      return reply.code(409).send({ error: 'Replay detected' });
    }

    const agent = agents.get(webhook.agentId || PRIMARY_AGENT_ID);
    if (!agent) return reply.code(404).send({ error: 'Agent not found' });

    const prompt = webhook.prompt
      ? `${webhook.prompt}\n\nWebhook Payload:\n${bodyStr}`
      : `Webhook received:\n${bodyStr}`;

    const envelope: MessageEnvelope = {
      id: crypto.randomUUID(),
      channel: 'webhook', accountId: 'system', chatType: 'webhook',
      sender: { id: `webhook:${webhook.id}`, channelPrefix: 'webhook', isOwner: false },
      timestamp: new Date().toISOString(), text: prompt, mentions: [], attachments: [],
      routingHints: { forceNewSession: true }
    };

    try {
      const response = await agent.handleMessage(envelope);
      return { success: true, response: response.text };
    } catch (e: unknown) {
      return reply.code(500).send({ error: (e as Error).message });
    }
  });

  // --- Canvas Host Endpoints ---
  fastify.post('/canvas/upload', async (request, reply) => {
    if (!requireBearer(request, reply)) return;
    const data = await request.file();
    if (!data) return reply.code(400).send({ error: 'No file uploaded' });

    const buffer = await data.toBuffer();
    const mimeType = mimeDetector.detect(buffer, data.filename);

    const entry = await mediaStore.store({
      buffer, filename: data.filename, mimeType,
      uploadedBy: (request.headers['x-uploaded-by'] as string) || 'api'
    });

    if (mimeDetector.isImage(entry.mimeType)) {
      await mediaStore.createThumbnail(entry.id);
    }

    return { id: entry.id, url: signedUrlService.createSignedUrl(entry.id) };
  });

  fastify.get('/canvas/media/:id', async (request: FastifyRequest<{ Params: { id: string }, Querystring: { expires?: string; sig?: string } }>, reply) => {
    const { id } = request.params;
    const { expires, sig } = request.query;

    if (expires && sig) {
      if (!signedUrlService.validateSignature(id, expires, sig)) {
        return reply.code(401).send({ error: 'Invalid signature' });
      }
      if (Date.now() > parseInt(expires)) {
        return reply.code(410).send({ error: 'URL expired' });
      }
    } else {
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ') || !safeCompareSecret(authHeader.split(' ')[1], config.gateway.token)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    }

    const result = await mediaStore.getFile(id);
    if (!result) return reply.code(404).send({ error: 'Not found' });
    reply.type(result.entry.mimeType);
    return reply.send(result.stream);
  });

  fastify.get('/canvas/media/:id/thumb', async (request: FastifyRequest<{ Params: { id: string }, Querystring: { expires?: string; sig?: string } }>, reply) => {
    const { id } = request.params;
    const { expires, sig } = request.query;

    if (expires && sig) {
      if (!signedUrlService.validateSignature(id, expires, sig)) {
        return reply.code(401).send({ error: 'Invalid signature' });
      }
      if (Date.now() > parseInt(expires)) {
        return reply.code(410).send({ error: 'URL expired' });
      }
    } else {
      const authHeader = request.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ') || !safeCompareSecret(authHeader.split(' ')[1], config.gateway.token)) {
        return reply.code(401).send({ error: 'Unauthorized' });
      }
    }

    const result = await mediaStore.getThumbnail(id);
    if (!result) return reply.code(404).send({ error: 'Not found' });
    reply.type(result.mimeType);
    return reply.send(result.stream);
  });

  fastify.get('/canvas/media/:id/meta', async (request: FastifyRequest<{ Params: { id: string } }>, reply) => {
    if (!requireBearer(request, reply)) return;
    const entry = await mediaStore.getEntry(request.params.id);
    if (!entry) return reply.code(404).send({ error: 'Not found' });
    return entry;
  });

  fastify.get('/api/devices', async () => {
    return nodeRegistry.list();
  });

  fastify.post('/api/devices/:code/approve', async (request: FastifyRequest<{ Params: { code: string } }>, reply) => {
    const node = await nodeRegistry.approvePairing(request.params.code);
    if (!node) return reply.code(404).send({ error: 'Pairing code not found' });
    return { success: true, node };
  });

  fastify.post('/api/devices/:code/reject', async (request: FastifyRequest<{ Params: { code: string } }>, reply) => {
    const rejected = await nodeRegistry.rejectPairing(request.params.code);
    if (!rejected) return reply.code(404).send({ error: 'Pairing code not found' });
    return { success: true };
  });
}