import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { startGateway } from '../../index.js';
import { getDefaultConfig, OntofeliaConfig } from '@ontofelia/config';

describe('Agent Routes', () => {
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

  it('lists available tools', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/tools', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(200);
    const tools = res.json();
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0]).toHaveProperty('name');
  });

  it('allows fetching agent list', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/agents', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });

  it('allows fetching single agent state', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/agents/default', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('agentId', 'ontofelia');
  });

  it('rejects chat with invalid agentId', async () => {
    const res = await fastify.inject({ 
      method: 'POST', url: '/api/chat', 
      headers: { authorization: 'Bearer test-secret' },
      payload: { message: 'hello', agentId: 'non-existent' }
    });
    expect(res.statusCode).toBe(404);
  });

  it('allows chat with valid agent', async () => {
    const res = await fastify.inject({ 
      method: 'POST', url: '/api/chat', 
      headers: { authorization: 'Bearer test-secret' },
      payload: { message: 'hello', agentId: 'default' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeDefined();
  });

  it('allows listing sessions', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/sessions', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
  });
});
