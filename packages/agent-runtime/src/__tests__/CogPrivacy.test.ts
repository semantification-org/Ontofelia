import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AgentRuntime } from '../index.js';
import { CycleManager } from '../cognitive/CycleManager.js';
import { CognitiveConfig } from '../cognitive/CognitiveConfig.js';
import { GoalStack, goalBelongsTo } from '../cognitive/GoalStack.js';
import { CogInspector } from '../cognitive/CogInspector.js';
import { looksLikeSecret } from '../cognitive/privacyClass.js';
import type {
  AgentConfig, ProviderAdapter, ChatRequest, ChatResponse, StreamEvent,
  ChannelType, ChannelBinding, MessageEnvelope, TriplestoreAdapter,
} from '@ontofelia/core';
import { cogUserKey } from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import {
  OxigraphAdapter, KnowledgeEngine, GraphRegistry, GraphUriResolver, EpisodicMemory,
} from '@ontofelia/semantic-memory';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';

// Per-user privacy of the cognitive layer: with the cycle, episodic and goal
// flags on, one user never reaches another user's episodes, working memory,
// goals or the owner's armed goal; the owner reaches all of it with scope
// "all"; with every flag off nothing is written.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const CORE = 'urn:shared:ontology#';

const OWNER = { id: 'owner', channelPrefix: 'telegram', isOwner: true };
const ALICE = { id: 'telegram:111', channelPrefix: 'telegram', isOwner: false };
const BOB = { id: 'telegram:222', channelPrefix: 'telegram', isOwner: false };

const envelope = (
  sender: MessageEnvelope['sender'],
  text: string,
  over: Partial<MessageEnvelope> = {},
): MessageEnvelope => ({
  id: 'm1', channel: 'webchat' as ChannelType, accountId: 'acc', chatType: 'dm',
  sender, timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
  ...over,
} as MessageEnvelope);

async function makeStore(): Promise<{ store: TriplestoreAdapter; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cogpriv-store-'));
  const store = new OxigraphAdapter();
  await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
  return { store, dir };
}

const count = async (store: TriplestoreAdapter, type: string) =>
  ((await store.query(`SELECT ?s WHERE { GRAPH ?g { ?s a <${type}> } }`)).bindings ?? []).length;

describe('cognitive per-user privacy (cycle manager level)', () => {
  let store: TriplestoreAdapter;
  let dir: string;
  let registry: GraphRegistry;
  let cm: CycleManager;
  let errors: unknown[];
  let em: EpisodicMemory;
  const ALL_ON = { goalsEnabled: true, episodicEnabled: true } as const;

  beforeEach(async () => {
    ({ store, dir } = await makeStore());
    registry = GraphRegistry.create([AGENT]);
    errors = [];
    cm = new CycleManager(store, registry, AGENT, (e) => errors.push(e), { awaitPersist: true });
    em = new EpisodicMemory(store, AGENT);
  });
  afterEach(async () => {
    await cm.flushPending();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  /** One turn; returns the `[Active goal]` prompt block the core would receive. */
  async function turn(sender: MessageEnvelope['sender'], text: string, session: string, over = {}) {
    let block: string | undefined;
    await cm.runCycle(
      envelope(sender, text),
      async (_rec, prepareGoals, recordInbound) => {
        block = await prepareGoals(session);
        await recordInbound(session);
        return { text: `reply to ${text}`, sessionId: session };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { ...ALL_ON, ...over },
    );
    return block;
  }

  /** A long-term goal owned by `owner`, as arm_goal / session migration leave it. */
  async function longTermGoal(owner: string, label: string, priority: number, viewerOwner = false) {
    const gs = new GoalStack(store, registry, AGENT, `seed-${owner.replace(/\W/g, "_")}`, undefined, { userId: owner, isOwner: viewerOwner });
    const uri = await gs.push({ goalType: `${COGT}OwnerRequestedWork`, goalLabel: label, priority, longTerm: true });
    await gs.promoteToLongterm(uri);
    return uri;
  }

  it('stamps every episode, working-memory entry, cycle and goal with the sender key', async () => {
    await turn(ALICE, 'what is oxigraph?', 'sA');
    await turn(OWNER, 'hello', 'sO');
    expect(errors).toEqual([]);

    const keyed = async (type: string, key: string) =>
      ((await store.query(
        `SELECT ?s WHERE { GRAPH ?g { ?s a <${type}> ; <${COGT}forUser> "${key}" } }`,
      )).bindings ?? []).length;

    for (const type of [`${COGT}Episode`, `${COGT}WorkingMemoryEntry`, `${COGT}Cycle`, `${COGT}Goal`]) {
      const total = await count(store, type);
      expect(total).toBeGreaterThan(0);
      expect((await keyed(type, 'telegram:111')) + (await keyed(type, 'owner'))).toBe(total);
    }
    expect(await keyed(`${COGT}Cycle`, 'telegram:111')).toBe(1);
    expect(await keyed(`${COGT}Cycle`, 'owner')).toBe(1);
    // the question became a goal of the asker
    const goals = await new GoalStack(store, registry, AGENT, 'sA').list();
    expect(goals.find((g) => g.goalLabel.startsWith('Answer:'))?.forUser).toBe('telegram:111');
  });

  it('B never sees A\'s episodes or WM entries; the owner sees all with scope "all"', async () => {
    await turn(ALICE, 'my secret plan is the orange pumpkin', 'shared');
    await turn(BOB, 'what plan do you know about pumpkin', 'shared');
    await turn(OWNER, 'owner note about the plan', 'shared');
    expect(errors).toEqual([]);

    const bobEps = await em.recent('telegram:222', 100);
    expect(bobEps.length).toBeGreaterThan(0);
    expect(bobEps.every((e) => e.forUser === 'telegram:222')).toBe(true);
    expect(bobEps.some((e) => (e.payload ?? '').includes('orange pumpkin'))).toBe(false);
    for (const hit of [
      ...(await em.retrieve('orange pumpkin plan', 50, 'telegram:222')),
      ...(await em.retrieve('orange pumpkin plan', 50, 'telegram:222', { sessionId: 'shared' })),
      ...(await em.findInSession('shared', 'telegram:222')),
      ...(await em.recent('telegram:222', 100)),
    ]) {
      expect(hit.forUser).toBe('telegram:222');
    }
    const lastBob = bobEps[0];
    expect((await em.chainFrom(lastBob.uri, 'telegram:222')).every((e) => e.forUser === 'telegram:222')).toBe(true);

    // B's retrieval buffer holds only B's episodes: no WM entry mentioning
    // A's text is keyed to B, and every such entry is A's.
    const wm = await store.query(`
      SELECT ?p ?u WHERE { GRAPH ?g { ?e a <${COGT}WorkingMemoryEntry> ; <${COGT}payload> ?p ; <${COGT}forUser> ?u } }`);
    const aText = (wm.bindings ?? []).filter((b) => b.p.value.includes('orange pumpkin'));
    expect(aText.length).toBeGreaterThan(0);
    expect(aText.every((b) => b.u.value === 'telegram:111')).toBe(true);

    // The owner reaches everything only with the explicit "all" scope.
    const all = await em.recent('all', 100);
    expect(new Set(all.map((e) => e.forUser))).toEqual(new Set(['telegram:111', 'telegram:222', 'owner']));
    expect((await em.recent('owner', 100)).every((e) => e.forUser === 'owner')).toBe(true);
  });

  it('B never sees A\'s goals or the owner\'s armed goal in the prompt; the owner sees them', async () => {
    const ownerGoal = await longTermGoal('owner', 'Prepare the quarterly secret report', 0.95, true);
    const aliceGoal = await longTermGoal('telegram:111', 'Alice private errand', 0.9);

    const forBob = await turn(BOB, 'hello there', 'sB');
    expect(forBob).toBeDefined();
    expect(forBob).not.toContain('quarterly secret report');
    expect(forBob).not.toContain('Alice private errand');

    const forAlice = await turn(ALICE, 'hello again', 'sA2');
    expect(forAlice).toContain('Alice private errand');
    expect(forAlice).not.toContain('quarterly secret report');

    const forOwner = await turn(OWNER, 'hello boss', 'sO2');
    expect(forOwner).toContain('quarterly secret report');

    // Bob's stack ignores the long-term pool that is not his, in every read.
    const bobStack = new GoalStack(store, registry, AGENT, 'sB', undefined, { userId: 'telegram:222', isOwner: false });
    const labels = (await bobStack.list()).map((g) => g.goalLabel);
    expect(labels).not.toContain('Prepare the quarterly secret report');
    expect(labels).not.toContain('Alice private errand');
    expect(await bobStack.get(ownerGoal)).toBeUndefined();
    expect(await bobStack.get(aliceGoal)).toBeUndefined();
    expect((await bobStack.active()).every((g) => g.forUser === 'telegram:222' || g.goalType.endsWith('RespondToUser'))).toBe(true);
  });

  it('a goal armed by the owner belongs to the owner, and /new does not move goals into another user\'s view', async () => {
    // a user-owned session goal migrated to the shared long-term graph keeps its owner
    const bobStack = new GoalStack(store, registry, AGENT, 'sBmig', undefined, { userId: 'telegram:222', isOwner: false });
    const uri = await bobStack.push({ goalType: `${COGT}AnswerQuestion`, goalLabel: 'Bob durable errand', priority: 0.8, longTerm: true });
    await bobStack.migrateLongterm();
    const aliceStack = new GoalStack(store, registry, AGENT, 'sAmig', undefined, { userId: 'telegram:111', isOwner: false });
    expect(await aliceStack.get(uri)).toBeUndefined();
    expect((await aliceStack.active()).map((g) => g.goalLabel)).not.toContain('Bob durable errand');
    expect((await bobStack.get(uri))?.forUser).toBe('telegram:222');
    const system = new GoalStack(store, registry, AGENT, 'sys');
    expect((await system.get(uri))?.graph).toBe(system.longtermGraphUri());

    // a legacy goal (no forUser) migrated by Bob's /new is stamped with Bob's key,
    // and a legacy owner-less long-term goal is invisible to non-owners
    const legacy = new GoalStack(store, registry, AGENT, 'sLegacy');
    const legacyUri = await legacy.push({ goalType: `${COGT}AnswerQuestion`, goalLabel: 'Legacy goal', priority: 0.7, longTerm: true });
    await store.update(`DELETE WHERE { GRAPH <${legacy.sessionGraphUri()}> { <${legacyUri}> <${COGT}forUser> ?o } }`);
    expect((await legacy.get(legacyUri))?.forUser).toBeUndefined();
    await legacy.promoteToLongterm(legacyUri);
    expect((await legacy.get(legacyUri))?.forUser).toBeUndefined();
    expect(await aliceStack.get(legacyUri)).toBeUndefined();
    expect(goalBelongsTo((await legacy.get(legacyUri))!, 'owner')).toBe(true);
    expect(goalBelongsTo((await legacy.get(legacyUri))!, 'telegram:111')).toBe(false);

    const legacy2 = new GoalStack(store, registry, AGENT, 'sLegacy2', undefined, { userId: 'telegram:222', isOwner: false });
    const l2 = await legacy2.push({ goalType: `${COGT}AnswerQuestion`, goalLabel: 'Legacy goal two', priority: 0.7, longTerm: true });
    await store.update(`DELETE WHERE { GRAPH <${legacy2.sessionGraphUri()}> { <${l2}> <${COGT}forUser> ?o } }`);
    await legacy2.promoteToLongterm(l2);
    expect((await legacy2.get(l2))?.forUser).toBe('telegram:222');
  });

  it('initiative cycles record episodes under the owner\'s key', async () => {
    const gs = new GoalStack(store, registry, AGENT, 'sI');
    const goalUri = await gs.push({ goalType: `${COGT}OwnerRequestedWork`, goalLabel: 'Initiative goal', priority: 0.6, forUser: 'owner' });
    await cm.runCycle(
      envelope({ id: 'initiative', channelPrefix: 'system', isOwner: true }, 'Initiative wake', {
        channel: 'system' as ChannelType, chatType: 'initiative' as MessageEnvelope['chatType'],
        routingHints: { sessionId: 'sI', initiativeGoalId: goalUri },
      }),
      async (_rec, prepareGoals) => {
        await prepareGoals('sI');
        return { text: 'done', sessionId: 'sI' };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { ...ALL_ON, mode: 'initiative', initiativeGoalUri: goalUri },
    );
    const initiative = (await em.recent('all', 50)).filter((e) => e.episodeType === 'initiative');
    expect(initiative).toHaveLength(1);
    expect(initiative[0].forUser).toBe('owner');
    expect(await em.recent('telegram:111')).toEqual([]);
  });

  it('classifies an episode whose payload matches a secret shape as core:privacyClass "secret"', async () => {
    await turn(ALICE, 'my password: hunter2hunter2 please remember', 'sS');
    await turn(ALICE, 'what is the weather', 'sS');
    const rows = await store.query(`
      SELECT ?p ?c WHERE { GRAPH ?g { ?e a <${COGT}Episode> ; <${COGT}payload> ?p . OPTIONAL { ?e <${CORE}privacyClass> ?c } } }`);
    const byPayload = new Map((rows.bindings ?? []).map((b) => [b.p.value, b.c?.value]));
    expect(byPayload.get('my password: hunter2hunter2 please remember')).toBe('secret');
    expect(byPayload.get('what is the weather')).toBeUndefined();
    expect(looksLikeSecret('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(looksLikeSecret('Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123')).toBe(true);
    expect(looksLikeSecret('the secret of good soup is time')).toBe(false);
  });

  it('survives a hostile sender id and message text: no SPARQL error, no leak', async () => {
    const evil = { id: 'u" . } } ; DROP ALL #\\\n', channelPrefix: 'telegram', isOwner: false };
    const text = 'Is "this" a \\ test? \\" \\\\n\n"} } DELETE WHERE { ?s ?p ?o } # \t?';
    expect(cogUserKey(evil)).toBe(evil.id);

    await longTermGoal('owner', 'Owner confidential goal', 0.99, true);
    await turn(BOB, 'bob plain note', 'sBob');
    const block = await turn(evil, text, 'sEvil');
    expect(errors).toEqual([]);
    expect(block).not.toContain('Owner confidential goal');

    const mine = await em.recent(evil.id, 100);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((e) => e.forUser === evil.id)).toBe(true);
    expect(mine.map((e) => e.payload)).toContain(text);
    expect((await em.recent('telegram:222', 100)).some((e) => e.payload === text)).toBe(false);
    expect((await em.recent(evil.id, 100)).some((e) => (e.payload ?? '').includes('bob plain note'))).toBe(false);

    const evilGoals = new GoalStack(store, registry, AGENT, 'sEvil', undefined, { userId: evil.id, isOwner: false });
    const own = await evilGoals.list();
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((g) => g.forUser === evil.id || g.goalType.endsWith('RespondToUser'))).toBe(true);
    // the store still holds the owner's data
    expect(await count(store, `${COGT}Goal`)).toBeGreaterThan(2);
  });

  it('the inspector returns only the scoped user\'s records; "all" returns every record', async () => {
    await turn(ALICE, 'what is alice asking?', 'sA');
    await turn(OWNER, 'owner note', 'sA');
    await longTermGoal('telegram:111', 'Alice goal', 0.5);
    await longTermGoal('owner', 'Owner goal', 0.5, true);
    const ins = new CogInspector(store, registry, AGENT);

    const owner = await ins.listEpisodes('owner');
    expect(owner.length).toBeGreaterThan(0);
    expect(owner.every((e) => e.forUser === 'owner')).toBe(true);
    expect((await ins.listEpisodes('all')).length).toBeGreaterThan(owner.length);
    expect((await ins.listEpisodes('telegram:222'))).toEqual([]);

    const ownerGoals = (await ins.listGoals('sA', 'owner')).map((g) => g.goalLabel);
    expect(ownerGoals).toContain('Owner goal');
    expect(ownerGoals).not.toContain('Alice goal');
    expect((await ins.listGoals('sA', 'all')).map((g) => g.goalLabel)).toEqual(expect.arrayContaining(['Owner goal', 'Alice goal']));

    const cyclesOwner = await ins.listCycles('sA', 'owner');
    const cyclesAll = await ins.listCycles('sA', 'all');
    expect(cyclesAll).toHaveLength(2);
    expect(cyclesOwner).toHaveLength(1);
    const detail = await ins.getCycle('sA', cyclesAll.find((c) => !cyclesOwner.some((o) => o.cycleId === c.cycleId))!.cycleId, 'owner');
    expect(detail).toBeUndefined();
    await expect(ins.listEpisodes(undefined as unknown as string)).rejects.toThrow(/userScope/);
  });
});

describe('cognitive per-user privacy (runtime level)', () => {
  let store: TriplestoreAdapter;
  let dir: string;
  let runtime: AgentRuntime;
  let cfg: CognitiveConfig;

  class StubProvider implements ProviderAdapter {
    name = 'stub';
    async initialize() {}
    async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; }
    async chat(_r: ChatRequest): Promise<ChatResponse> {
      return { id: 'x', content: 'a reply', finishReason: 'stop', toolCalls: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } };
    }
    async *chatStream(r: ChatRequest): AsyncIterable<StreamEvent> { yield { type: 'done', response: await this.chat(r) }; }
  }
  const config: AgentConfig = {
    agentId: AGENT, name: 'test', model: 'mock/mock', workspace: '/tmp/ontofelia-cogpriv-ws',
    systemPrompt: 'You are a test', memoryPolicy: { autoFlushBeforeCompaction: true, defaultConfidence: 'high', trustUntrustedContent: true },
    sessionPolicy: { scope: 'main' }, enabledTools: [], enabledSkills: [], channelBindings: {} as Record<ChannelType, ChannelBinding>,
    sandbox: { scope: 'off', workspaceAccess: 'rw' }, mediaMaxMb: 8, owner: 'test',
  };

  beforeEach(async () => {
    const sid = Math.random().toString(36).slice(2);
    ({ store, dir } = await makeStore());
    const ke = new KnowledgeEngine(store, undefined, GraphRegistry.create([AGENT]));
    const sessionStore = new SessionStore(await fs.mkdtemp(path.join(os.tmpdir(), `cogpriv-sess-${sid}-`)));
    runtime = new AgentRuntime(
      AGENT, config, new StubProvider(), sessionStore,
      new ToolRegistry(), new ToolPolicyEngine({ allow: [], deny: [] }),
      new AuditLog(`/tmp/cogpriv-ws-${sid}`), new SkillRegistry(),
      new SkillExecutor(new SkillRegistry()), new PluginRegistry(), undefined, ke, undefined,
    );
    cfg = new CognitiveConfig(store, AGENT);
  });
  afterEach(async () => {
    // Let the queued cognitive writes finish before the store directory goes.
    await runtime.flushCognitiveWrites();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const cogTypes = ['Episode', 'WorkingMemoryEntry', 'Cycle', 'Goal', 'ReflectiveMarker', 'SkillTrace'].map((t) => `${COGT}${t}`);

  it('with every flag off nothing cognitive is written, for any sender', async () => {
    for (const sender of [OWNER, ALICE, BOB]) {
      const res = await runtime.handleMessage(envelope(sender, 'what is oxigraph?'));
      expect(res.text).toBe('a reply');
    }
    for (const type of cogTypes) expect(await count(store, type)).toBe(0);
    const em = new EpisodicMemory(store, AGENT);
    expect(await em.recent('all')).toEqual([]);
  });

  it('with the flags on, end to end: A\'s message is invisible to B, visible to the owner with scope "all"', async () => {
    await cfg.setCycleManagerEnabled(true);
    await cfg.setEpisodicMemoryEnabled(true);
    await cfg.setGoalStackEnabled(true);

    await runtime.handleMessage(envelope(ALICE, 'remember my tiger lily garden plan'));
    await runtime.handleMessage(envelope(BOB, 'what do you know about a garden plan?'));

    const em = new EpisodicMemory(store, AGENT);
    const bob = await em.recent('telegram:222', 100);
    expect(bob.length).toBeGreaterThan(0);
    expect(bob.some((e) => (e.payload ?? '').includes('tiger lily'))).toBe(false);
    expect(bob.every((e) => e.forUser === 'telegram:222')).toBe(true);
    expect((await em.recent('telegram:111', 100)).some((e) => (e.payload ?? '').includes('tiger lily'))).toBe(true);
    expect((await em.recent('all', 100)).some((e) => (e.payload ?? '').includes('tiger lily'))).toBe(true);
    // legacy-style read as owner does not surface user episodes
    expect((await em.recent('owner', 100)).some((e) => (e.payload ?? '').includes('tiger lily'))).toBe(false);

    // the owner-only inspector/report paths still work on the owner's records
    const none = await store.query(`SELECT ?e WHERE { GRAPH ?g { ?e a <${COGT}Episode> . FILTER NOT EXISTS { ?e <${COGT}forUser> ?u } } }`);
    expect(none.bindings ?? []).toHaveLength(0);
    expect(GraphUriResolver.getCogEpisodicGraph(AGENT)).toBe(em.graphUri());
  });

  it('arm_goal stamps the owner on the goal it arms and a non-owner never sees it', async () => {
    await cfg.setCycleManagerEnabled(true);
    await cfg.setEpisodicMemoryEnabled(true);
    const mandate = await new EpisodicMemory(store, AGENT).append({
      episodeType: 'message-received', sessionId: 'sArm', forUser: 'owner',
      actor: 'urn:entity:agent-sender:owner', actorIsOwner: true, payload: 'please prepare the report tomorrow',
    });
    const armed = await runtime.armGoal(
      { sessionId: 'sArm', mandateEpisodeUri: mandate, newGoal: 'Prepare the report', wakeIn: 'PT2H' },
      async () => {},
    );
    expect(armed?.ok).toBe(true);
    const goals = (await runtime.goalsForCommand('sArm')) ?? [];
    const armedGoal = goals.find((g) => g.goalLabel === 'Prepare the report')!;
    expect(armedGoal.forUser).toBe('owner');
    expect(armedGoal.graph).toBe(GraphUriResolver.getCogGoalsLongtermGraph(AGENT));

    const bobView = new GoalStack(store, GraphRegistry.create([AGENT]), AGENT, 'sBob', undefined, { userId: 'telegram:222', isOwner: false });
    expect(await bobView.get(armedGoal.uri)).toBeUndefined();
    expect((await bobView.active()).map((g) => g.goalLabel)).not.toContain('Prepare the report');
  });
});
