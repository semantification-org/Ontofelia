import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import authRoutes from '../routes/auth.js';
import type { GatewayContext } from '../context.js';
import { getDefaultConfig, OntofeliaConfig } from '@ontofelia/config';
import type { AgentRuntime, FallbackRecord } from '@ontofelia/agent-runtime';
import type {
  ProviderAdapter, ChatRequest, ChatResponse, StreamEvent, ModelInfo
} from '@ontofelia/core';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

/** Provider whose model listing can be a list, an empty list or a failure. */
class ListingProvider implements ProviderAdapter {
  name = 'stub-provider';
  constructor(private models: ModelInfo[] | Error) {}
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    return { id: 'r', content: request.model, toolCalls: [], finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.chat(request) };
  }
  async listModels(): Promise<ModelInfo[]> {
    if (this.models instanceof Error) throw this.models;
    return this.models;
  }
}

/** Provider that does not implement the optional listModels(). */
class NoListProvider implements ProviderAdapter {
  name = 'stub-provider';
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; }
  async chat(): Promise<ChatResponse> {
    return { id: 'r', content: 'ok', toolCalls: [], finishReason: 'stop', usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async *chatStream(): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.chat() };
  }
}

/** Minimal stand-in for an agent: the route only reads config and the getter. */
function fakeAgent(model: string, fallback: FallbackRecord | null = null): AgentRuntime {
  return {
    config: { model },
    getLastFallback: () => fallback,
  } as unknown as AgentRuntime;
}

const KNOWN: ModelInfo[] = [
  { id: 'gpt-5.6-luna', name: 'Luna' },
  { id: 'gpt-5.5', name: 'Five Five' },
];

describe('Provider model validation and fallback visibility', () => {
  let fastify: FastifyInstance;
  let config: OntofeliaConfig;
  let agents: Map<string, AgentRuntime>;
  let homeDir: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    // The routes persist through os.homedir(); keep that off the real config.
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-gateway-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = homeDir;
    await fs.mkdir(path.join(homeDir, '.ontofelia'), { recursive: true });
    await fs.writeFile(
      path.join(homeDir, '.ontofelia', 'ontofelia.json5'),
      "{\n  provider: {\n    defaultModel: 'gpt-5.5',\n  },\n}\n",
      'utf-8'
    );

    config = getDefaultConfig();
    config.provider.defaultModel = 'gpt-5.5';
    config.provider.fallbackModels = ['gpt-5.5'];
    agents = new Map();
  });

  afterEach(async () => {
    if (fastify) await fastify.close();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(homeDir, { recursive: true, force: true }).catch(() => {});
  });

  const start = async (provider: ProviderAdapter): Promise<FastifyInstance> => {
    fastify = Fastify();
    const ctx = { config, provider, agents, pairingStore: {}, allowlistStore: {} } as unknown as GatewayContext;
    await fastify.register(authRoutes, ctx);
    await fastify.ready();
    return fastify;
  };

  const persistedModel = async (): Promise<string> => {
    const raw = await fs.readFile(path.join(homeDir, '.ontofelia', 'ontofelia.json5'), 'utf-8');
    return raw;
  };

  describe('PUT /api/config/model', () => {
    it('rejects an unknown model id with 400 and names the valid ones', async () => {
      const app = await start(new ListingProvider(KNOWN));
      const res = await app.inject({ method: 'PUT', url: '/api/config/model', payload: { model: 'new-model' } });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toContain('new-model');
      expect(res.json().validModels).toEqual(['gpt-5.6-luna', 'gpt-5.5']);
      // Nothing was applied or written.
      expect(config.provider.defaultModel).toBe('gpt-5.5');
      expect(await persistedModel()).toContain("defaultModel: 'gpt-5.5'");
    });

    it('accepts a known model id and applies it everywhere', async () => {
      agents.set('default', fakeAgent('gpt-5.5'));
      const app = await start(new ListingProvider(KNOWN));
      const res = await app.inject({ method: 'PUT', url: '/api/config/model', payload: { model: 'gpt-5.6-luna' } });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, model: 'gpt-5.6-luna' });
      expect(res.json().warning).toBeUndefined();
      expect(config.provider.defaultModel).toBe('gpt-5.6-luna');
      expect(agents.get('default')!.config.model).toBe('gpt-5.6-luna');
      expect(await persistedModel()).toContain("defaultModel: 'gpt-5.6-luna'");
    });

    it('accepts an unknown model id with force but returns a warning', async () => {
      const app = await start(new ListingProvider(KNOWN));
      const res = await app.inject({ method: 'PUT', url: '/api/config/model', payload: { model: 'new-model', force: true } });

      expect(res.statusCode).toBe(200);
      expect(res.json().model).toBe('new-model');
      expect(res.json().warning).toContain('new-model');
      expect(config.provider.defaultModel).toBe('new-model');
    });

    it('accepts with a warning when the provider has no listModels', async () => {
      const app = await start(new NoListProvider());
      const res = await app.inject({ method: 'PUT', url: '/api/config/model', payload: { model: 'new-model' } });

      expect(res.statusCode).toBe(200);
      expect(res.json().warning).toContain('could not be validated');
      expect(config.provider.defaultModel).toBe('new-model');
    });

    it('accepts with a warning when listModels throws', async () => {
      const app = await start(new ListingProvider(new Error('models endpoint unreachable')));
      const res = await app.inject({ method: 'PUT', url: '/api/config/model', payload: { model: 'new-model' } });

      expect(res.statusCode).toBe(200);
      expect(res.json().warning).toContain('could not be validated');
    });

    it('accepts with a warning when listModels returns an empty list', async () => {
      const app = await start(new ListingProvider([]));
      const res = await app.inject({ method: 'PUT', url: '/api/config/model', payload: { model: 'new-model' } });

      expect(res.statusCode).toBe(200);
      expect(res.json().warning).toContain('could not be validated');
    });

    it('still rejects a missing model id', async () => {
      const app = await start(new ListingProvider(KNOWN));
      const res = await app.inject({ method: 'PUT', url: '/api/config/model', payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('model is required');
    });
  });

  describe('PUT /api/config/fallback-models', () => {
    it('rejects unknown fallback ids with 400 and persists nothing', async () => {
      const app = await start(new ListingProvider(KNOWN));
      const res = await app.inject({
        method: 'PUT', url: '/api/config/fallback-models',
        payload: { models: ['gpt-5.5', 'no-such-model'] }
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().unknownModels).toEqual(['no-such-model']);
      expect(res.json().validModels).toEqual(['gpt-5.6-luna', 'gpt-5.5']);
      expect(config.provider.fallbackModels).toEqual(['gpt-5.5']);
    });

    it('accepts known fallback ids without a warning', async () => {
      const app = await start(new ListingProvider(KNOWN));
      const res = await app.inject({
        method: 'PUT', url: '/api/config/fallback-models',
        payload: { models: ['gpt-5.6-luna', 'gpt-5.5'] }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ fallbackModels: ['gpt-5.6-luna', 'gpt-5.5'] });
      expect(config.provider.fallbackModels).toEqual(['gpt-5.6-luna', 'gpt-5.5']);
    });

    it('accepts unknown fallback ids with force but warns', async () => {
      const app = await start(new ListingProvider(KNOWN));
      const res = await app.inject({
        method: 'PUT', url: '/api/config/fallback-models',
        payload: { models: ['no-such-model'], force: true }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().fallbackModels).toEqual(['no-such-model']);
      expect(res.json().warning).toContain('no-such-model');
    });

    it('warns when the model list cannot be obtained', async () => {
      const app = await start(new NoListProvider());
      const res = await app.inject({
        method: 'PUT', url: '/api/config/fallback-models',
        payload: { models: ['no-such-model'] }
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().warning).toContain('could not be validated');
    });

    it('still rejects a non-array payload', async () => {
      const app = await start(new ListingProvider(KNOWN));
      const res = await app.inject({
        method: 'PUT', url: '/api/config/fallback-models', payload: { models: 'gpt-5.5' }
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('models must be an array of strings');
    });
  });

  describe('GET /api/provider', () => {
    it('keeps every existing field and reports lastFallback as null without a fallback', async () => {
      agents.set('default', fakeAgent('gpt-5.5'));
      const app = await start(new ListingProvider(KNOWN));
      const res = await app.inject({ method: 'GET', url: '/api/provider' });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        name: 'stub-provider',
        model: 'gpt-5.5',
        healthy: true,
        autoFallback: true,
        fallbackModels: ['gpt-5.5'],
        lastFallback: null,
      });
    });

    it('reports the most recent fallback across agents including its agent', async () => {
      const older: FallbackRecord = {
        requestedModel: 'new-model', usedModel: 'gpt-5.5',
        reason: 'model not found', at: '2026-08-29T10:00:00.000Z'
      };
      const newer: FallbackRecord = {
        requestedModel: 'new-model', usedModel: 'gpt-5.6-luna',
        reason: 'model not found', at: '2026-08-29T12:00:00.000Z'
      };
      agents.set('default', fakeAgent('gpt-5.5', older));
      agents.set('second', fakeAgent('gpt-5.5', newer));

      const app = await start(new ListingProvider(KNOWN));
      const res = await app.inject({ method: 'GET', url: '/api/provider' });

      expect(res.statusCode).toBe(200);
      expect(res.json().lastFallback).toEqual({ ...newer, agentId: 'second' });
      // Backwards compatibility: the fields the web UI reads are untouched.
      expect(res.json().name).toBe('stub-provider');
      expect(res.json().model).toBe('gpt-5.5');
      expect(res.json().healthy).toBe(true);
      expect(res.json().autoFallback).toBe(true);
      expect(res.json().fallbackModels).toEqual(['gpt-5.5']);
    });
  });
});
