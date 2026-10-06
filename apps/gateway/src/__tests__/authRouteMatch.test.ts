import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startGateway } from '../index.js';
import { getDefaultConfig } from '@ontofelia/config';

const TOKEN = 'test-secret';
const auth = { authorization: `Bearer ${TOKEN}` };

// Spellings of one logical /api/<rest> path. The router percent-decodes, so every
// spelling the router resolves to the route must be gated exactly like the plain one.
function variants(rest: string): string[] {
  return [
    `/api/${rest}`,
    `/%61pi/${rest}`,
    `/%61%70%69/${rest}`,
    `/ap%69/${rest}`,
    `/api%2f${rest}`,
    `/%41PI/${rest}`,
    `/API/${rest}`,
    `//api/${rest}`,
    `/api//${rest}`,
    `/./api/${rest}`,
    `/api/../api/${rest}`,
    `/x/../api/${rest}`,
    `/api/${rest}/`,
    `/api/${rest}.`,
  ];
}

describe('Gateway auth decides on the matched route', () => {
  let fastify: FastifyInstance;
  let tmpHome: string;
  let prevHome: string | undefined;
  const backupDir = () => path.join(tmpHome, '.ontofelia', 'backups');
  const backups = () => (fs.existsSync(backupDir()) ? fs.readdirSync(backupDir()) : []);

  beforeAll(async () => {
    // Gateway state lives under os.homedir(); point it at a temp dir.
    prevHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ontofelia-authroute-'));
    process.env.HOME = tmpHome;
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
    const config = getDefaultConfig();
    config.gateway.token = TOKEN;
    config.gateway.port = 0;
    config.memory.backend = 'memory';
    fastify = await startGateway(config);
  });

  afterAll(async () => {
    await fastify.close();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  // Unauthenticated: must never reach a handler. 401 is the expected answer; a 404 is accepted
  // only for spellings the router does not resolve to a route (the body must carry no API data).
  const expectGated = (res: { statusCode: number; body: string }) => {
    expect([401, 404]).toContain(res.statusCode);
    expect(res.body).not.toContain('"running"');
  };

  describe('GET /api/status', () => {
    for (const url of variants('status')) {
      it(`gated without token: ${url}`, async () => {
        expectGated(await fastify.inject({ method: 'GET', url }));
      });
    }
    it('plain and percent-encoded forms answer 401 exactly', async () => {
      for (const url of ['/api/status', '/%61pi/status', '/%41PI/status', '/ap%69/status', '/api/%73tatus']) {
        const res = await fastify.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(401);
      }
    });
    it('handler runs with the token on plain and encoded forms', async () => {
      for (const url of ['/api/status', '/%61pi/status', '/ap%69/status']) {
        const res = await fastify.inject({ method: 'GET', url, headers: auth });
        expect(res.statusCode, url).toBe(200);
        expect(res.json().running).toBe(true);
      }
    });
  });

  describe('GET /api/media', () => {
    for (const url of variants('media')) {
      it(`gated without token: ${url}`, async () => {
        const res = await fastify.inject({ method: 'GET', url });
        expectGated(res);
        expect(res.body).not.toBe('[]');
      });
    }
    it('handler runs with the token', async () => {
      for (const url of ['/api/media', '/%61pi/media']) {
        const res = await fastify.inject({ method: 'GET', url, headers: auth });
        expect(res.statusCode, url).toBe(200);
        expect(Array.isArray(res.json())).toBe(true);
      }
    });
  });

  describe('POST /api/webhooks (state-changing)', () => {
    const listCount = async () =>
      (await fastify.inject({ method: 'GET', url: '/api/webhooks', headers: auth })).json().length as number;

    it('is gated in every spelling and creates nothing without a token', async () => {
      const before = await listCount();
      let i = 0;
      for (const url of variants('webhooks')) {
        const res = await fastify.inject({
          method: 'POST', url, payload: { name: 'x', path: `/webhooks/unauth-${i++}`, enabled: true },
        });
        expectGated(res);
      }
      expect(await listCount()).toBe(before);
    });

    it('runs with the token (plain and encoded)', async () => {
      const before = await listCount();
      for (const [i, url] of ['/api/webhooks', '/%61pi/webhooks'].entries()) {
        const res = await fastify.inject({
          method: 'POST', url, headers: auth, payload: { name: 'x', path: `/webhooks/auth-${i}`, enabled: true },
        });
        expect(res.statusCode, url).toBe(200);
      }
      expect(await listCount()).toBe(before + 2);
    });
  });

  describe('DELETE /api/knowledge', () => {
    it('does not reach the handler without a token in any spelling', async () => {
      for (const base of variants('knowledge')) {
        const res = await fastify.inject({ method: 'DELETE', url: `${base}?confirm=true` });
        expectGated(res);
        expect(res.body).not.toContain('success');
        expect(res.body).not.toContain('Rate limit');
        expect(res.body).not.toContain('confirm');
      }
      // The handler writes a backup before it drops the store: none may exist.
      expect(backups()).toEqual([]);
    });

    it('without confirm the encoded form is still gated, not 400', async () => {
      const res = await fastify.inject({ method: 'DELETE', url: '/%61pi/knowledge' });
      expect(res.statusCode).toBe(401);
    });

    it('runs with the token (this is the one allowed deletion)', async () => {
      const res = await fastify.inject({ method: 'DELETE', url: '/api/knowledge?confirm=true', headers: auth });
      expect(res.statusCode).toBe(200);
      expect(backups().length).toBe(1);
    });
  });

  describe('public health route', () => {
    for (const url of ['/api/health', '/api/health?x=1', '/api/health?', '/%61pi/health', '/ap%69/health?x=1']) {
      it(`answers 200 without token: ${url}`, async () => {
        const res = await fastify.inject({ method: 'GET', url });
        expect(res.statusCode).toBe(200);
        expect(res.json().status).toBe('ok');
      });
    }
    it('does not make siblings public', async () => {
      for (const url of ['/api/health/x', '/api/healthz', '/api/health/']) {
        const res = await fastify.inject({ method: 'GET', url });
        expect(res.statusCode, url).toBe(401);
      }
    });
  });

  describe('unmatched paths', () => {
    it('unknown /api paths stay gated (401) and do not enumerate routes', async () => {
      for (const url of ['/api/nothing-here', '/%61pi/nothing-here', '/api']) {
        expect((await fastify.inject({ method: 'GET', url })).statusCode, url).toBe(401);
      }
    });
    it('malformed percent-encoding never reaches a handler', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/api/%zz' });
      expect([400, 401]).toContain(res.statusCode);
      expect(res.body).not.toContain('"running"');
    });
    it('unknown non-API paths are not gated (404, or the web UI when it is built)', async () => {
      const res = await fastify.inject({ method: 'GET', url: '/nothing-here' });
      expect(res.statusCode).not.toBe(401);
      expect(res.body).not.toContain('Unauthorized');
      if (res.statusCode === 200) {
        // Web UI built: the not-found handler serves the SPA shell.
        expect(String(res.headers['content-type'])).toContain('text/html');
      } else {
        expect(res.statusCode).toBe(404);
      }
    });
  });

  describe('exempt routes stay reachable without a token', () => {
    it('webhook pattern reaches its own handler (404 unknown path, not the hook 401)', async () => {
      const res = await fastify.inject({ method: 'POST', url: '/webhooks/does-not-exist', payload: {} });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Not found' });
    });

    it('registered webhook still reaches handler-level validation, not the hook', async () => {
      await fastify.inject({
        method: 'POST', url: '/api/webhooks', headers: auth,
        payload: { name: 'exempt', path: '/webhooks/exempt', enabled: true, maxPayloadBytes: 1024 },
      });
      const res = await fastify.inject({ method: 'POST', url: '/webhooks/exempt', payload: {} });
      expect(res.body).not.toBe('{"error":"Unauthorized"}');
    });

    it('canvas media patterns reach their own handler (own auth, own bodies)', async () => {
      const bad = await fastify.inject({ method: 'GET', url: '/canvas/media/abc?expires=9999999999999&sig=bad' });
      expect(bad.statusCode).toBe(401);
      expect(bad.json()).toEqual({ error: 'Invalid signature' });
      const thumb = await fastify.inject({ method: 'GET', url: '/canvas/media/abc/thumb?expires=9999999999999&sig=bad' });
      expect(thumb.json()).toEqual({ error: 'Invalid signature' });
      // The meta handler has its own bearer check and answers 404 for an unknown id when it passes.
      const meta = await fastify.inject({ method: 'GET', url: '/canvas/media/abc/meta', headers: auth });
      expect(meta.statusCode).toBe(404);
      expect(meta.json()).toEqual({ error: 'Not found' });
      const withToken = await fastify.inject({ method: 'GET', url: '/canvas/media/abc', headers: auth });
      expect(withToken.statusCode).toBe(404);
    });

    it('websocket routes are not rejected by the hook (plain GET, no upgrade)', async () => {
      for (const url of ['/ws', '/ws/node']) {
        const res = await fastify.inject({ method: 'GET', url });
        expect(res.body, url).not.toBe('{"error":"Unauthorized"}');
      }
    });
  });
});
