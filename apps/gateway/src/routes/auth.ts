import { FastifyInstance, FastifyRequest } from 'fastify';
import type { GatewayContext } from '../context.js';
import { updateConfigField } from '@ontofelia/config';
import { createLogger, ChannelType } from '@ontofelia/core';
import type { FallbackRecord } from '@ontofelia/agent-runtime';
import * as path from 'path';
import * as os from 'os';

/** The last automatic fallback plus the agent it happened in. */
type ReportedFallback = FallbackRecord & { agentId: string };

export default async function authRoutes(fastify: FastifyInstance, ctx: GatewayContext) {
  const { config, provider, pairingStore, allowlistStore, agents } = ctx;
  const logger = createLogger('routes-auth');

  /**
   * The model ids the provider knows, or null when no list can be obtained
   * (no listModels, it threw, or it came back empty). A null result must never
   * be treated as "the model is unknown" — it means nothing could be checked.
   */
  async function knownModelIds(): Promise<string[] | null> {
    if (typeof provider.listModels !== 'function') return null;
    try {
      const models = await provider.listModels();
      const ids = (models || []).map(m => m.id).filter(id => typeof id === 'string' && id.length > 0);
      return ids.length > 0 ? ids : null;
    } catch (e) {
      logger.warn('Could not list provider models for validation: ' + (e as Error).message);
      return null;
    }
  }

  // --- Provider Endpoints ---
  fastify.get('/api/provider', async () => {
    // An automatic fallback means answers no longer come from the configured
    // model. Report the most recent one across all agents so it cannot stay
    // invisible in the API.
    let lastFallback: ReportedFallback | null = null;
    for (const [agentId, agentRuntime] of agents) {
      const record = agentRuntime.getLastFallback?.();
      if (!record) continue;
      // `at` is ISO-8601 in UTC, so a plain string compare orders it correctly.
      if (!lastFallback || record.at > lastFallback.at) {
        lastFallback = { ...record, agentId };
      }
    }
    return {
      name: provider.name,
      model: config.provider?.defaultModel || 'mock',
      healthy: (await provider.healthCheck()).healthy,
      autoFallback: config.provider?.autoFallback !== false,
      fallbackModels: config.provider?.fallbackModels || [],
      lastFallback
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

  fastify.put('/api/config/fallback-models', async (request: FastifyRequest<{ Body: { models: string[], force?: boolean } }>, reply) => {
    const { models: newModels, force } = request.body;
    if (!Array.isArray(newModels)) {
      return reply.code(400).send({ error: 'models must be an array of strings' });
    }
    const cleaned = newModels.filter(m => typeof m === 'string' && m.trim().length > 0).map(m => m.trim());

    const known = await knownModelIds();
    let warning: string | undefined;
    if (known) {
      const unknown = cleaned.filter(m => !known.includes(m));
      if (unknown.length > 0 && force !== true) {
        // Nothing is persisted: an unreachable fallback model turns the safety
        // net into a silent failure.
        return reply.code(400).send({
          error: `Unknown fallback model(s): ${unknown.join(', ')}. Send force: true to set them anyway.`,
          unknownModels: unknown,
          validModels: known
        });
      }
      if (unknown.length > 0) {
        warning = `Fallback model(s) not offered by provider ${provider.name} and set with force: ${unknown.join(', ')}.`;
        logger.warn(warning);
      }
    } else if (cleaned.length > 0) {
      warning = `Fallback models could not be validated: provider ${provider.name} returned no model list.`;
      logger.warn(warning);
    }

    if (config.provider) {
      config.provider.fallbackModels = cleaned;
    }
    try {
      const configPath = path.join(os.homedir(), '.ontofelia', 'ontofelia.json5');
      await updateConfigField(configPath, 'provider.fallbackModels', cleaned);
    } catch (e) {
      logger.warn('Could not persist fallbackModels change: ' + (e as Error).message);
    }
    return warning ? { fallbackModels: cleaned, warning } : { fallbackModels: cleaned };
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

  fastify.put('/api/config/model', async (request: FastifyRequest<{ Body: { model: string, force?: boolean } }>, reply) => {
    const { model, force } = request.body;
    if (!model || typeof model !== 'string') {
      return reply.code(400).send({ error: 'model is required' });
    }

    // A model id that no provider knows is accepted silently today and then
    // hidden by autoFallback. Check it against the provider's own list, and
    // when that list cannot be obtained, say so instead of accepting quietly.
    const known = await knownModelIds();
    let warning: string | undefined;
    if (known) {
      if (!known.includes(model) && force !== true) {
        return reply.code(400).send({
          error: `Unknown model: ${model}. Send force: true to set it anyway.`,
          model,
          validModels: known
        });
      }
      if (!known.includes(model)) {
        warning = `Model "${model}" is not offered by provider ${provider.name} and was set with force.`;
        logger.warn(warning);
      }
    } else {
      warning = `Model "${model}" could not be validated: provider ${provider.name} returned no model list.`;
      logger.warn(warning);
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
    return warning ? { success: true, model, warning } : { success: true, model };
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