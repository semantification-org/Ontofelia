import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { startGateway } from '../../index.js';
import { getDefaultConfig } from '@ontofelia/config';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// A new install (a fresh HOME: the self graph is seeded in this boot and
// nothing else is there) starts with the cognitive layer on, except retention
// and initiative. The existing-install side is covered by the three sibling
// tests that seed data first and then see every flag off.

describe('gateway boot on a fresh install', () => {
  let fastify: FastifyInstance;
  const realHome = process.env.HOME;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cog-fresh-'));
    process.env.HOME = tmpHome;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
    const config = getDefaultConfig();
    config.gateway.token = 'test-secret';
    config.gateway.port = 0;
    config.memory.backend = 'oxigraph';
    fastify = await startGateway(config);
  });

  afterAll(async () => {
    await fastify.close();
    process.env.HOME = realHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('turns the default-on set on and leaves retention and initiative off', async () => {
    const res = await fastify.inject({ method: 'GET', url: '/api/cog/health', headers: { authorization: 'Bearer test-secret' } });
    expect(res.statusCode).toBe(200);
    const flags = res.json().flags as Record<string, boolean>;
    expect(Object.keys(flags)).toHaveLength(13);
    for (const [key, on] of Object.entries(flags)) {
      expect(on, key).toBe(key !== 'retention' && key !== 'initiative');
    }
  });
});
