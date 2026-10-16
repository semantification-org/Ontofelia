import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
import { CognitiveConfig, COGNITIVE_FLAGS } from '../cognitive/CognitiveConfig.js';
import type {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, MessageEnvelope, TriplestoreAdapter,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import { OxigraphAdapter, KnowledgeEngine, GraphRegistry, EpisodicMemory } from '@ontofelia/semantic-memory';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

// `/cog consolidate-episodes`: episodic to semantic consolidation, owner-only,
// off unless cog.flagEpisodicConsolidation is on (then no read and no write).

const AGENT = 'ontofelia';

const mockConfig: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-consolep-ws',
  systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
  sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
  sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
};

class StubProvider implements ProviderAdapter {
  name = 'stub';
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; }
  async chat(_r: ChatRequest): Promise<ChatResponse> {
    return { id: 'x', content: '', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
  }
  async *chatStream(r: ChatRequest): AsyncIterable<StreamEvent> { yield { type: 'done', response: await this.chat(r) }; }
}

const env = (text: string, over: Partial<MessageEnvelope> & { sender?: MessageEnvelope['sender'] } = {}): MessageEnvelope => ({
  id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender: { id: 'u1', channelPrefix: 'webchat', isOwner: true },
  timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
  ...over,
} as MessageEnvelope);

const CORE = 'urn:shared:ontology#';
const CLAIMS = `urn:${AGENT}:claims`;
const WORLDVIEW = `urn:${AGENT}:worldview`;
const S = 'urn:entity:Anna';
const P = 'urn:core#likes';
const O = 'urn:entity:Tea';
const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T10:00:00.000Z');
const stranger = { id: 'stranger', channelPrefix: 'webchat', isOwner: false };

describe('/cog consolidate-episodes', () => {
  let store: TriplestoreAdapter;
  let runtime: AgentRuntime;
  let cfg: CognitiveConfig;
  let em: EpisodicMemory;
  let dataDir: string;
  let n = 0;

  beforeEach(async () => {
    const sid = Math.random().toString(36).slice(2);
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `consolep-store-${sid}-`));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    const ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    const sessionStore = new SessionStore(await fs.mkdtemp(path.join(os.tmpdir(), `consolep-sess-${sid}-`)));
    runtime = new AgentRuntime(
      AGENT, mockConfig, new StubProvider(), sessionStore,
      new ToolRegistry(), new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(`/tmp/consolep-ws-${sid}`), new SkillRegistry(),
      new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined, ke, undefined,
    );
    cfg = new CognitiveConfig(store, AGENT);
    em = new EpisodicMemory(store, AGENT);
    // Three sessions of user "anna" assert the same triple.
    for (let i = 0; i < 3; i++) {
      const claim = `urn:claim:cmd_${++n}`;
      await store.update(`INSERT DATA { GRAPH <${CLAIMS}> {
        <${claim}> a <${CORE}Claim> ; <${CORE}claimSubject> <${S}> ; <${CORE}claimPredicate> <${P}> ;
          <${CORE}claimObject> <${O}> ; <${CORE}status> "accepted" ; <${CORE}assertedInGraph> <${WORLDVIEW}> ;
          <${CORE}sourceKind> "user" . } }`);
      await em.append({
        episodeType: 'message-received', forUser: 'anna', sessionId: `cmd${i}`,
        occurredAt: new Date(T0 + i * DAY), hasClaim: [claim], factGraph: `urn:${AGENT}:user:anna`,
      });
    }
  });

  afterEach(async () => {
    await runtime.flushCognitiveWrites();
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  const quads = async () => ((await store.query('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }')).bindings ?? []).length;
  const promoted = async () =>
    ((await store.query(`SELECT ?g WHERE { GRAPH ?g { <${S}> <${P}> <${O}> } }`)).bindings ?? []).map((b) => b.g.value);

  it('is off by default: it says so and reads and writes nothing', async () => {
    const before = await quads();
    const res = await runtime.handleMessage(env('/cog consolidate-episodes'));
    expect(res.text).toBe(
      'Episodic consolidation is off (flagEpisodicConsolidation). Nothing was read or changed. Enable with /cog flag episodicconsolidation on.',
    );
    expect(await quads()).toBe(before);
    expect(await promoted()).toEqual([]);
  });

  it('with the flag on it promotes into the user graph only, and a rerun changes nothing', async () => {
    await cfg.setEnabled({ name: 'flagEpisodicConsolidation', key: 'episodicConsolidation', description: '' }, true);
    const res = await runtime.handleMessage(env('/cog consolidate-episodes'));
    expect(res.text).toContain('1 qualified, 1 promoted');
    expect(await promoted()).toEqual([`urn:${AGENT}:user:anna`]);
    const after = await quads();
    const again = await runtime.handleMessage(env('/cog consolidate-episodes'));
    expect(again.text).toContain('0 promoted');
    expect(await quads()).toBe(after);
  });

  it('honours K and Q from the setup graph', async () => {
    await cfg.setEnabled({ name: 'flagEpisodicConsolidation', key: 'episodicConsolidation', description: '' }, true);
    const setup = `urn:${AGENT}:setup`;
    await store.update(`INSERT DATA { GRAPH <${setup}> { <urn:${AGENT}:setup:cognitive> <urn:shared:ontology#cog/consolidationMinEpisodes> "4"^^<http://www.w3.org/2001/XMLSchema#integer> } }`);
    expect(await cfg.consolidationSettings()).toEqual({ minEpisodes: 4, minGroups: 2 });
    const res = await runtime.handleMessage(env('/cog consolidate-episodes'));
    expect(res.text).toContain('0 qualified');
  });

  it('is owner-only and changes nothing for a non-owner', async () => {
    await cfg.setEnabled({ name: 'flagEpisodicConsolidation', key: 'episodicConsolidation', description: '' }, true);
    const before = await quads();
    const res = await runtime.handleMessage(env('/cog consolidate-episodes', { sender: stranger }));
    expect(res.text).toBe('This command is owner-only.');
    expect(await quads()).toBe(before);
  });

  it('the flag is on the /cog flag allowlist and defaults to off', async () => {
    expect(COGNITIVE_FLAGS.map((f) => f.name)).toContain('flagEpisodicConsolidation');
    expect(await cfg.isFlagEnabledByName('flagEpisodicConsolidation')).toBe(false);
    const res = await runtime.handleMessage(env('/cog flag episodicconsolidation on'));
    expect(res.text).toBe('⚙️ flagEpisodicConsolidation = true.');
    expect(await cfg.isFlagEnabledByName('flagEpisodicConsolidation')).toBe(true);
  });
});
