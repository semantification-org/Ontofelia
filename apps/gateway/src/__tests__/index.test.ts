import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
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

describe('Gateway /ws/node pairing', () => {
  let fastify: FastifyInstance;

  beforeAll(async () => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
    const config = getDefaultConfig();
    config.gateway.token = 'test-secret';
    config.gateway.port = 0;
    config.memory.backend = 'memory';
    fastify = await startGateway(config);
  });

  afterAll(async () => {
    await fastify.close();
  });

  function nextMessage(ws: { once: (ev: 'message', cb: (d: Buffer) => void) => void }): Promise<Record<string, unknown>> {
    return new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
  }

  const surfaces = [{ type: 'chat', capabilities: { text: true } }];

  it('answers the first pair_request with a pending code and rejects a second on the same socket', async () => {
    const ws = await fastify.injectWS('/ws/node');
    const first = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'pair_request', name: 'Kitchen', surfaces }));
    const response = await first;
    expect(response.type).toBe('pair_response');
    expect(response.status).toBe('pending');
    expect(response.code).toMatch(/^[A-Z2-9]{8}$/);

    const second = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'pair_request', name: 'Again', surfaces }));
    expect(await second).toEqual({ type: 'error', message: 'Pairing already requested on this connection' });

    // A flood of further requests on the same socket creates nothing: all are refused and
    // the global pending cap is not consumed, so a fresh socket is still served.
    const replies: Record<string, unknown>[] = [];
    ws.on('message', (d: Buffer) => replies.push(JSON.parse(d.toString())));
    for (let i = 0; i < 30; i++) ws.send(JSON.stringify({ type: 'pair_request', name: `Flood${i}`, surfaces }));
    await vi.waitFor(() => expect(replies).toHaveLength(30));
    expect(replies.every((r) => r.type === 'error')).toBe(true);
    const other = await fastify.injectWS('/ws/node');
    const fresh = nextMessage(other);
    other.send(JSON.stringify({ type: 'pair_request', name: 'Fresh', surfaces }));
    expect((await fresh).type).toBe('pair_response');
    other.terminate();

    // Only the first request exists.
    const ok = await fastify.inject({ method: 'POST', url: `/api/devices/${response.code}/approve`, headers: { authorization: 'Bearer test-secret' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().node.name).toBe('Kitchen');
    ws.terminate();
  });

  it('refuses an invalid name and allows a corrected retry on the same socket', async () => {
    const ws = await fastify.injectWS('/ws/node');
    const bad = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'pair_request', name: '   ', surfaces }));
    const err = await bad;
    expect(err.type).toBe('error');
    expect(String(err.message)).toMatch(/Invalid name/);
    const good = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'pair_request', name: 'Retry', surfaces }));
    expect((await good).type).toBe('pair_response');
    ws.terminate();
  });
});
