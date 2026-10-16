import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { startGateway } from '../../index.js';
import { getDefaultConfig } from '@ontofelia/config';
import { AgentRuntime } from '@ontofelia/agent-runtime';
import type { TriplestoreAdapter, MessageEnvelope, ChannelType } from '@ontofelia/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { seedExistingInstall } from './existingInstall.js';

// The HTTP reseed (which the CLI command calls) re-derives the self-model like
// /reseed-persona does: with the self-model flag on, after the persona, and a
// tool that left the registry disappears from it. Tools the gateway registers
// after the runtime started (notify_owner, arm_goal, ...) are in it too.

const COGT = 'urn:shared:ontology#cog/';
const auth = { authorization: 'Bearer test-secret' };
const owner: MessageEnvelope = {
  id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender: { id: 'owner', channelPrefix: 'webchat', isOwner: true },
  timestamp: new Date().toISOString(), text: '', mentions: [], attachments: [],
} as MessageEnvelope;

describe('POST /api/ontology/reseed-self and the derived self-model', () => {
  let fastify: FastifyInstance;
  let agent: AgentRuntime | undefined;
  const realHome = process.env.HOME;
  let tmpHome: string;

  beforeAll(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'reseed-self-'));
    process.env.HOME = tmpHome;
    seedExistingInstall(tmpHome); // an existing install: nothing of the new-install defaults applies
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
    const original = AgentRuntime.prototype.setStateDir;
    vi.spyOn(AgentRuntime.prototype, 'setStateDir').mockImplementation(function (this: AgentRuntime, dir: string) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- capture the runtime instance
      agent = this;
      return original.call(this, dir);
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
    await agent?.flushCognitiveWrites();
    process.env.HOME = realHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  const reseed = () => fastify.inject({ method: 'POST', url: '/api/ontology/reseed-self', headers: auth });
  const toolNames = async (): Promise<string[]> => {
    const store = (agent as unknown as { knowledgeEngine: { triplestore: TriplestoreAdapter } }).knowledgeEngine.triplestore;
    const res = await store.query(`SELECT ?req WHERE { GRAPH <urn:ontofelia:self> {
      ?cap <${COGT}derivedFrom> "tool-registry" ; <${COGT}requires> ?req } }`);
    return (res.bindings ?? []).map((b) => b.req.value);
  };

  it('with the self-model flag off the response is what it was and nothing is derived', async () => {
    expect(agent).toBeDefined();
    const res = await reseed();
    expect(res.statusCode).toBe(200);
    expect(res.json().selfModel).toBeUndefined();
    expect(res.json().selfModelError).toBeUndefined();
    expect(typeof res.json().bootstrapAfter).toBe('number');
    expect(await toolNames()).toEqual([]);
  });

  it('with the flag on it re-derives, late tools included, and a removed tool disappears', async () => {
    const flag = await agent!.handleMessage({ ...owner, text: '/cog flag selfModelQuery on' });
    expect(flag.text).toContain('flagSelfModelQuery = true');
    const first = await reseed();
    expect(first.statusCode).toBe(200);
    expect(first.json().selfModel.capabilities).toBeGreaterThan(0);
    expect(await toolNames()).toContain('notify_owner'); // registered after the runtime was initialised

    // Remove a tool from the live registry (test-only: the registry has no unregister).
    const registry = (agent as unknown as { toolRegistry: { tools: Map<string, unknown> } }).toolRegistry;
    expect(registry.tools.delete('notify_owner')).toBe(true);
    const second = await reseed();
    expect(second.statusCode).toBe(200);
    expect(await toolNames()).not.toContain('notify_owner');
    expect(await toolNames()).toContain('list_goals');
  });
});
