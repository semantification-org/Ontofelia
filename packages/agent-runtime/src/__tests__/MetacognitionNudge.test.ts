import { describe, it, expect, afterEach } from 'vitest';
import {
  AGENT, COGT, OWNER, ALICE, makeEnv, send, stream, cleanup, rows, hoursAgo, type Env, type Probe, type Sender,
} from './promptHarness.js';
import { CycleManager } from '../cognitive/CycleManager.js';
import { CHURN_NOTE_TEXT, UNKNOWN_NUDGE_TEXT } from '../cognitive/Metacognition.js';
import { GraphUriResolver, OxigraphAdapter, GraphRegistry } from '@ontofelia/semantic-memory';
import type { ChatRequest, ChatResponse, MessageEnvelope, ProviderAdapter, StreamEvent, TriplestoreAdapter } from '@ontofelia/core';

// The "I don't know" rule and the churn warning through the full runtime: a real
// store, a mock provider (with tool calls where needed), the owner-only canary.

const BASE = ['flagCycleManager', 'flagEpisodicMemory', 'flagGoalStack'];
const MC = 'flagMetacognition';
const LIVE = 'flagWorkingMemoryPrompt';
const SHADOW = 'flagPromptShadow';
const UNKNOWN_Q = 'Who is Quentin Blorf?';
const ASK_ABOUT_ZOE = 'What do you know about Zoe?';
const E = 'urn:ontofelia:entity:custom-zoe-7';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const NUDGE_BLOCK = `[Note]\n- ${UNKNOWN_NUDGE_TEXT}`;
const USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const NO_FACTS = JSON.stringify({ facts: [], proposals: [], confidence: 'high' });

const seedZoe = async ({ store, em }: Pick<Env, 'store' | 'em'>) => {
  await store.update(`INSERT DATA { GRAPH <${GraphUriResolver.getWorldviewGraph(AGENT)}> {
    <${E}> a <urn:shared:ontology#Person> ; <${RDFS_LABEL}> "Zoe" . } }`);
  await em.append({ episodeType: 'message-received', sessionId: 's-old-1', forUser: 'alice', about: [E], payload: 'alice old: Zoe is my sister', occurredAt: hoursAgo(72) });
  await em.append({ episodeType: 'message-received', sessionId: 's-own', forUser: 'owner', about: [E], payload: 'owner note: Zoe is a contractor', occurredAt: hoursAgo(3) });
};

/** Answers after the given rounds of tool calls (`plan[i]` calls in round i); `failing` makes the calls fail. */
function toolProvider(plan: number[]): (probe: Probe) => ProviderAdapter {
  return (probe) => {
    let answers = 0;
    return {
      name: 'stub',
      async initialize() {},
      async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; },
      async chat(r: ChatRequest): Promise<ChatResponse> {
        if (!r.tools) return { id: 'p', content: NO_FACTS, finishReason: 'stop', toolCalls: [], usage: USAGE };
        const first = r.messages[0];
        if (answers === 0) {
          probe.answers.push({
            system: first?.role === 'system' && typeof first.content === 'string' ? first.content : '',
            writesBefore: probe.writes(),
          });
        }
        const round = answers++;
        if (round < plan.length) {
          return {
            id: `r${round}`, content: '', finishReason: 'tool_calls', usage: USAGE,
            toolCalls: Array.from({ length: plan[round] }, (_, k) => ({ id: `tc${round}_${k}`, name: 'probe_tool', arguments: '{}' })),
          };
        }
        return { id: 'a', content: 'Done.', finishReason: 'stop', toolCalls: [], usage: USAGE };
      },
      async *chatStream(r: ChatRequest): AsyncIterable<StreamEvent> {
        yield { type: 'done', response: await this.chat(r) } as StreamEvent;
      },
    } as ProviderAdapter;
  };
}

interface MetaRow { kind: string; salience: number; carry?: string; user?: string; payload: string }
const metaEntries = async (e: Env): Promise<MetaRow[]> =>
  (await rows(e.store, `SELECT ?kind ?sal ?cf ?u ?p WHERE { GRAPH ?g {
    ?w a <${COGT}WorkingMemoryEntry> ; <${COGT}writtenTo> "metaBuffer" ; <${COGT}entryKind> ?kind ;
       <${COGT}salience> ?sal ; <${COGT}payload> ?p .
    OPTIONAL { ?w <${COGT}carryForward> ?cf } OPTIONAL { ?w <${COGT}forUser> ?u } } }`))
    .map((r) => ({ kind: r.kind.value, salience: Number(r.sal.value), carry: r.cf?.value, user: r.u?.value, payload: r.p.value }));

const nudges = async (e: Env) => (await metaEntries(e)).filter((m) => m.kind === 'unknown-nudge');
const churns = async (e: Env) => (await metaEntries(e)).filter((m) => m.kind === 'churn-warning');

describe('the "I don\'t know" rule', () => {
  const made: Env[] = [];
  afterEach(async () => { await cleanup(made); made.length = 0; });
  async function env(flags: string[], seed = seedZoe): Promise<Env> {
    const e = await makeEnv({ flags, seed }); made.push(e); return e;
  }
  const allUsers = (e: Env) => e.store.update(`INSERT DATA { GRAPH <${GraphUriResolver.getSetupGraph(AGENT)}> {
    <urn:${AGENT}:setup:cognitive> <${COGT}unknownNudgeAllUsers> "true"^^<http://www.w3.org/2001/XMLSchema#boolean> } }`);

  it('a question about an unknown entity puts the nudge into the live prompt of the owner and records the entry', async () => {
    const e = await env([...BASE, MC, LIVE]);
    await send(e, UNKNOWN_Q, OWNER);
    const system = e.probe.answers[0].system;
    expect(system).toContain(NUDGE_BLOCK);
    expect(system.match(/\[Note\]/g)).toHaveLength(1);
    const [entry, ...rest] = await nudges(e);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ salience: 1, carry: 'false', user: 'owner', payload: UNKNOWN_NUDGE_TEXT });
  });

  it('the same holds for a streamed turn', async () => {
    const e = await env([...BASE, MC, LIVE]);
    await stream(e, UNKNOWN_Q, OWNER);
    expect(e.probe.answers[0].system).toContain(NUDGE_BLOCK);
    expect(await nudges(e)).toHaveLength(1);
  });

  it('a question about a known entity gets no nudge and no entry', async () => {
    const e = await env([...BASE, MC, LIVE]);
    await send(e, ASK_ABOUT_ZOE, OWNER);
    expect(e.probe.answers[0].system).not.toContain('[Note]');
    expect(e.probe.answers[0].system).not.toContain(UNKNOWN_NUDGE_TEXT);
    expect(await nudges(e)).toHaveLength(0);
  });

  it('a message that is not a question gets no nudge, however empty the retrieval', async () => {
    const e = await env([...BASE, MC, LIVE]);
    await send(e, 'well that is interesting indeed', OWNER);
    expect(e.probe.answers[0].system).not.toContain(UNKNOWN_NUDGE_TEXT);
    expect(await nudges(e)).toHaveLength(0);
  });

  it('a non-owner gets no nudge by default (the entry is still recorded), and gets it when the setup key says all users', async () => {
    const e = await env([...BASE, MC, LIVE]);
    await send(e, UNKNOWN_Q, ALICE);
    expect(e.probe.answers[0].system).not.toContain(UNKNOWN_NUDGE_TEXT);
    expect(e.probe.answers[0].system).not.toContain('[Note]');
    expect(await nudges(e)).toMatchObject([{ user: 'alice', salience: 1, carry: 'false' }]);

    const open = await env([...BASE, MC, LIVE]);
    await allUsers(open);
    await send(open, UNKNOWN_Q, ALICE);
    expect(open.probe.answers[0].system).toContain(NUDGE_BLOCK);
  });

  it('shadow mode records it and sends nothing, for every user', async () => {
    for (const sender of [OWNER, ALICE] as Sender[]) {
      const e = await env([...BASE, MC, SHADOW]);
      await send(e, UNKNOWN_Q, sender);
      expect(e.probe.answers[0].system).not.toContain(UNKNOWN_NUDGE_TEXT);
      const rec = await rows(e.store, `SELECT ?text WHERE { GRAPH ?g { ?s a <${COGT}PromptShadow> ; <${COGT}assembledText> ?text } }`);
      expect(rec).toHaveLength(1);
      expect(rec[0].text.value).toContain(NUDGE_BLOCK);
      expect(await nudges(e)).toHaveLength(1);
    }
  });

  it('with the prompt flags off the entry is recorded and the prompt is the legacy one', async () => {
    const off = await env([...BASE, MC]);
    await send(off, UNKNOWN_Q, OWNER);
    const base = await env(BASE);
    await send(base, UNKNOWN_Q, OWNER);
    expect(off.probe.answers[0].system).toBe(base.probe.answers[0].system);
    expect(await nudges(off)).toHaveLength(1);
  });

  it('metacognition off: the live prompt has no note and nothing metacognitive is written', async () => {
    const off = await env([...BASE, LIVE]);
    await send(off, UNKNOWN_Q, OWNER);
    const on = await env([...BASE, MC, LIVE]);
    await send(on, UNKNOWN_Q, OWNER);
    expect(off.probe.answers[0].system).not.toContain('[Note]');
    // The only difference of the two prompts is the note block.
    expect(on.probe.answers[0].system.replace(`\n\n${NUDGE_BLOCK}`, '')).toBe(off.probe.answers[0].system);
    expect(await metaEntries(off)).toEqual([]);
    const written = off.updates.join('\n');
    for (const needle of ['unknown-nudge', 'churn-warning', 'newKnowledge', 'conflictSurfaced', 'goalDrift', 'uncertainty']) {
      expect(written, needle).not.toContain(needle);
    }
    expect(on.updates.join('\n')).toContain('newKnowledge');
  });

  it('two users: each nudge entry is written for its own asker only', async () => {
    const e = await env([...BASE, MC, LIVE]);
    await allUsers(e);
    await send(e, UNKNOWN_Q, ALICE);
    await send(e, 'Who is Zebulon Quux?', OWNER);
    const users = (await nudges(e)).map((m) => m.user).sort();
    expect(users).toEqual(['alice', 'owner']);
    // Each prompt carries the constant sentence and its own question only; nothing of the other user.
    expect(e.probe.answers[0].system).not.toContain('Zebulon');
    expect(e.probe.answers[1].system).not.toContain('Quentin');
  });
});

describe('the churn warning', () => {
  const made: Env[] = [];
  afterEach(async () => { await cleanup(made); made.length = 0; });
  async function env(flags: string[], plan: number[]): Promise<Env> {
    const e = await makeEnv({ flags, provider: toolProvider(plan), tools: [{ name: 'probe_tool' }] });
    made.push(e);
    return e;
  }

  it('is written exactly once at the 5th tool call of a turn, counted across rounds', async () => {
    const e = await env([...BASE, MC], [3, 4]);
    await send(e, 'please look into this for me', ALICE);
    expect(await churns(e)).toEqual([
      { kind: 'churn-warning', salience: 0.8, carry: 'false', user: 'alice', payload: CHURN_NOTE_TEXT },
    ]);
  });

  it('is written once however many calls follow the 5th', async () => {
    const e = await env([...BASE, MC], [5, 6, 6]);
    await send(e, 'please look into this for me', ALICE);
    expect(await churns(e)).toHaveLength(1);
  });

  it('is not written for four tool calls', async () => {
    const e = await env([...BASE, MC], [2, 2]);
    await send(e, 'please look into this for me', ALICE);
    expect(await churns(e)).toHaveLength(0);
  });

  it('is a no-op with metacognition off: no entry, no write', async () => {
    const e = await env(BASE, [4, 4]);
    await send(e, 'please look into this for me', ALICE);
    expect(await churns(e)).toHaveLength(0);
    expect(e.updates.join('\n')).not.toContain('churn-warning');
  });

  it('a later turn without long tool use adds nothing', async () => {
    const e = await env([...BASE, MC], [5]);
    await send(e, 'please look into this for me', ALICE);
    // The provider answers without tools from here on.
    expect(await churns(e)).toHaveLength(1);
    await send(e, 'and again, thanks', ALICE);
    expect(await churns(e)).toHaveLength(1);
  });
});

describe('the churn hook of the cycle manager', () => {
  async function makeStore(): Promise<TriplestoreAdapter> {
    const store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: `/tmp/meta-churn-${process.pid}-${Math.random().toString(16).slice(2)}`, port: 0, endpoint: '' });
    return store;
  }
  const envelope = (): MessageEnvelope => ({
    id: 'm', channel: 'webchat', accountId: 'a', chatType: 'web', sender: ALICE, timestamp: new Date().toISOString(),
    text: 'please look into this', mentions: [], attachments: [],
  }) as MessageEnvelope;

  async function calls(n: number, metacognitionEnabled: boolean): Promise<number> {
    const store = await makeStore();
    const errors: unknown[] = [];
    const cm = new CycleManager(store, GraphRegistry.create([AGENT]), AGENT, (x) => errors.push(x), { awaitPersist: true });
    await cm.runCycle(
      envelope(),
      async (_t, _g, _i, _p, _c, onToolCall) => {
        for (let i = 1; i <= n; i++) onToolCall(i);
        return { text: 'ok', sessionId: 'sess-churn' };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { metacognitionEnabled },
    );
    expect(errors).toEqual([]);
    const res = await store.query(`SELECT ?e WHERE { GRAPH ?g { ?e <${COGT}entryKind> "churn-warning" } }`);
    return (res.bindings ?? []).length;
  }

  it('nothing at 4 calls, one entry at the 5th, still one at the 9th, none with metacognition off', async () => {
    expect(await calls(4, true)).toBe(0);
    expect(await calls(5, true)).toBe(1);
    expect(await calls(9, true)).toBe(1);
    expect(await calls(9, false)).toBe(0);
  });
});
