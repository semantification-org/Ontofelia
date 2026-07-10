import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
import type {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, MessageEnvelope,
} from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import { OxigraphAdapter, KnowledgeEngine, GraphRegistry, SelfModel } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// The /reseed-persona slash command re-applies bootstrap/self.ttl to the self
// graph at runtime. It routes through handleMessage → handleCommand and calls
// KnowledgeEngine.reseedSelf, so it runs against the embedded Oxigraph store.

const AGENT = 'ontofelia';
const SELF_GRAPH = 'urn:ontofelia:self';
const CORE = 'urn:ontofelia:core#';

const SELF_V1 = `@prefix onto: <urn:ontofelia:core#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
onto:Ontofelia rdf:type onto:AIAgent .
onto:Ontofelia onto:personality "old vibe" .
`;
const SELF_V2 = `@prefix onto: <urn:ontofelia:core#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
onto:Ontofelia rdf:type onto:AIAgent .
onto:Ontofelia onto:personality "sharpened vibe" .
onto:Ontofelia onto:autonomyRule "act when the task is clear" .
`;

const mockConfig: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-reseed-cmd-ws',
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

const env = (text: string, isOwner: boolean): MessageEnvelope => ({
  id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender: { id: 'u1', channelPrefix: 'webchat', isOwner },
  timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
} as MessageEnvelope);

describe('/reseed-persona command', () => {
  let store: TriplestoreAdapter;
  let ke: KnowledgeEngine;
  let bootstrapDir: string;
  let sessionStore: SessionStore;
  let toolRegistry: ToolRegistry;
  let toolPolicy: ToolPolicyEngine;
  let auditLog: AuditLog;
  let skillRegistry: SkillRegistry;
  let skillExecutor: SkillExecutor;
  let pluginRegistry: PluginRegistry;
  let sid: string;

  beforeEach(async () => {
    sid = Math.random().toString(36).slice(2);
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: `/tmp/reseed-cmd-${sid}`, port: 0, endpoint: '' });
    ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));

    bootstrapDir = await fs.mkdtemp(path.join(os.tmpdir(), 'reseed-cmd-boot-'));
    await fs.writeFile(path.join(bootstrapDir, 'self.ttl'), SELF_V1, 'utf-8');
    await ke.seedCoreGraphs(bootstrapDir, AGENT);
    // A runtime-learned fact that must survive the re-seed.
    await new SelfModel(store, AGENT).seed({ capabilities: [{ id: 'chat', label: 'Chat' }] });
    // Sharpen the on-disk persona; the command should apply exactly this.
    await fs.writeFile(path.join(bootstrapDir, 'self.ttl'), SELF_V2, 'utf-8');

    sessionStore = new SessionStore(`/tmp/reseed-cmd-sessions-${sid}`);
    toolRegistry = new ToolRegistry();
    toolPolicy = new ToolPolicyEngine({ allow: [], deny: [] });
    auditLog = new AuditLog(`/tmp/reseed-cmd-ws-${sid}`);
    skillRegistry = new SkillRegistry();
    pluginRegistry = new PluginRegistry();
    skillExecutor = new SkillExecutor(skillRegistry);
  });

  afterEach(async () => {
    await fs.rm(`/tmp/reseed-cmd-sessions-${sid}`, { recursive: true, force: true }).catch(() => {});
    await fs.rm(bootstrapDir, { recursive: true, force: true }).catch(() => {});
  });

  const makeRuntime = (withKe = true, withDir = true) => new AgentRuntime(
    AGENT, mockConfig, new StubProvider(), sessionStore, toolRegistry, toolPolicy, auditLog,
    skillRegistry, skillExecutor, pluginRegistry, undefined,
    withKe ? ke : undefined, withDir ? bootstrapDir : undefined,
  );

  const ask = (triple: string) => store.ask(`ASK { GRAPH <${SELF_GRAPH}> { ${triple} } }`);

  it('owner: applies the sharpened persona and preserves learned facts', async () => {
    const res = await makeRuntime().handleMessage(env('/reseed-persona', true));

    expect(res.text).toContain('Persona re-seeded');
    // New persona applied, old value gone.
    expect(await ask(`<${CORE}Ontofelia> <${CORE}personality> "sharpened vibe"`)).toBe(true);
    expect(await ask(`<${CORE}Ontofelia> <${CORE}personality> "old vibe"`)).toBe(false);
    expect(await ask(`<${CORE}Ontofelia> <${CORE}autonomyRule> "act when the task is clear"`)).toBe(true);
    // Learned self-model fact still there.
    const view = await new SelfModel(store, AGENT).queryFor();
    expect(view.capabilities.map((c) => c.label)).toContain('Chat');
  });

  it('non-owner: refuses and leaves the persona unchanged', async () => {
    const res = await makeRuntime().handleMessage(env('/reseed-persona', false));

    expect(res.text).toContain('owner-only');
    expect(await ask(`<${CORE}Ontofelia> <${CORE}personality> "old vibe"`)).toBe(true);
    expect(await ask(`<${CORE}Ontofelia> <${CORE}personality> "sharpened vibe"`)).toBe(false);
  });

  it('reports unavailable when no bootstrap path is configured', async () => {
    const res = await makeRuntime(true, false).handleMessage(env('/reseed-persona', true));
    expect(res.text).toContain('unavailable');
    // Nothing changed.
    expect(await ask(`<${CORE}Ontofelia> <${CORE}personality> "old vibe"`)).toBe(true);
  });

  it('lists the command in /help only for the owner', async () => {
    const ownerHelp = await makeRuntime().handleMessage(env('/help', true));
    const guestHelp = await makeRuntime().handleMessage(env('/help', false));
    expect(ownerHelp.text).toContain('/reseed-persona');
    expect(guestHelp.text).not.toContain('/reseed-persona');
  });
});
