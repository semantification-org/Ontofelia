import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { startGateway } from '../../index.js';
import adminRoutes from '../admin.js';
import { getDefaultConfig } from '@ontofelia/config';
import { AgentRuntime, GoalStack } from '@ontofelia/agent-runtime';
import { EpisodicMemory, GraphRegistry } from '@ontofelia/semantic-memory';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { seedExistingInstall } from './existingInstall.js';

// The inspect routes read every user's cycles, goals and episodes. They need
// the debug-panel flag AND the gateway's bearer token, and their output is
// scoped to the owner's records unless the operator passes scope=all.

const auth = { authorization: 'Bearer test-secret' };
const COGT = 'urn:shared:ontology#cog/';

describe('/api/cog/inspect/* — owner credential and scope', () => {
  let fastify: FastifyInstance;
  let agent: AgentRuntime | undefined;
  const realHome = process.env.HOME;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cog-inspect-priv-'));
    process.env.HOME = tmpHome;
    seedExistingInstall(tmpHome); // an existing install: nothing of the new-install defaults applies
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
    const original = AgentRuntime.prototype.cogInspector;
    vi.spyOn(AgentRuntime.prototype, 'cogInspector').mockImplementation(function (this: AgentRuntime) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- capture the runtime instance for seeding
      agent = this;
      return original.call(this);
    });
    const config = getDefaultConfig();
    config.gateway.token = 'test-secret';
    config.gateway.port = 0;
    config.memory.backend = 'oxigraph';
    fastify = await startGateway(config);
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await fastify.close();
    process.env.HOME = realHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const URLS = [
    '/api/cog/inspect/cycles?sessionId=s1',
    '/api/cog/inspect/cycle?sessionId=s1&cycleId=c1',
    '/api/cog/inspect/goals?sessionId=s1',
    '/api/cog/inspect/episodes',
    '/api/cog/inspect/initiative',
    '/api/cog/inspect/explain?sessionId=s1&cycleId=c1',
  ];

  it('refuses every inspect route without the credential or with a wrong one', async () => {
    for (const url of URLS) {
      expect((await fastify.inject({ method: 'GET', url })).statusCode).toBe(401);
      const wrong = await fastify.inject({ method: 'GET', url, headers: { authorization: 'Bearer nope' } });
      expect(wrong.statusCode).toBe(401);
    }
  });

  it('is 403 with the credential while the debug panel is off, and /api/cog/health stays reachable', async () => {
    for (const url of URLS) {
      const res = await fastify.inject({ method: 'GET', url, headers: auth });
      expect(res.statusCode).toBe(403);
    }
    expect((await fastify.inject({ method: 'GET', url: '/api/cog/health', headers: auth })).statusCode).toBe(200);
  });

  it('scopes episodes and goals to the owner\'s records unless scope=all', async () => {
    expect(agent).toBeDefined();
    const rt = agent!;
    const store = rt['knowledgeEngine']!['triplestore'];
    const em = new EpisodicMemory(store, 'ontofelia');
    await em.append({ episodeType: 'message-received', forUser: 'owner', payload: 'owner episode' });
    await em.append({ episodeType: 'message-received', forUser: 'telegram:111', payload: 'alice episode' });
    await em.append({ episodeType: 'message-received', payload: 'legacy episode' });
    const registry = GraphRegistry.create(['ontofelia']);
    const gs = new GoalStack(store, registry, 'ontofelia', 's1');
    await gs.push({ goalType: `${COGT}AnswerQuestion`, goalLabel: 'Owner goal', priority: 0.5, forUser: 'owner' });
    await gs.push({ goalType: `${COGT}AnswerQuestion`, goalLabel: 'Alice goal', priority: 0.5, forUser: 'telegram:111' });
    await rt['cognitiveConfig']!.setDebugPanelEnabled(true);

    const payloads = (res: { json: () => Array<{ payload?: string }> }) => res.json().map((e) => e.payload).sort();
    const labels = (res: { json: () => Array<{ goalLabel: string }> }) => res.json().map((g) => g.goalLabel).sort();

    const own = await fastify.inject({ method: 'GET', url: '/api/cog/inspect/episodes', headers: auth });
    expect(own.statusCode).toBe(200);
    expect(payloads(own)).toEqual(['legacy episode', 'owner episode']);

    const all = await fastify.inject({ method: 'GET', url: '/api/cog/inspect/episodes?scope=all', headers: auth });
    expect(payloads(all)).toEqual(['alice episode', 'legacy episode', 'owner episode']);

    const ownGoals = await fastify.inject({ method: 'GET', url: '/api/cog/inspect/goals?sessionId=s1', headers: auth });
    expect(ownGoals.statusCode).toBe(200);
    expect(labels(ownGoals)).toEqual(['Owner goal']);
    const allGoals = await fastify.inject({ method: 'GET', url: '/api/cog/inspect/goals?sessionId=s1&scope=all', headers: auth });
    expect(labels(allGoals)).toEqual(['Alice goal', 'Owner goal']);

    // anything but "all" is refused rather than guessed (no user-key scopes over HTTP)
    for (const scope of ['telegram:111', 'owner', '', 'ALL']) {
      const bad = await fastify.inject({ method: 'GET', url: `/api/cog/inspect/episodes?scope=${encodeURIComponent(scope)}`, headers: auth });
      expect(bad.statusCode).toBe(400);
    }
  });
});

describe('/api/cog/inspect/* — gateway without a token requirement', () => {
  it('refuses the inspect routes instead of serving them openly, and does not reach the agent', async () => {
    const cogInspector = vi.fn(async () => undefined);
    const ctx = {
      config: { gateway: { token: 'test-secret', auth: { tokenRequired: false } } },
      agents: new Map([['ontofelia', { cogInspector, cogHealth: async () => ({ ok: true }) }]]),
    };
    const app = Fastify();
    await app.register(adminRoutes, ctx as never);
    for (const headers of [{}, { authorization: 'Bearer test-secret' }]) {
      const res = await app.inject({ method: 'GET', url: '/api/cog/inspect/episodes', headers });
      expect(res.statusCode).toBe(401);
    }
    expect(cogInspector).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'GET', url: '/api/cog/health' })).statusCode).toBe(200);
    await app.close();
  });
});
