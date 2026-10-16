import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
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
import { OxigraphAdapter, KnowledgeEngine, GraphRegistry, ProceduralMemory } from '@ontofelia/semantic-memory';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

// `/cog cycle on|off` is the supported way to switch the cycle manager flag
// (cog.flagCycleManager). It is owner-only AND needs a live human owner turn:
// scheduler / cron envelopes claim isOwner but are not the owner speaking.

const AGENT = 'ontofelia';

const mockConfig: AgentConfig = {
  agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-cogcycle-ws',
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

const NOW = new Date();
const DAY = 86_400_000;
const PROC = `urn:${AGENT}:cog:procedural`;
const COGT = 'urn:shared:ontology#cog/';

describe('/cog cleanup: 90-day procedural trace retention', () => {
  let store: TriplestoreAdapter;
  let runtime: AgentRuntime;
  let cfg: CognitiveConfig;
  let pm: ProceduralMemory;
  let dataDir: string;

  beforeEach(async () => {
    const sid = Math.random().toString(36).slice(2);
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `procret-store-${sid}-`));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    const ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    const sessionStore = new SessionStore(await fs.mkdtemp(path.join(os.tmpdir(), `procret-sess-${sid}-`)));
    runtime = new AgentRuntime(
      AGENT, mockConfig, new StubProvider(), sessionStore,
      new ToolRegistry(), new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(`/tmp/procret-ws-${sid}`), new SkillRegistry(),
      new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined, ke, undefined,
    );
    cfg = new CognitiveConfig(store, AGENT);
    pm = new ProceduralMemory(store, AGENT);
    const at = (days: number) => new Date(NOW.getTime() - days * DAY);
    for (const d of [120, 100, 10, 1]) {
      await pm.recordTrace({
        toolName: 'searchKb', toolArgsHash: 'h', toolArgsBrief: 'q', executedAt: at(d), durationMs: 5,
        outcome: 'success', forGoalType: `${COGT}AnswerQuestion`, sequencePos: 1, forUser: 'owner',
      });
    }
    await pm.consolidate({ since: new Date(0), until: new Date(NOW.getTime() + 1000) });
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  });

  const traces = async () =>
    (await store.query(`SELECT ?t WHERE { GRAPH <${PROC}> { ?t a <${COGT}SkillTrace> } }`)).bindings ?? [];
  const skills = async () =>
    (await store.query(`SELECT ?s ?n WHERE { GRAPH <${PROC}> { ?s a <${COGT}Skill> ; <${COGT}successCount> ?n } }`)).bindings ?? [];

  it('drops traces older than 90 days with procedural memory on, and keeps the skill aggregate', async () => {
    await cfg.setProceduralMemoryEnabled(true);
    const res = await runtime.handleMessage(env('/cog cleanup'));
    expect(res.text).toContain('2 procedural trace(s) older than 90 days dropped');
    expect(await traces()).toHaveLength(2);
    const sk = await skills();
    expect(sk).toHaveLength(1);
    expect(sk[0].n.value).toBe('4');
    // Idempotent.
    const again = await runtime.handleMessage(env('/cog cleanup'));
    expect(again.text).toContain('0 procedural trace(s)');
    expect(await traces()).toHaveLength(2);
  });

  it('touches no trace with procedural memory off, and the reply text is unchanged', async () => {
    const res = await runtime.handleMessage(env('/cog cleanup'));
    expect(res.text).not.toContain('procedural');
    expect(await traces()).toHaveLength(4);
  });
});
