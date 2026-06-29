import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { startGateway } from '../index.js';
import { getDefaultConfig, OntofeliaConfig } from '@ontofelia/config';

describe('Gateway HTTP API', () => {
  let fastify: FastifyInstance;
  let config: OntofeliaConfig;

  beforeAll(async () => {
    config = getDefaultConfig();
    config.gateway.token = 'test-secret';
    config.gateway.port = 0; // Random port for tests
    config.memory.backend = 'memory';
    fastify = await startGateway(config);
  });

  afterAll(async () => {
    await fastify.close();
  });

  it('should return 200 for public /api/health', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', fuseki: null });
  });

  it('should return 401 for /api/status without token', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/status',
    });

    expect(response.statusCode).toBe(401);
  });

  it('should return 200 for /api/status with valid token', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/status',
      headers: {
        authorization: 'Bearer test-secret',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().running).toBe(true);
  });
});

describe('Gateway Startup Token Policy', () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
  });

  it('should throw if token is empty', async () => {
    const config = getDefaultConfig();
    config.gateway.token = '';
    config.gateway.port = 0;
    config.memory.backend = 'memory';
    
    await expect(startGateway(config)).rejects.toThrow('Gateway token is required. Run ontofelia onboard to generate one.');
  });

  it('should throw if bind is non-loopback and token is empty', async () => {
    const config = getDefaultConfig();
    config.gateway.token = '';
    config.gateway.bind = 'custom';
    config.gateway.port = 0;
    config.memory.backend = 'memory';
    
    await expect(startGateway(config)).rejects.toThrow('Gateway token is required');
  });
});
