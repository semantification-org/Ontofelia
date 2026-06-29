import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { startGateway } from '../../index.js';
import { getDefaultConfig, OntofeliaConfig } from '@ontofelia/config';

describe('Memory Routes', () => {
  let fastify: FastifyInstance;
  let config: OntofeliaConfig;

  beforeAll(async () => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
    config = getDefaultConfig();
    config.gateway.token = 'test-secret';
    config.gateway.port = 0;
    config.memory.backend = 'memory';
    fastify = await startGateway(config);
  });

  afterAll(async () => {
    await fastify.close();
  });

  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
  });

  it('returns registered named graph Turtle dumps', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/knowledge/graphs', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.agentId).toBe('ontofelia');
    expect(Array.isArray(body.graphs)).toBe(true);

    const uris = body.graphs.map((graph: { uri: string }) => graph.uri);
    expect(uris).toContain('urn:ontofelia:self');
    expect(uris).toContain('urn:shared:ontology');

    const selfGraph = body.graphs.find((graph: { uri: string }) => graph.uri === 'urn:ontofelia:self');
    expect(selfGraph.role).toBe('self');
    expect(selfGraph.agentId).toBe('ontofelia');
    expect(typeof selfGraph.turtle).toBe('string');
  });

  it('rejects /api/knowledge deletion without confirm', async () => {
    const res = await fastify.inject({ method: 'DELETE', url: '/api/knowledge', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Missing confirm/);
  });

  it('allows /api/knowledge deletion with confirm', async () => {
    const res = await fastify.inject({ method: 'DELETE', url: '/api/knowledge?confirm=true', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
  });

  it('enforces rate limit on knowledge deletion', async () => {
    // Delete already called in previous test
    const res = await fastify.inject({ method: 'DELETE', url: '/api/knowledge?confirm=true', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatch(/Rate limit exceeded/);
  });

  it('allows fetching ontology versions', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/ontology/versions', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('allows fetching ontology proposals', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/ontology/proposals', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});
