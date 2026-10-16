import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac } from 'node:crypto';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OxigraphAdapter, GraphRegistry, ProceduralMemory } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter, MessageEnvelope } from '@ontofelia/core';
import { CycleManager, type ToolEpisodeEvent } from '../cognitive/CycleManager.js';
import { fixedKeySource } from '../cognitive/ArgDigestKey.js';

// Procedural memory completion at the cycle level: adherence, the suggestion
// filter, redaction (a whole-store dump), the follow-up signal, privacy.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';
const PROC = `urn:${AGENT}:cog:procedural`;
const GOAL = `${COGT}AnswerQuestion`;
const SESS = 'sessPC';

// Obviously fake credentials; none of these is a real secret.
const SK = 'sk' + '-test-0000000000000000000000000000';
const HEX40 = '0123456789abcdef0123456789abcdef01234567';
const JWT = 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ0ZXN0In0.fakesignature0000';
const BEARER_VALUE = 'test-token-0000000000';
const PASSWORD = 'not-a-real-password-0000';
// An obviously fake key for the tests.
const KEY = Buffer.alloc(32, 7);
const sha = (s: string) => createHmac('sha256', KEY).update(s).digest('hex');

type Sender = MessageEnvelope['sender'];
const OWNER: Sender = { id: 'user:testuser', channelPrefix: 'webchat', isOwner: true };
const ALICE: Sender = { id: 'alice', channelPrefix: 'webchat', isOwner: false };
const BOB: Sender = { id: 'bob', channelPrefix: 'webchat', isOwner: false };

function envelope(text: string, sender: Sender = OWNER): MessageEnvelope {
  return {
    id: 'm1', channel: 'webchat', accountId: 'acc1', chatType: 'web', sender,
    timestamp: new Date().toISOString(), text, mentions: [], attachments: [],
  } as MessageEnvelope;
}

interface Call { tool: string; args?: Record<string, unknown>; ok?: boolean }

describe('procedural memory completion (cycle level)', () => {
  let store: TriplestoreAdapter;
  let cm: CycleManager;
  let dir: string;
  let prompts: Array<string | undefined>;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'proc-completion-cycle-'));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
    cm = new CycleManager(store, GraphRegistry.create([AGENT]), AGENT, undefined, { awaitPersist: true, argDigestKey: fixedKeySource(KEY) });
    prompts = [];
  });

  afterEach(async () => {
    await cm.flushPending();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  /** A turn that asks for the goal prompt, then runs `calls`. */
  async function turn(
    text: string, calls: Call[], opts: { procedural: boolean; sender?: Sender; session?: string },
  ): Promise<void> {
    const session = opts.session ?? SESS;
    await cm.runCycle(
      envelope(text, opts.sender),
      async (recordTool: (e: ToolEpisodeEvent) => void, prepareGoals: (s: string) => Promise<string | undefined>) => {
        prompts.push(await prepareGoals(session));
        calls.forEach((c, i) => {
          const base = { toolName: c.tool, callId: `c${i}`, occurredAt: new Date(Date.now() + i) };
          recordTool({
            phase: 'called', ...base,
            argsBrief: Object.keys(c.args ?? {}).join(', '),
            ...(c.args ? { args: c.args } : {}),
          });
          recordTool({ phase: 'completed', ...base, outcome: c.ok === false ? 'error' : 'success', durationMs: 5 });
        });
        return { text: 'done', sessionId: session };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { goalsEnabled: true, proceduralEnabled: opts.procedural },
    );
    await cm.flushPending();
  }

  /** Seed learned skills for AnswerQuestion: searchKb works, flakyTool does not. */
  async function seedSkills(): Promise<void> {
    const pm = new ProceduralMemory(store, AGENT);
    const add = async (tool: string, ok: number, bad: number) => {
      for (let i = 0; i < ok + bad; i++) {
        const uri = await pm.recordTrace({
          toolName: tool, toolArgsHash: 'h', toolArgsBrief: 'q', executedAt: new Date(Date.now() - 60_000 + i),
          durationMs: 10, outcome: i < ok ? 'success' : 'error', forGoalType: GOAL, sequencePos: 1,
        });
        if (i < ok) await pm.backfillSatisfaction(uri, true);
      }
    };
    await add('searchKb', 4, 0);
    await add('flakyTool', 2, 3);
    await pm.consolidate({ since: new Date(0), until: new Date(Date.now() + 1000) });
  }

  const rows = async (q: string) => (await store.query(q)).bindings ?? [];
  const dumpStore = async (): Promise<string> =>
    JSON.stringify(await rows('SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }'));
  const traceInfo = async () =>
    rows(`SELECT ?t ?tool ?ad ?user WHERE { GRAPH <${PROC}> { ?t a <${COGT}SkillTrace> ; <${COGT}toolName> ?tool .
      OPTIONAL { ?t <${COGT}proceduralAdherence> ?ad } OPTIONAL { ?t <${COGT}forUser> ?user } } }`);

  it('does not suggest low-success tools', async () => {
    await seedSkills();
    await turn('what is oxigraph?', [], { procedural: true });
    expect(prompts[0]).toContain('[Skills that worked');
    expect(prompts[0]).toContain('searchKb');
    expect(prompts[0]).not.toContain('flakyTool');
    const wm = await rows(`SELECT ?p WHERE { GRAPH ?g { ?e <${COGT}entryKind> "skill-suggestion" ; <${COGT}payload> ?p } }`);
    expect(wm.map((b) => b.p.value)).toEqual(['searchKb']);
  });

  it('records adherence on every traced call when suggestions were shown', async () => {
    await seedSkills();
    await turn(
      'what is oxigraph?',
      [{ tool: 'searchKb' }, { tool: 'otherTool' }, { tool: 'searchKb' }, { tool: 'flakyTool' }],
      { procedural: true },
    );
    const t = await traceInfo();
    const fresh = t.filter((b) => b.user !== undefined);
    expect(fresh).toHaveLength(4);
    // 100 %: every fresh trace carries the flag.
    expect(fresh.every((b) => b.ad !== undefined)).toBe(true);
    const byTool = (name: string) => fresh.filter((b) => b.tool.value === name).map((b) => b.ad!.value);
    expect(byTool('searchKb')).toEqual(['true', 'true']);
    expect(byTool('otherTool')).toEqual(['false']);
    expect(byTool('flakyTool')).toEqual(['false']); // not suggested (filtered out)
    expect(fresh.every((b) => b.user!.value === 'owner')).toBe(true);

    const sums = await rows(`SELECT ?u ?n ?a ?c WHERE { GRAPH <${PROC}> { ?s a <${COGT}AdherenceSummary> ;
      <${COGT}forUser> ?u ; <${COGT}tracedCalls> ?n ; <${COGT}adheredCalls> ?a ; <${COGT}cycleId> ?c } }`);
    expect(sums).toHaveLength(1);
    expect([sums[0].u.value, sums[0].n.value, sums[0].a.value]).toEqual(['owner', '4', '2']);
  });

  it('records no adherence when no suggestions were shown', async () => {
    await turn('what is oxigraph?', [{ tool: 'searchKb' }, { tool: 'otherTool' }], { procedural: true });
    const t = await traceInfo();
    expect(t).toHaveLength(2);
    expect(t.every((b) => b.ad === undefined)).toBe(true);
    expect(t.every((b) => b.user?.value === 'owner')).toBe(true);
    expect(await rows(`SELECT ?s WHERE { GRAPH <${PROC}> { ?s a <${COGT}AdherenceSummary> } }`)).toHaveLength(0);
  });

  it('never lets a secret-shaped argument reach the store, and keeps only its keyed digest', async () => {
    const args = {
      query: 'plain question',
      api_key: SK, // masked by key
      note: SK, // masked by value shape
      commit: HEX40,
      session: JWT,
      headers: { Authorization: `Bearer ${BEARER_VALUE}`, Accept: 'text/plain' },
      line: `curl -H "Authorization: Bearer ${BEARER_VALUE}" https://example.invalid`,
      password: PASSWORD,
    };
    await turn('what is oxigraph?', [{ tool: 'httpCall', args }], { procedural: true });
    const dump = await dumpStore();
    // Positive control: the dump does show what the store holds (the inbound text).
    expect(dump).toContain('what is oxigraph?');
    for (const raw of [SK, HEX40, JWT, BEARER_VALUE, PASSWORD]) expect(dump).not.toContain(raw);
    // The keys are there (that is the brief), the digests of the masked values too.
    expect(dump).toContain('query, api_key, note, commit, session, headers, line, password');
    for (const v of [SK, HEX40, JWT, PASSWORD]) expect(dump).toContain(`hmac-sha256:${sha(v)}`);
    expect(dump).toContain(`headers.Authorization=hmac-sha256:${sha(`Bearer ${BEARER_VALUE}`)}`);
    // The unmasked, ordinary value is not stored either: briefs are keys only.
    expect(dump).not.toContain('plain question"');
    const masked = await rows(`SELECT ?m WHERE { GRAPH <${PROC}> { ?t <${COGT}maskedArg> ?m } }`);
    expect(masked.length).toBeGreaterThanOrEqual(7);
  });

  it('honours configured redaction rules on top of the defaults', async () => {
    const rules = JSON.stringify({ keyPatterns: ['^pin$'] });
    await store.update(`INSERT DATA { GRAPH <urn:${AGENT}:setup> { <urn:${AGENT}:setup:cognitive> <${COGT}argRedactionRules> ${JSON.stringify(rules)} } }`);
    await turn('what is oxigraph?', [{ tool: 'unlock', args: { pin: 4711, token: 'abc' } }], { procedural: true });
    const masked = (await rows(`SELECT ?m WHERE { GRAPH <${PROC}> { ?t <${COGT}maskedArg> ?m } }`)).map((b) => b.m.value).sort();
    expect(masked).toEqual([`pin=hmac-sha256:${sha('4711')}`, `token=hmac-sha256:${sha('abc')}`].sort());
  });

  it('with procedural memory off the prompt is the golden one and nothing new is written', async () => {
    await seedSkills();
    const before = await rows(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${PROC}> { ?s ?p ?o } }`);
    await turn('what is oxigraph?', [{ tool: 'searchKb', args: { api_key: SK, q: 'x' } }], { procedural: false });
    expect(prompts[0]).toBe('[Active goal]\n- Answer: what is oxigraph? (type: AnswerQuestion, priority: 0.7)');
    const after = await rows(`SELECT (COUNT(*) AS ?n) WHERE { GRAPH <${PROC}> { ?s ?p ?o } }`);
    expect(after[0].n.value).toBe(before[0].n.value);
    const dump = await dumpStore();
    expect(dump).not.toContain(SK);
    expect(dump).not.toContain('maskedArg');
    expect(dump).not.toContain('AdherenceSummary');
    expect(dump).not.toContain('proceduralAdherence');
  });

  it('the next message judges the previous turn with a low weight, once', async () => {
    await turn('what is oxigraph?', [{ tool: 'searchKb' }], { procedural: true, sender: ALICE });
    await turn('perfect, thanks!', [], { procedural: true, sender: ALICE });
    const judged = async () =>
      rows(`SELECT ?v ?w WHERE { GRAPH <${PROC}> { ?t a <${COGT}SkillTrace> ; <${COGT}userSatisfied> ?v ; <${COGT}satisfactionWeight> ?w } }`);
    let j = await judged();
    expect(j).toHaveLength(1);
    expect([j[0].v.value, Number(j[0].w.value)]).toEqual(['true', 0.3]);
    // A second reaction does not rewrite the first judgement.
    await turn('that is wrong', [], { procedural: true, sender: ALICE });
    j = await judged();
    expect(j).toHaveLength(1);
    expect(j[0].v.value).toBe('true');
  });

  it('a dissatisfied follow-up marks the traces false, with the same low weight', async () => {
    await turn('what is oxigraph?', [{ tool: 'searchKb' }], { procedural: true, sender: ALICE });
    await turn('not good', [], { procedural: true, sender: ALICE });
    const j = await rows(`SELECT ?v ?w WHERE { GRAPH <${PROC}> { ?t <${COGT}userSatisfied> ?v ; <${COGT}satisfactionWeight> ?w } }`);
    expect(j.map((b) => [b.v.value, Number(b.w.value)])).toEqual([['false', 0.3]]);
  });

  it('an ambiguous follow-up writes nothing', async () => {
    await turn('what is oxigraph?', [{ tool: 'searchKb' }], { procedural: true, sender: ALICE });
    await turn('thanks, but can you also add the date?', [], { procedural: true, sender: ALICE });
    expect(await rows(`SELECT ?v WHERE { GRAPH <${PROC}> { ?t <${COGT}userSatisfied> ?v } }`)).toHaveLength(0);
  });

  it('keeps two users apart: the other user never judges my traces, every record carries its user', async () => {
    await turn('what is oxigraph?', [{ tool: 'searchKb', args: { token: SK } }], { procedural: true, sender: ALICE });
    // Bob thanks in the very same session: that is not Alice's reaction.
    await turn('perfect, thanks!', [], { procedural: true, sender: BOB });
    expect(await rows(`SELECT ?v WHERE { GRAPH <${PROC}> { ?t <${COGT}userSatisfied> ?v } }`)).toHaveLength(0);
    await turn('look something up', [{ tool: 'searchKb' }], { procedural: true, sender: BOB });
    const t = await traceInfo();
    expect(t.map((b) => b.user!.value).sort()).toEqual(['alice', 'bob']);
    // Bob's later thanks judges Bob's trace only.
    await turn('danke!', [], { procedural: true, sender: BOB });
    const judged = await rows(`SELECT ?u WHERE { GRAPH <${PROC}> { ?t <${COGT}userSatisfied> ?v ; <${COGT}forUser> ?u } }`);
    expect(judged.map((b) => b.u.value)).toEqual(['bob']);
    expect(await dumpStore()).not.toContain(SK);
  });
});
