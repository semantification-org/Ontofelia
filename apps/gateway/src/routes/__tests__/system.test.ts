import { describe, it, expect } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import systemRoutes from '../system.js';
import type { GatewayContext } from '../../context.js';
import type { AgentRuntime } from '@ontofelia/agent-runtime';
import type { SemanticParserStats } from '@ontofelia/semantic-memory';

// Minimal stub of GatewayContext: /api/status only touches agents, config,
// triplestore and channelRegistry, so the rest is stubbed just enough to
// satisfy the type and never gets called.
function buildCtx(agents: Map<string, AgentRuntime>): GatewayContext {
  return {
    config: {
      gateway: { bind: '127.0.0.1', port: 0, token: 'test', auth: { tokenRequired: false } },
      memory: { backend: 'memory' }
    } as unknown as GatewayContext['config'],
    agents,
    triplestore: {
      query: async () => ({ type: 'bindings', bindings: [{ count: { value: '0' } }] }),
      status: 'ok'
    } as unknown as GatewayContext['triplestore'],
    channelRegistry: {
      list: () => [],
      getConnected: () => []
    } as unknown as GatewayContext['channelRegistry']
  } as unknown as GatewayContext;
}

function agentStub(getSemanticParserStats: () => SemanticParserStats | undefined): AgentRuntime {
  return { getSemanticParserStats } as unknown as AgentRuntime;
}

async function buildFastify(ctx: GatewayContext): Promise<FastifyInstance> {
  const fastify = Fastify();
  await fastify.register(systemRoutes, ctx);
  await fastify.ready();
  return fastify;
}

describe('System Routes — /api/status semanticParser', () => {
  it('aggregates failures across agents, skips agents without a parser, and truncates lastError', async () => {
    const agents = new Map<string, AgentRuntime>();
    agents.set('withParser', agentStub(() => ({
      failures: 2,
      consecutiveFailures: 1,
      lastError: 'x'.repeat(500),
      lastErrorAt: '2026-10-03T00:00:00.000Z',
      lastFailedModel: 'm'
    })));
    agents.set('withoutParser', agentStub(() => undefined));

    const fastify = await buildFastify(buildCtx(agents));
    const res = await fastify.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.semanticParser.failures).toBe(2);
    expect(body.semanticParser.consecutiveFailures).toBe(1);
    expect(Object.keys(body.semanticParser.agents)).toEqual(['withParser']);
    expect(body.semanticParser.agents.withParser.lastError.length).toBe(300);

    await fastify.close();
  });

  it('skips an agent whose getSemanticParserStats() throws, without failing the request', async () => {
    const agents = new Map<string, AgentRuntime>();
    agents.set('throwing', agentStub(() => {
      throw new Error('boom');
    }));

    const fastify = await buildFastify(buildCtx(agents));
    const res = await fastify.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.semanticParser.failures).toBe(0);
    expect(body.semanticParser.agents).toEqual({});

    await fastify.close();
  });

  it('keeps all existing /api/status fields intact', async () => {
    const agents = new Map<string, AgentRuntime>();
    agents.set('a1', agentStub(() => undefined));

    const fastify = await buildFastify(buildCtx(agents));
    const res = await fastify.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.running).toBe(true);
    expect(body.memory).toBeDefined();
    expect(body.agents.total).toBe(1);

    await fastify.close();
  });
});
