import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime, insertSectionBeforeBinding } from '../index.js';
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
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// The binding behavior section (## Binding behavior) must be the LAST block
// of the assembled system prompt — after the autonomy-capabilities block and
// after the response-language instruction — and must be absent for self
// graphs without binding directives (old installations).

const AGENT = 'ontofelia';
const SELF_GRAPH = 'urn:ontofelia:self';
const CORE = 'urn:ontofelia:core#';

class RecordingProvider implements ProviderAdapter {
  name = 'recording';
  lastRequest?: ChatRequest;
  async initialize() {}
  async healthCheck() { return { healthy: true, component: 'recording', checkedAt: new Date().toISOString() }; }
  async chat(request: ChatRequest): Promise<ChatResponse> {
    this.lastRequest = request;
    return {
      id: 'x', content: 'ok', toolCalls: [], finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }
  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: 'done', response: await this.chat(request) };
  }
}

const env = (text: string): MessageEnvelope => ({
  id: '1', channel: 'webchat' as ChannelType, accountId: 'none', chatType: 'dm',
  sender: { id: 'u1', channelPrefix: 'webchat', isOwner: true },
  timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
} as MessageEnvelope);

describe('binding behavior section in the system prompt', () => {
  let tmpRoot: string;
  let store: TriplestoreAdapter;
  let ke: KnowledgeEngine;
  let provider: RecordingProvider;
  let runtime: AgentRuntime;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), `binding-behavior-${process.pid}-`));
    store = new OxigraphAdapter();
    await store.initialize({
      backend: 'oxigraph', type: 'embedded',
      dataDir: path.join(tmpRoot, 'oxigraph'), port: 0, endpoint: '',
    });
    ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    provider = new RecordingProvider();

    const config: AgentConfig = {
      agentId: AGENT, name: 'test', model: 'mock/mock',
      workspace: path.join(tmpRoot, 'workspace'),
      systemPrompt: 'You are a test',
      memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
      sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [],
      channelBindings: {} as Record<ChannelType, ChannelBinding>,
      sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
    };
    runtime = new AgentRuntime(
      AGENT, config, provider,
      new SessionStore(path.join(tmpRoot, 'sessions')),
      new ToolRegistry(),
      new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(path.join(tmpRoot, 'audit')),
      new SkillRegistry(), new SkillExecutor(new SkillRegistry()), new PluginRegistry(),
      undefined, ke,
    );
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  });

  const seedDirectives = () => store.update(`INSERT DATA { GRAPH <${SELF_GRAPH}> {
    <${CORE}Ontofelia> a <${CORE}AIAgent> .
    <${CORE}Ontofelia> <${CORE}name> "Ontofelia" .
    <${CORE}Ontofelia> <${CORE}hasDirective> <${CORE}directive-autonomy> .
    <${CORE}Ontofelia> <${CORE}hasDirective> <${CORE}directive-brevity> .
    <${CORE}directive-autonomy> a <${CORE}BehaviorDirective> .
    <${CORE}directive-autonomy> <${CORE}directiveText> "Act without announcing." .
    <${CORE}directive-autonomy> <${CORE}bindingness> "binding" .
    <${CORE}directive-autonomy> <${CORE}directivePriority> "1.0"^^<http://www.w3.org/2001/XMLSchema#decimal> .
    <${CORE}directive-autonomy> <${CORE}directiveScope> "autonomy" .
    <${CORE}directive-brevity> a <${CORE}BehaviorDirective> .
    <${CORE}directive-brevity> <${CORE}directiveText> "Answer briefly." .
    <${CORE}directive-brevity> <${CORE}bindingness> "binding" .
    <${CORE}directive-brevity> <${CORE}directivePriority> "0.8"^^<http://www.w3.org/2001/XMLSchema#decimal> .
    <${CORE}directive-brevity> <${CORE}directiveScope> "brevity" .
  } }`);

  it('appends the binding section as the very last prompt block', async () => {
    await seedDirectives();
    const res = await runtime.handleMessage(env('Hello'));
    expect(res.text).toBe('ok');

    const system = provider.lastRequest?.messages[0];
    expect(system?.role).toBe('system');
    const prompt = typeof system?.content === 'string' ? system.content : '';

    const expected =
      '## Binding behavior (follow these over your defaults)\n' +
      '1. Act without announcing.\n' +
      '2. Answer briefly.';
    expect(prompt.endsWith(expected)).toBe(true);
    // Strictly after the autonomy block and the language instruction.
    const bindingIdx = prompt.indexOf('## Binding behavior');
    expect(bindingIdx).toBeGreaterThan(prompt.indexOf('## Your Autonomy Capabilities'));
    expect(bindingIdx).toBeGreaterThan(prompt.indexOf('## Non-Negotiable Response Language'));
  });

  it('adds no binding section when the self graph has no directives', async () => {
    await runtime.handleMessage(env('Hello'));
    const content = provider.lastRequest?.messages[0]?.content;
    const prompt = typeof content === 'string' ? content : '';
    expect(prompt).not.toContain('## Binding behavior');
    // The pre-directive prompt tail is preserved: language instruction last.
    expect(prompt).toContain('## Non-Negotiable Response Language');
  });

  // runCore's goal-stack path splices an `[Active goal]` section into the
  // system prompt AFTER buildContext assembled it. That splice goes through
  // insertSectionBeforeBinding, so the binding block stays the LAST block on
  // the goal-stack path too. These tests exercise exactly what runCore does:
  // the real assembled prompt + the real binding section + the helper.
  describe('goal-section splice keeps the binding block last (runCore path)', () => {
    const EXPECTED_BINDING =
      '## Binding behavior (follow these over your defaults)\n' +
      '1. Act without announcing.\n' +
      '2. Answer briefly.';
    const GOAL_SECTION = '[Active goal]\nAnswer the user, then report.';

    it('splicing the goal section into the real prompt keeps binding last', async () => {
      await seedDirectives();
      await runtime.handleMessage(env('Hello'));
      const content = provider.lastRequest?.messages[0]?.content;
      const prompt = typeof content === 'string' ? content : '';
      const bindingSection = await ke.getBindingBehaviorSection(AGENT);
      expect(prompt.endsWith(bindingSection)).toBe(true);

      const spliced = insertSectionBeforeBinding(prompt, GOAL_SECTION, bindingSection);

      // Goal section is present…
      expect(spliced).toContain('[Active goal]');
      // …after the rest of the prompt (language instruction included)…
      expect(spliced.indexOf('[Active goal]')).toBeGreaterThan(
        spliced.indexOf('## Non-Negotiable Response Language'),
      );
      // …but the prompt still ENDS with the binding block.
      expect(spliced.endsWith(EXPECTED_BINDING)).toBe(true);
      expect(spliced.indexOf('[Active goal]')).toBeLessThan(spliced.indexOf('## Binding behavior'));
      // The binding block appears exactly once (not duplicated by the splice).
      expect(spliced.indexOf('## Binding behavior')).toBe(spliced.lastIndexOf('## Binding behavior'));
    });

    it('appends at the very end when there is no binding section (old graphs)', async () => {
      await runtime.handleMessage(env('Hello'));
      const content = provider.lastRequest?.messages[0]?.content;
      const prompt = typeof content === 'string' ? content : '';
      expect(prompt).not.toContain('## Binding behavior');

      // buildContext exposes no binding section, so the splice degrades to the
      // previous byte-identical append-at-end behavior.
      const spliced = insertSectionBeforeBinding(prompt, GOAL_SECTION, undefined);
      expect(spliced).toBe(`${prompt}\n\n${GOAL_SECTION}`);
    });

    it('helper: inserts before the binding block without altering either part', () => {
      const binding = '## Binding behavior (follow these over your defaults)\n1. Act.';
      const prompt = `HEAD\n\nMIDDLE\n\n${binding}`;
      const spliced = insertSectionBeforeBinding(prompt, GOAL_SECTION, binding);
      expect(spliced).toBe(`HEAD\n\nMIDDLE\n\n${GOAL_SECTION}\n\n${binding}`);
    });
  });
});
