import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
import { CycleManager } from '../cognitive/CycleManager.js';
import { CognitiveConfig } from '../cognitive/CognitiveConfig.js';
import type {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, MessageEnvelope, TriplestoreAdapter,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import { OxigraphAdapter, KnowledgeEngine, GraphRegistry } from '@ontofelia/semantic-memory';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

// End to end through the real ingestion path with a scripted parser: a fact the
// owner states in three independent sessions is stored once, the two later
// statements re-assert the same claim, the episodes link it, and the
// consolidation promotes it exactly once into the owner's own graph. Episodic
// memory off: a restatement is skipped as before and nothing is linked.

const AGENT = 'ontofelia';
const CORE = 'urn:shared:ontology#';
const COGT = 'urn:shared:ontology#cog/';
const CLAIMS = `urn:${AGENT}:claims`;
const WORLDVIEW = `urn:${AGENT}:worldview`;
const OWNER = { id: 'owner', channelPrefix: 'webchat', isOwner: true };
const USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const TEXT = 'Anna works at Acme';
const PARSED = JSON.stringify({
  facts: [{ subject: 'Anna', subjectType: 'Person', predicate: 'worksAt', object: 'Acme', objectType: 'Organization', confidence: 'high', sourceSpan: TEXT, kind: 'fact' }],
  proposals: [], confidence: 'high',
});

class MockProvider implements ProviderAdapter {
  name = 'stub';
  constructor(private readonly parsed = PARSED) {}
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; }
  async chat(r: ChatRequest): Promise<ChatResponse> {
    return { id: 'x', content: r.tools ? 'Noted.' : this.parsed, finishReason: 'stop', toolCalls: [], usage: USAGE };
  }
  async *chatStream(r: ChatRequest): AsyncIterable<StreamEvent> { yield { type: 'done', response: await this.chat(r) } as StreamEvent; }
}

const config: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-reassert-ws',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  // One session per channel: three channels are three independent sessions.
  sessionPolicy: { scope: 'per-channel-peer' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
};

const CHANNELS = ['webchat', 'telegram', 'discord'] as ChannelType[];
const envelope = (channel: ChannelType, sender: MessageEnvelope['sender'] = OWNER): MessageEnvelope => ({
  id: `m-${channel}`, channel, accountId: 'none', chatType: 'dm',
  sender, timestamp: new Date().toISOString(), text: TEXT, mentions: [], attachments: [],
} as MessageEnvelope);

const rows = async (store: TriplestoreAdapter, q: string) => (await store.query(q)).bindings ?? [];

describe('a restated fact through the real ingestion path', () => {
  let store: TriplestoreAdapter;
  let runtime: AgentRuntime;
  let cfg: CognitiveConfig;
  let ke: KnowledgeEngine;
  let dirs: string[];

  async function setup(episodic: boolean, parsed = PARSED) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reassert-store-'));
    const sessDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reassert-sess-'));
    dirs = [dir, sessDir];
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
    ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    cfg = new CognitiveConfig(store, AGENT);
    await cfg.setCycleManagerEnabled(true);
    await cfg.setEpisodicMemoryEnabled(episodic);
    await cfg.setEnabled({ name: 'flagEpisodicConsolidation', key: 'episodicConsolidation', description: '' }, true);
    runtime = new AgentRuntime(
      AGENT, config, new MockProvider(parsed), new SessionStore(sessDir),
      new ToolRegistry(), new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(`/tmp/reassert-ws-${Math.random().toString(36).slice(2)}`), new SkillRegistry(),
      new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined, ke, undefined,
    );
  }

  const flush = async () => {
    await (runtime as unknown as { cycleManager?: CycleManager }).cycleManager?.flushPending();
    await runtime.flushCognitiveWrites();
  };
  async function sayThrice(channels: ChannelType[] = CHANNELS, sender: MessageEnvelope['sender'] = OWNER) {
    for (const ch of channels) {
      await runtime.handleMessage(envelope(ch, sender));
      await flush();
    }
  }
  const quads = async () => (await rows(store, 'SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }')).length;
  const claimsOfFact = async () =>
    rows(store, `SELECT ?c WHERE { GRAPH <${CLAIMS}> { ?c a <${CORE}Claim> ; <${CORE}claimObject> ?o ; <${CORE}claimPredicate> ?p . FILTER (CONTAINS(STR(?o), "Acme")) } }`);
  const episodeClaims = async () =>
    rows(store, `SELECT ?ep ?c WHERE { GRAPH ?g { ?ep a <${COGT}Episode> ; <${COGT}episodeType> "message-received" ; <${COGT}hasClaim> ?c } }`);
  const holders = async () =>
    (await rows(store, `SELECT DISTINCT ?g WHERE { GRAPH ?g { ?s ?p <urn:ontofelia:entity:Acme> . FILTER (CONTAINS(STR(?s), "Anna")) } }`)).map((b) => b.g.value).sort();

  beforeEach(() => { dirs = []; });
  afterEach(async () => {
    await flush().catch(() => {});
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  });

  it('three independent sessions: one claim, three episodes link it, promoted exactly once, a rerun is a no-op', async () => {
    await setup(true);
    await sayThrice();

    // One stored claim, restated twice: evidence added, no second claim.
    const claims = await claimsOfFact();
    expect(claims).toHaveLength(1);
    const ev = await rows(store, `SELECT ?e WHERE { GRAPH <${CLAIMS}> { <${claims[0].c.value}> <${CORE}hasEvidence> ?e } }`);
    expect(ev).toHaveLength(3);
    const links = await episodeClaims();
    expect(links).toHaveLength(3);
    expect(new Set(links.map((l) => l.c.value))).toEqual(new Set([claims[0].c.value]));
    expect(new Set(links.map((l) => l.ep.value)).size).toBe(3);
    expect(await holders()).toEqual([WORLDVIEW]);

    const first = await runtime.runEpisodicConsolidation();
    expect(first.report?.qualified).toBe(1);
    expect(first.report?.promoted).toBe(1);
    expect(await holders()).toEqual([`urn:${AGENT}:user:owner`, WORLDVIEW]);
    const promoted = await rows(store, `SELECT ?c WHERE { GRAPH <${CLAIMS}> { ?c <${CORE}sourceKind> "consolidation-episodic" ; <${CORE}status> "accepted" } }`);
    expect(promoted).toHaveLength(1);

    const before = await quads();
    const again = await runtime.runEpisodicConsolidation();
    expect(again.report?.promoted).toBe(0);
    expect(again.report?.alreadyPromoted).toBe(1);
    expect(await quads()).toBe(before);
  });

  it('episodic memory off: a restatement is skipped as before, no evidence, no link, nothing to promote', async () => {
    await setup(false);
    await sayThrice();
    const claims = await claimsOfFact();
    expect(claims).toHaveLength(1);
    const ev = await rows(store, `SELECT ?e WHERE { GRAPH <${CLAIMS}> { <${claims[0].c.value}> <${CORE}hasEvidence> ?e } }`);
    expect(ev).toHaveLength(1);
    expect(await episodeClaims()).toHaveLength(0);
    const r = await runtime.runEpisodicConsolidation();
    expect(r.report?.promoted).toBe(0);
    expect(await holders()).toEqual([WORLDVIEW]);
  });

  it('three restatements in ONE session on one day do not promote (one evidence group)', async () => {
    await setup(true);
    await sayThrice(['webchat', 'webchat', 'webchat']);
    // The restatements are linked as before: three episodes, one claim.
    expect(await episodeClaims()).toHaveLength(3);
    const r = await runtime.runEpisodicConsolidation();
    expect(r.report?.qualified).toBe(0);
    expect(r.report?.promoted).toBe(0);
    expect(await holders()).toEqual([WORLDVIEW]);
  });

  it('an owner whose sender id is not "owner": own facts, promotion and cascade key all use user:<id>, nothing in user:owner', async () => {
    await setup(true);
    const sender = { id: 'u-7', channelPrefix: 'webchat', isOwner: true };
    await sayThrice(CHANNELS, sender);
    const graphHas = (g: string, needle: string) =>
      rows(store, `SELECT ?o WHERE { GRAPH <urn:${AGENT}:${g}> { ?s ?p ?o . FILTER (CONTAINS(STR(?o), "${needle}")) } }`).then((r) => r.length > 0);
    // The owner's own fact goes where the ingestion routes by sender id.
    await ke.storeFact(
      { subject: 'User', predicate: 'likes', object: 'Tea', objectType: 'literal', confidenceLabel: 'high', status: 'accepted' },
      { agentId: AGENT, userId: sender.id, sessionId: 'x', isOwner: true },
    );
    expect(await graphHas('user:u-7', 'Tea')).toBe(true);
    expect(await graphHas('user:owner', 'Tea')).toBe(false);
    expect(await graphHas('user:u-7', 'Acme')).toBe(false);

    const r = await runtime.runEpisodicConsolidation();
    expect(r.report?.promoted).toBe(1);
    expect(await graphHas('user:u-7', 'Acme')).toBe(true);
    const inOwner = await rows(store, `SELECT ?s WHERE { GRAPH <urn:${AGENT}:user:owner> { ?s ?p ?o } } LIMIT 1`);
    expect(inOwner).toEqual([]);
    // The episodes keep the cognitive key for scoping and name the fact graph.
    const eps = await rows(store, `SELECT ?u ?g WHERE { GRAPH ?x { ?ep a <${COGT}Episode> ; <${COGT}episodeType> "message-received" ; <${COGT}forUser> ?u ; <${COGT}factGraph> ?g } }`);
    expect(eps).toHaveLength(3);
    expect(new Set(eps.map((e) => `${e.u.value} ${e.g.value}`))).toEqual(new Set([`owner urn:${AGENT}:user:u-7`]));
  });
});
