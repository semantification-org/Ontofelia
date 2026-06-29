import { FastifyInstance, FastifyRequest } from 'fastify';
import type { GatewayContext } from '../context.js';
import { updateConfigField } from '@ontofelia/config';
import { createLogger, ChannelType } from '@ontofelia/core';
import * as path from 'path';
import * as os from 'os';

export default async function authRoutes(fastify: FastifyInstance, ctx: GatewayContext) {
  const { config, provider, pairingStore, allowlistStore, agents } = ctx;
  const logger = createLogger('routes-auth');

  // --- Provider Endpoints ---
  fastify.get('/api/provider', async () => {
    return { 
      name: provider.name, 
      model: config.provider?.defaultModel || 'mock',
      healthy: (await provider.healthCheck()).healthy,
      autoFallback: config.provider?.autoFallback !== false,
      fallbackModels: config.provider?.fallbackModels || []
    };
  });

  fastify.put('/api/config/fallback', async (request: FastifyRequest<{ Body: { enabled: boolean } }>, reply) => {
    const { enabled } = request.body;
    if (typeof enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled must be boolean' });
    }
    if (config.provider) {
      config.provider.autoFallback = enabled;
    }
    try {
      const configPath = path.join(os.homedir(), '.ontofelia', 'ontofelia.json5');
      await updateConfigField(configPath, 'provider.autoFallback', enabled);
    } catch (e) {
      logger.warn('Could not persist autoFallback change: ' + (e as Error).message);
    }
    return { autoFallback: enabled };
  });

  fastify.put('/api/config/fallback-models', async (request: FastifyRequest<{ Body: { models: string[] } }>, reply) => {
    const { models: newModels } = request.body;
    if (!Array.isArray(newModels)) {
      return reply.code(400).send({ error: 'models must be an array of strings' });
    }
    const cleaned = newModels.filter(m => typeof m === 'string' && m.trim().length > 0).map(m => m.trim());
    if (config.provider) {
      config.provider.fallbackModels = cleaned;
    }
    try {
      const configPath = path.join(os.homedir(), '.ontofelia', 'ontofelia.json5');
      await updateConfigField(configPath, 'provider.fallbackModels', cleaned);
    } catch (e) {
      logger.warn('Could not persist fallbackModels change: ' + (e as Error).message);
    }
    return { fallbackModels: cleaned };
  });

  fastify.get('/api/models', async () => {
    if (provider.listModels) {
      return provider.listModels();
    }
    return [];
  });

  fastify.post('/api/provider/test', async (request: FastifyRequest<{ Body: { text: string } }>) => {
    const res = await provider.chat({
      model: config.provider?.defaultModel || 'mock',
      messages: [{ role: 'user', content: request.body.text }]
    });
    return res;
  });

  fastify.put('/api/config/model', async (request: FastifyRequest<{ Body: { model: string } }>, reply) => {
    const { model } = request.body;
    if (!model || typeof model !== 'string') {
      return reply.code(400).send({ error: 'model is required' });
    }
    if (config.provider) {
      config.provider.defaultModel = model;
    }
    for (const [, agentRuntime] of agents) {
      if (agentRuntime.config) {
        agentRuntime.config.model = model;
      }
    }
    try {
      const configPath = path.join(os.homedir(), '.ontofelia', 'ontofelia.json5');
      await updateConfigField(configPath, 'provider.defaultModel', model);
    } catch (e) {
      logger.warn('Could not persist model change: ' + (e as Error).message);
    }
    logger.info(`Model changed to: ${model}`);
    return { success: true, model };
  });

  fastify.get('/api/pairing', async (request: FastifyRequest<{ Querystring: { channel?: string } }>) => {
    return await pairingStore.listPending(request.query.channel as ChannelType);
  });

  fastify.post('/api/pairing/approve', async (request: FastifyRequest<{ Body: { code: string } }>, reply) => {
    const { code } = request.body;
    const req = await pairingStore.approve(code);
    if (!req) return reply.code(404).send({ error: 'Pairing request not found' });
    await allowlistStore.add({
      channel: req.channel, senderId: req.senderId,
      displayName: req.displayName, pairedBy: 'pairing'
    });
    return { success: true };
  });

  fastify.post('/api/pairing/reject', async (request: FastifyRequest<{ Body: { code: string } }>, reply) => {
    const { code } = request.body;
    const req = await pairingStore.reject(code);
    if (!req) return reply.code(404).send({ error: 'Pairing request not found' });
    return { success: true };
  });

  fastify.get('/api/allowlist', async (request: FastifyRequest<{ Querystring: { channel?: string } }>) => {
    return await allowlistStore.list(request.query.channel as ChannelType);
  });

  fastify.post('/api/allowlist', async (request: FastifyRequest<{ Body: { channel: string, senderId: string, displayName?: string } }>) => {
    const { channel, senderId, displayName } = request.body;
    await allowlistStore.add({
      channel: channel as ChannelType, senderId, displayName, pairedBy: 'manual'
    });
    return { success: true };
  });

  fastify.delete('/api/allowlist', async (request: FastifyRequest<{ Body: { channel: string, senderId: string } }>) => {
    const { channel, senderId } = request.body;
    const removed = await allowlistStore.remove(channel as ChannelType, senderId);
    return { success: removed };
  });
}