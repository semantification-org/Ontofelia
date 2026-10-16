import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { startGateway } from '../../index.js';
import { getDefaultConfig } from '@ontofelia/config';
import { AgentRuntime } from '@ontofelia/agent-runtime';
import { EpisodicMemory } from '@ontofelia/semantic-memory';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { seedExistingInstall } from './existingInstall.js';

const auth = { authorization: 'Bearer test-secret' };
const URL = '/api/cog/inspect/initiative';

describe('GET /api/cog/inspect/initiative', () => {
  let fastify: FastifyInstance;
  let agent: AgentRuntime | undefined;
  const realHome = process.env.HOME;
  let tmpHome: string;

  beforeAll(async () => {
    // Embedded Oxigraph (real SPARQL; the 'memory' backend is a stub) keeps its
    // data under $HOME/.ontofelia, so point HOME at a throwaway directory.
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cog-initiative-'));
    process.env.HOME = tmpHome;
    seedExistingInstall(tmpHome); // an existing install: nothing of the new-install defaults applies
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
    // Capture the gateway's runtime on the first inspector gate check, so the
    // test can seed the very store the route reads from.
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

  it('rejects requests without a token', async () => {
    const res = await fastify.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(401);
  });

  it('is 403 while the debug panel is disabled', async () => {
    const res = await fastify.inject({ method: 'GET', url: URL, headers: auth });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Cognitive debug panel disabled' });
  });

  it('returns exactly the runtime initiativeReport once the panel is enabled', async () => {
    expect(agent).toBeDefined();
    const rt = agent!;
    const store = rt['knowledgeEngine']!['triplestore'];
    const actor = 'urn:ontofelia:self#ontofelia';
    const em = new EpisodicMemory(store, 'ontofelia');
    const now = Date.now();
    await em.append({
      episodeType: 'initiative', occurredAt: new Date(now - 600_000), actor, outcome: 'success',
      payload: 'initiative skipped for goal "Write weekly report": within per-goal cooldown (30 min)',
    });
    await em.append({
      episodeType: 'notification', occurredAt: new Date(now - 300_000), actor, outcome: 'success',
      payload: JSON.stringify({ priority: 'high', reason: 'sent' }),
    });
    await em.append({
      episodeType: 'notification', occurredAt: new Date(now - 120_000), actor, outcome: 'success',
      payload: JSON.stringify({ priority: 'low', reason: 'daily-cap' }),
    });
    await rt['cognitiveConfig']!.setDebugPanelEnabled(true);

    const res = await fastify.inject({ method: 'GET', url: URL, headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual(JSON.parse(JSON.stringify(await rt.initiativeReport())));
    expect(body.episodes).toHaveLength(1);
    expect(body.episodes[0].why).toContain('within per-goal cooldown');
    expect(body.notifications.map((n: { delivered: boolean; reason: string }) => [n.delivered, n.reason]))
      .toEqual([[false, 'daily-cap'], [true, 'sent']]);
    expect(body.enabled).toBe(false);
    expect(body.counters).toEqual({ inHour: 0, maxPerHour: 4, inDay: 0, maxPerDay: expect.any(Number) });
  });
});
