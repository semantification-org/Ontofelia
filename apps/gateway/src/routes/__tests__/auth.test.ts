import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { startGateway } from '../../index.js';
import { getDefaultConfig, OntofeliaConfig } from '@ontofelia/config';

describe('Auth Routes', () => {
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

  it('allows access to /api/provider with valid token', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/provider', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty('name');
  });

  it('rejects access to /api/provider with invalid token', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/provider', headers: { authorization: 'Bearer wrong-secret' } });
    expect(res.statusCode).toBe(401);
  });

  it('allows model change via /api/config/model', async () => {
    const res = await fastify.inject({ 
      method: 'PUT', url: '/api/config/model', 
      headers: { authorization: 'Bearer test-secret' }, 
      payload: { model: 'new-model' } 
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().model).toBe('new-model');
  });
  
  it('rejects model change with bad payload', async () => {
    const res = await fastify.inject({ 
      method: 'PUT', url: '/api/config/model', 
      headers: { authorization: 'Bearer test-secret' }, 
      payload: {} 
    });
    expect(res.statusCode).toBe(400);
  });
});
