import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  OWNER_USER_KEY,
  cogUserKey,
  type ChatRequest,
  type ChatResponse,
  type MessageEnvelope,
  type ProviderAdapter,
  type StreamEvent,
  type TriplestoreAdapter,
} from '@ontofelia/core';
import { EpisodicMemory, GraphRegistry, GraphUriResolver, OxigraphAdapter } from '@ontofelia/semantic-memory';
import {
  AGENT,
  COGT,
  OWNER,
  cleanup,
  envelope,
  makeEnv,
  rows,
  send,
  stream,
  type Env,
  type Sender,
} from './promptHarness.js';
import { CogInspector, renderExplanation, type ResponseExplanation } from '../cognitive/CogInspector.js';
import { CycleManager, type ToolEpisodeEvent } from '../cognitive/CycleManager.js';
import { COGNITIVE_FLAGS } from '../cognitive/CognitiveConfig.js';
import { WorkingMemory } from '../cognitive/WorkingMemory.js';

// Schema alignment and honest explain: action buffer, doc-named phase predicates,
// the metacognition episodes, and the response -> action -> goal -> WM -> episode
// chain with its text form. Every fixture value is fake.

const SK = 'sk' + '-test-0000000000000000000000000000';
const USAGE = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const NO_FACTS = JSON.stringify({ facts: [], proposals: [], confidence: 'high' });
const CYCLE_FLAGS = ['flagCycleManager', 'flagEpisodicMemory', 'flagGoalStack', 'flagMetacognition', 'flagDebugPanel'];
const registry = () => GraphRegistry.create([AGENT]);

/** A provider that asks for one tool call, then answers; it records the answer requests. */
function toolProvider(toolName: string, args: object) {
  const requests: ChatRequest[] = [];
  let round = 0;
  const next = (): ChatResponse =>
    round++ === 0
      ? { id: 't', content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'tc1', name: toolName, arguments: JSON.stringify(args) }], usage: USAGE }
      : { id: 'a', content: 'The probe finished.', finishReason: 'stop', toolCalls: [], usage: USAGE };
  const adapter: ProviderAdapter = {
    name: 'stub',
    async initialize() {},
    async healthCheck() { return { healthy: true, component: 'stub', checkedAt: new Date().toISOString() }; },
    async chat(r: ChatRequest): Promise<ChatResponse> {
      if (!r.tools) return { id: 'p', content: NO_FACTS, finishReason: 'stop', toolCalls: [], usage: USAGE };
      requests.push(JSON.parse(JSON.stringify(r)));
      return next();
    },
    async *chatStream(r: ChatRequest): AsyncIterable<StreamEvent> {
      requests.push(JSON.parse(JSON.stringify(r)));
      const resp = next();
      if (resp.content) yield { type: 'text_delta', content: resp.content } as StreamEvent;
      yield { type: 'done', response: resp } as StreamEvent;
    },
  };
  return { adapter, requests };
}

const actionEntries = async (store: TriplestoreAdapter, registry_: GraphRegistry, sessionId: string, cycleId: string) =>
  (await new WorkingMemory(store, registry_, AGENT, sessionId, cycleId).read({ buffer: 'actionBuffer' })).sort((a, b) =>
    a.entryKind < b.entryKind ? -1 : 1,
  );

describe('explain, action buffer and schema alignment (runtime)', () => {
  const made: Env[] = [];
  afterEach(async () => {
    await cleanup(made);
    made.length = 0;
  });

  async function tool(flags: string[], args: object = { query: 'weather' }, toolName = 'probe_tool') {
    const p = toolProvider(toolName, args);
    const e = await makeEnv({ flags, tools: [{ name: toolName }], provider: () => p.adapter });
    made.push(e);
    return { e, p };
  }
  const firstCycle = async (e: Env, sessionId: string, scope = OWNER_USER_KEY) => {
    const ins = new CogInspector(e.store, registry(), AGENT);
    const cycles = await ins.listCycles(sessionId, scope);
    return { ins, cycleId: cycles[0].cycleId };
  };

  it('explain returns a non-empty chain for a tool turn: response -> action -> goal -> WM -> episode', async () => {
    const { e } = await tool(CYCLE_FLAGS);
    const res = await send(e, 'hello there', OWNER);
    const { ins, cycleId } = await firstCycle(e, res.sessionId);
    const exp = await ins.explainResponse(res.sessionId, cycleId, OWNER_USER_KEY);

    expect(exp.found).toBe(true);
    // response
    expect(exp.response?.episodeType).toBe('response-sent');
    expect(exp.response?.payload).toBe('The probe finished.');
    // action, with its result and the episodes of the call
    expect(exp.actions).toHaveLength(1);
    const a = exp.actions[0];
    expect(a.toolName).toBe('probe_tool');
    expect(a.outcome).toBe('success');
    expect(a.durationMs).toBeGreaterThanOrEqual(0);
    expect(a.args).toBe('query');
    expect(a.episodes.map((x) => x.episodeType).sort()).toEqual(['tool-called', 'tool-completed']);
    // goal
    expect(a.forGoal).toBeDefined();
    expect(a.goal?.uri).toBe(a.forGoal);
    expect(exp.goals.map((g) => g.uri)).toContain(a.forGoal);
    // working memory
    const wm = Object.fromEntries(exp.workingMemory.map((b) => [b.buffer, b.count]));
    expect(wm.actionBuffer).toBe(2);
    expect(wm.perceptionBuffer).toBeGreaterThan(0);
    // episodes
    expect(exp.episodes.map((x) => x.episodeType)).toEqual(
      expect.arrayContaining(['message-received', 'tool-called', 'tool-completed', 'response-sent']),
    );

    // The same chain as fixed-format text, through the owner command (defaults to the last cycle).
    const reply = await e.runtime.handleMessage(envelope('/cog explain', OWNER));
    expect(reply.text).toBe(renderExplanation(exp));
    expect(reply.text).toContain('Response: ');
    expect(reply.text).toContain('Actions (1):');
    expect(reply.text).toContain('1. probe_tool -> ok');
    expect(reply.text).toContain('Working memory: ');
    // ... and with the cycle id given.
    const named = await e.runtime.handleMessage(envelope(`/cog explain ${cycleId}`, OWNER));
    expect(named.text).toBe(reply.text);
  });

  it('writes the action entries for a blocking turn: proposal in phase 4, result in phase 5, forGoal and forUser set', async () => {
    const { e } = await tool(CYCLE_FLAGS);
    const res = await send(e, 'hello there', OWNER);
    const { cycleId } = await firstCycle(e, res.sessionId);
    const entries = await actionEntries(e.store, registry(), res.sessionId, cycleId);
    expect(entries.map((x) => x.entryKind)).toEqual(['action-proposal', 'action-result']);
    const [prop, result] = entries;
    expect(prop.toolName).toBe('probe_tool');
    expect(prop.callId).toBe('tc1');
    expect(prop.forGoal).toMatch(/^urn:/);
    expect(prop.forUser).toBe(OWNER_USER_KEY);
    expect(prop.writtenBy).toMatch(/_4$/);
    expect(result.writtenBy).toMatch(/_5$/);
    expect(result.callId).toBe('tc1');
    expect(result.outcome).toBe('success');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.forUser).toBe(OWNER_USER_KEY);
  });

  it('streamCore writes the action entries too', async () => {
    const { e } = await tool(CYCLE_FLAGS);
    const chunks = await stream(e, 'hello there', OWNER);
    const sessionId = (chunks.find((c) => c.type === 'stream_start') as { sessionId: string }).sessionId;
    const { ins, cycleId } = await firstCycle(e, sessionId);
    const entries = await actionEntries(e.store, registry(), sessionId, cycleId);
    expect(entries.map((x) => x.entryKind)).toEqual(['action-proposal', 'action-result']);
    expect(entries[0].forGoal).toMatch(/^urn:/);
    expect(entries[1].outcome).toBe('success');
    const exp = await ins.explainResponse(sessionId, cycleId, OWNER_USER_KEY);
    expect(exp.actions).toHaveLength(1);
    expect(exp.actions[0].toolName).toBe('probe_tool');
    expect(exp.response?.payload).toBe('The probe finished.');
  });

  it('action-proposal arguments are masked: no secret-shaped value reaches the store, the masked paths are named', async () => {
    const { e } = await tool(CYCLE_FLAGS, { api_key: SK, query: 'weather', note: SK });
    const res = await send(e, 'hello there', OWNER);
    const { cycleId } = await firstCycle(e, res.sessionId);
    const [prop] = await actionEntries(e.store, registry(), res.sessionId, cycleId);
    expect(prop.payload).toBe('tool-call probe_tool; args: api_key, query, note; masked: api_key, note');
    expect(prop.toolArgs).toBe('api_key, query, note');
    const dump = JSON.stringify(await rows(e.store, 'SELECT ?g ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } }'));
    expect(dump).not.toContain(SK);
    expect(dump).not.toContain('sk-test');
    // Positive control: the dump does contain the action entry (the scan can see it).
    expect(dump).toContain('tool-call probe_tool');
  });

  it('writes the doc-named phase predicates and no ordinal; an aborted core marks phases 4 and 5 aborted', async () => {
    const { e } = await tool(CYCLE_FLAGS);
    await send(e, 'hello there', OWNER);
    const ph = await rows(
      e.store,
      `SELECT ?idx ?st ?kind WHERE { GRAPH ?g { ?c <${COGT}hasPhase> ?p . ?p <${COGT}phaseIndex> ?idx ; <${COGT}phaseStatus> ?st ; <${COGT}phaseKind> ?kind } }`,
    );
    expect(ph.map((r) => Number(r.idx.value)).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ph.every((r) => r.st.value === 'completed')).toBe(true);
    expect(await rows(e.store, `SELECT ?p WHERE { GRAPH ?g { ?p <${COGT}ordinal> ?o } }`)).toHaveLength(0);
    const cyc = await rows(e.store, `SELECT ?id ?s WHERE { GRAPH ?g { ?c a <${COGT}Cycle> ; <${COGT}cycleId> ?id ; <${COGT}sessionId> ?s } }`);
    expect(cyc).toHaveLength(1);
  });

  it('flags off: the prompt is byte-identical to the cycle-on prompt, nothing cognitive is written, /cog explain says the cycle is off', async () => {
    const off = await tool([]);
    const on = await tool(['flagCycleManager', 'flagEpisodicMemory', 'flagMetacognition', 'flagDebugPanel']);
    await send(off.e, 'hello there', OWNER);
    await send(on.e, 'hello there', OWNER);
    const shape = (rs: ChatRequest[]) => rs.map((r) => r.messages.map((m) => [m.role, m.content]));
    expect(off.p.requests).toHaveLength(2);
    expect(shape(on.p.requests)).toEqual(shape(off.p.requests));
    // Golden: the system prompt carries none of the cognitive blocks.
    const system = String(off.p.requests[0].messages[0].content);
    for (const block of ['[Active goal]', '[Self]', '[Skills that worked', '[Recalled']) expect(system).not.toContain(block);

    // No writes into any cognitive graph with every flag off.
    expect(off.e.updates.filter((u) => u.includes(':cog:'))).toEqual([]);
    for (const t of ['Episode', 'WorkingMemoryEntry', 'Cycle', 'Phase', 'Goal', 'ReflectiveMarker']) {
      expect(await rows(off.e.store, `SELECT ?s WHERE { GRAPH ?g { ?s a <${COGT}${t}> } }`)).toHaveLength(0);
    }
    // Positive control: with the cycle on, the same scan does see writes.
    expect(on.e.updates.filter((u) => u.includes(':cog:')).length).toBeGreaterThan(0);

    const reply = await off.e.runtime.handleMessage(envelope('/cog explain', OWNER));
    expect(reply.text).toBe('The cognitive cycle is off (flagCycleManager). Nothing was read. Enable with /cog cycle on.');
    // Cycle on, debug panel off: the existing gate answers, still nothing is read.
    const gated = await tool(['flagCycleManager']);
    const g = await gated.e.runtime.handleMessage(envelope('/cog explain', OWNER));
    expect(g.text).toBe('Cognitive debug panel is disabled. Enable with `/cog debug on`.');
  });

  it('/cog explain without any cycle in the session says so', async () => {
    const { e } = await tool(CYCLE_FLAGS);
    const reply = await e.runtime.handleMessage(envelope('/cog explain', OWNER));
    expect(reply.text).toBe('No cycle has been recorded in this session yet.');
  });

  it('the SPARQL walk of doc 03 section 10 returns rows (and the draft queries did not)', async () => {
    const { e } = await tool(CYCLE_FLAGS);
    const res = await send(e, 'hello there', OWNER);
    const { cycleId } = await firstCycle(e, res.sessionId);

    // Copied verbatim from docs/cognitive-architecture/03-cognitive-cycle.md section 10.
    const DOC_Q1 = `PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?phase ?idx ?started ?ended ?status WHERE {
  GRAPH <urn:ontofelia:cog:cycles:sess_2026-05-31_18-04> {
    <urn:ontofelia:cog:cycle:cyc-0001> cogt:hasPhase ?phase .
    ?phase cogt:phaseIndex ?idx ;
           cogt:startedAt  ?started ;
           cogt:endedAt    ?ended  ;
           cogt:phaseStatus ?status .
  }
} ORDER BY ?idx`;
    const DOC_Q2 = `PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?goal ?phase ?action ?episode ?messageText WHERE {
  GRAPH <urn:ontofelia:cog:goals:sess_2026-05-31_18-04> {
    ?goal a cogt:Goal ; cogt:goalStatus "resolved" .
  }
  GRAPH <urn:ontofelia:cog:working:sess_2026-05-31_18-04:cyc-0001> {
    ?actionEntry cogt:writtenTo "actionBuffer" ;
                 cogt:forGoal   ?goal ;
                 cogt:writtenBy ?phase ;
                 cogt:payload   ?action .
  }
  GRAPH <urn:ontofelia:cog:cycles:sess_2026-05-31_18-04> {
    ?cycle cogt:hasPhase ?phase ;
           cogt:cycleId  ?cycleId .
  }
  GRAPH <urn:ontofelia:cog:episodic> {
    ?episode cogt:cycleId ?cycleId ;
             cogt:episodeType "message-received" ;
             cogt:payload  ?messageText .
  }
}`;
    const doc = await fs.readFile(new URL('../../../../docs/cognitive-architecture/03-cognitive-cycle.md', import.meta.url), 'utf8');
    expect(doc).toContain(DOC_Q1);
    expect(doc).toContain(DOC_Q2);
    const real = (q: string) => q.replaceAll('sess_2026-05-31_18-04', res.sessionId).replaceAll('cyc-0001', cycleId);

    const q1 = await rows(e.store, real(DOC_Q1));
    expect(q1.map((r) => Number(r.idx.value))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(q1.every((r) => r.status.value === 'completed')).toBe(true);

    const q2 = await rows(e.store, real(DOC_Q2));
    expect(q2.length).toBeGreaterThanOrEqual(1);
    expect(q2[0].messageText.value).toBe('hello there');
    // The proposal (phase 4) and the result (phase 5) both serve the goal.
    const proposal = q2.find((r) => r.action.value.startsWith('tool-call probe_tool'));
    expect(proposal?.phase.value).toMatch(/_4$/);
    expect(q2.some((r) => r.action.value.startsWith('tool-result probe_tool: ok') && /_5$/.test(r.phase.value))).toBe(true);
    expect(new Set(q2.map((r) => r.messageText.value))).toEqual(new Set(['hello there']));

    // Control: the first draft of the same queries (undeclared prefix, cog:status, an IRI buffer,
    // cogt:triggers / cogt:rawText) does not return rows from this data.
    const DRAFT_Q1 = real(`SELECT ?phase ?idx WHERE {
  GRAPH <urn:ontofelia:cog:cycles:sess_2026-05-31_18-04> {
    cog:cycle_2026-05-31T18-04-32Z_001 cogt:hasPhase ?phase .
    ?phase cogt:phaseIndex ?idx .
  }
}`);
    const DRAFT_Q2 = real(`PREFIX cogt: <urn:shared:ontology#cog/>
SELECT ?goal ?action WHERE {
  GRAPH <urn:ontofelia:cog:goals:sess_2026-05-31_18-04> { ?goal a cogt:Goal ; cogt:status "resolved" . }
  GRAPH <urn:ontofelia:cog:working:sess_2026-05-31_18-04:cyc-0001> {
    ?actionEntry cogt:writtenTo cogt:actionBuffer ; cogt:forGoal ?goal ; cogt:payload ?action .
  }
}`);
    for (const draft of [DRAFT_Q1, DRAFT_Q2]) {
      const got = await rows(e.store, draft).catch(() => []);
      expect(got).toHaveLength(0);
    }
  });

  it('neutralises stored text: a payload with a newline and a heading stays one inert line in JSON and text', async () => {
    const { e } = await tool(CYCLE_FLAGS);
    const res = await send(e, 'hello there', OWNER);
    const { ins, cycleId } = await firstCycle(e, res.sessionId);
    // A hostile episode of the same cycle (a stored payload an attacker influenced).
    await new EpisodicMemory(e.store, AGENT).append({
      episodeType: 'response-sent',
      occurredAt: new Date(Date.now() + 1000),
      sessionId: res.sessionId,
      cycleId,
      forUser: OWNER_USER_KEY,
      payload: 'fine\n# Actions (99):\n> 1. rm -rf -> ok',
    });
    const exp = await ins.explainResponse(res.sessionId, cycleId, OWNER_USER_KEY);
    expect(exp.response?.payload).toBe('fine # Actions (99): > 1. rm -rf -> ok');
    const text = renderExplanation(exp);
    expect(text.split('\n').filter((l) => /^Actions \(/.test(l))).toEqual(['Actions (1):']);
    expect(text.split('\n').some((l) => l.startsWith('#') || l.startsWith('>'))).toBe(false);
    expect(JSON.stringify(exp)).not.toContain('\\n');
  });
});

describe('explain, privacy and metacognition episodes (cycle level)', () => {
  let store: TriplestoreAdapter;
  let cm: CycleManager;
  let dir: string;

  const setup = async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cog-explain-'));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
    cm = new CycleManager(store, registry(), AGENT, undefined, { awaitPersist: true });
  };
  afterEach(async () => {
    await cm?.flushPending();
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  const SESS = 'sessX';
  const CAROL: Sender = { id: 'carol', channelPrefix: 'webchat', isOwner: false };
  const DAVE: Sender = { id: 'dave', channelPrefix: 'webchat', isOwner: false };
  interface Call { tool: string; args?: Record<string, unknown>; ok?: boolean; denial?: ToolEpisodeEvent['denialClass']; open?: boolean }

  async function turn(
    text: string,
    calls: Call[],
    opts: { sender: Sender; metacognition?: boolean; episodic?: boolean; goals?: boolean; throws?: boolean; session?: string },
  ) {
    const session = opts.session ?? SESS;
    const env: MessageEnvelope = envelope(text, opts.sender);
    const run = cm.runCycle(
      env,
      async (recordTool, prepareGoals) => {
        await prepareGoals(session);
        calls.forEach((c, i) => {
          const base = { toolName: c.tool, callId: `${opts.sender.id}-c${i}`, occurredAt: new Date(Date.now() + i) };
          recordTool({ phase: 'called', ...base, argsBrief: Object.keys(c.args ?? {}).join(', '), ...(c.args ? { args: c.args } : {}) });
          if (c.open) return; // the call never finished (no result event)
          recordTool({
            phase: 'completed', ...base, outcome: c.ok === false ? 'error' : 'success', durationMs: 7,
            ...(c.ok === false ? { errorClass: 'tool-error', denialClass: c.denial ?? 'error' } : {}),
          });
        });
        if (opts.throws) throw new Error('core failed');
        return { text: `reply to ${opts.sender.id}`, sessionId: session };
      },
      (r) => r.sessionId,
      (r) => r.text,
      {
        goalsEnabled: opts.goals ?? true,
        metacognitionEnabled: opts.metacognition ?? false,
        episodicEnabled: opts.episodic ?? true,
      },
    );
    if (opts.throws) await run.catch(() => undefined);
    else await run;
    await cm.flushPending();
  }

  const episodeTypes = async () =>
    (await rows(store, `SELECT ?t ?u ?g ?c ?p WHERE { GRAPH ?x { ?e a <${COGT}Episode> ; <${COGT}episodeType> ?t .
      OPTIONAL { ?e <${COGT}forUser> ?u } OPTIONAL { ?e <${COGT}partOfGoal> ?g } OPTIONAL { ?e <${COGT}cycleId> ?c } OPTIONAL { ?e <${COGT}payload> ?p } } }`));

  it('meta-reflected and impasse-flagged episodes appear with metacognition and episodes on, carrying forUser, cycleId and partOfGoal', async () => {
    await setup();
    await turn('please run the probe', [{ tool: 'probe_tool', ok: false }], { sender: CAROL, metacognition: true });
    const eps = await episodeTypes();
    const meta = eps.filter((r) => r.t.value === 'meta-reflected');
    const imp = eps.filter((r) => r.t.value === 'impasse-flagged');
    expect(meta).toHaveLength(1);
    expect(imp).toHaveLength(1);
    for (const r of [...meta, ...imp]) {
      expect(r.u.value).toBe('carol');
      expect(r.g?.value).toMatch(/^urn:/); // partOfGoal: the goal of the turn
      expect(r.c?.value).toMatch(/^cyc-/);
    }
    expect(imp[0].p!.value).toBe('tool-error: probe_tool: tool-error');
    expect(meta[0].p!.value).toBe('cycle impasse-resolved; tools 1, tool errors 1, impasses 1 flagged / 1 resolved, uncertainty medium');
    // The cycle id on the episodes is the cycle's id.
    const ins = new CogInspector(store, registry(), AGENT);
    const cycleId = (await ins.listCycles(SESS, 'carol'))[0].cycleId;
    expect(meta[0].c!.value).toBe(cycleId);
    const exp = await ins.explainResponse(SESS, cycleId, 'carol');
    expect(exp.episodes.map((x) => x.episodeType)).toEqual(expect.arrayContaining(['impasse-flagged', 'meta-reflected']));
  });

  it('no meta episodes with the episodic flag off, and none with metacognition off', async () => {
    await setup();
    await turn('please run the probe', [{ tool: 'probe_tool', ok: false }], { sender: CAROL, metacognition: true, episodic: false });
    expect((await episodeTypes()).map((r) => r.t.value)).toEqual([]);
    // The reflective marker is still written (episodic flag only gates episodes).
    expect(await rows(store, `SELECT ?m WHERE { GRAPH ?g { ?m a <${COGT}ReflectiveMarker> } }`)).toHaveLength(1);

    await turn('again', [{ tool: 'probe_tool', ok: false }], { sender: CAROL, metacognition: false });
    const types = (await episodeTypes()).map((r) => r.t.value);
    expect(types).toContain('message-received');
    expect(types).not.toContain('meta-reflected');
    expect(types).not.toContain('impasse-flagged');
  });

  it('a turn without an impasse gets a meta-reflected episode and no impasse-flagged one', async () => {
    await setup();
    await turn('plain question', [{ tool: 'probe_tool' }], { sender: CAROL, metacognition: true });
    const types = (await episodeTypes()).map((r) => r.t.value);
    expect(types.filter((t) => t === 'meta-reflected')).toHaveLength(1);
    expect(types).not.toContain('impasse-flagged');
  });

  it('writes phaseStatus aborted for the delegated phases when the core throws', async () => {
    await setup();
    await turn('this will fail', [{ tool: 'probe_tool' }], { sender: CAROL, throws: true });
    const ph = await rows(store, `SELECT ?idx ?st WHERE { GRAPH ?g { ?p <${COGT}phaseIndex> ?idx ; <${COGT}phaseStatus> ?st } }`);
    const by = Object.fromEntries(ph.map((r) => [r.idx.value, r.st.value]));
    expect(by).toEqual({ 1: 'completed', 2: 'completed', 3: 'completed', 4: 'aborted', 5: 'aborted', 6: 'completed' });
  });

  it('action entries: at most 25 calls per cycle become actions', async () => {
    await setup();
    const many: Call[] = Array.from({ length: 30 }, () => ({ tool: 'probe_tool' }));
    await turn('many calls', many, { sender: CAROL });
    const ins = new CogInspector(store, registry(), AGENT);
    const cycleId = (await ins.listCycles(SESS, 'carol'))[0].cycleId;
    const entries = await new WorkingMemory(store, registry(), AGENT, SESS, cycleId).read({ buffer: 'actionBuffer' });
    expect(entries).toHaveLength(50);
    // 30 calls were reported; the first 25 became actions (a proposal and a result each).
    expect(new Set(entries.map((x) => x.callId)).size).toBe(25);
  });

  it('a call that never finished has only its proposal; a denied call carries its denial class', async () => {
    await setup();
    await turn('two calls', [{ tool: 'slow_tool', open: true }, { tool: 'locked_tool', ok: false, denial: 'policy-denied' }], { sender: CAROL });
    const ins = new CogInspector(store, registry(), AGENT);
    const cycleId = (await ins.listCycles(SESS, 'carol'))[0].cycleId;
    const exp = await ins.explainResponse(SESS, cycleId, 'carol');
    const by = Object.fromEntries(exp.actions.map((a) => [a.toolName, a]));
    expect(by.slow_tool.outcome).toBeUndefined();
    expect(by.slow_tool.resultEntryId).toBeUndefined();
    expect(by.locked_tool.outcome).toBe('error');
    expect(by.locked_tool.denialClass).toBe('policy-denied');
    const text = renderExplanation(exp);
    expect(text).toContain('slow_tool -> no result');
    expect(text).toContain('locked_tool -> error (policy-denied), 7 ms');
  });

  it('two-user privacy: another user, the owner and an unknown cycle see nothing of a user\'s cycle', async () => {
    await setup();
    await turn('carol secret plan about the garden', [{ tool: 'probe_tool', args: { query: 'carol-only-query' } }], { sender: CAROL, metacognition: true });
    await turn('dave plain request', [{ tool: 'probe_tool' }], { sender: DAVE, metacognition: true });
    const ins = new CogInspector(store, registry(), AGENT);

    const carolCycles = await ins.listCycles(SESS, cogUserKey(CAROL));
    const daveCycles = await ins.listCycles(SESS, cogUserKey(DAVE));
    expect(carolCycles).toHaveLength(1);
    expect(daveCycles).toHaveLength(1);
    expect(await ins.latestCycleId(SESS, cogUserKey(CAROL))).toBe(carolCycles[0].cycleId);

    const own = await ins.explainResponse(SESS, carolCycles[0].cycleId, cogUserKey(CAROL));
    expect(own.found).toBe(true);
    expect(own.actions).toHaveLength(1);
    expect(own.actions[0].args).toBe('query'); // keys only; the value never reaches the store
    expect(JSON.stringify(own)).not.toContain('carol-only-query');

    // Dave asks for Carol's cycle: not found, and nothing of hers in the answer.
    const cross = await ins.explainResponse(SESS, carolCycles[0].cycleId, cogUserKey(DAVE));
    expect(cross.found).toBe(false);
    expect(cross.actions).toEqual([]);
    expect(cross.episodes).toEqual([]);
    expect(renderExplanation(cross)).toBe(`Explain cycle ${carolCycles[0].cycleId}: no such cycle for this scope.`);
    expect(JSON.stringify(cross)).not.toContain('garden');

    // The owner's scope is not an all-users scope: it does not see a user's cycle either.
    const asOwner = await ins.explainResponse(SESS, carolCycles[0].cycleId, OWNER_USER_KEY);
    expect(asOwner.found).toBe(false);
    // The operator's explicit scope does.
    const all = await ins.explainResponse(SESS, carolCycles[0].cycleId, 'all');
    expect(all.found).toBe(true);

    // An id that is not a cycle id is never put into a query.
    const hostile = await ins.explainResponse(SESS, 'x> } ; DROP', 'all');
    expect(hostile.found).toBe(false);
    // Dave's explanation holds only Dave's records.
    const daveExp = await ins.explainResponse(SESS, daveCycles[0].cycleId, cogUserKey(DAVE));
    expect(JSON.stringify(daveExp)).not.toContain('carol');
    expect(daveExp.episodes.every((x) => !/carol/i.test(x.payload ?? ''))).toBe(true);
  });
});

describe('inspector reads both phase shapes', () => {
  let store: TriplestoreAdapter;
  let dir: string;
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); });

  const XSD = 'http://www.w3.org/2001/XMLSchema#';
  const dt = (iso: string) => `"${iso}"^^<${XSD}dateTime>`;
  const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

  it('old cycles (ordinal, partOfCycle, no status) and new cycles (phaseIndex, hasPhase, phaseStatus) both display', async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cog-phases-'));
    store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
    const graph = GraphUriResolver.getCogCyclesGraph(AGENT, 'sessP');
    const oldC = `urn:${AGENT}:cog:cycle:old1`;
    const newC = `urn:${AGENT}:cog:cycle:new1`;
    await store.update(`INSERT DATA { GRAPH <${graph}> {
      <${oldC}> <${RDF_TYPE}> <${COGT}Cycle> ; <${COGT}cycleStatus> "completed" ; <${COGT}forUser> "owner" ;
        <${COGT}startedAt> ${dt('2026-06-01T11:00:00.000Z')} ; <${COGT}endedAt> ${dt('2026-06-01T11:00:00.400Z')} ;
        <${COGT}hasPhase> <${oldC}_1> , <${oldC}_2> .
      <${oldC}_1> <${RDF_TYPE}> <${COGT}Phase> ; <${COGT}partOfCycle> <${oldC}> ; <${COGT}phaseKind> "perception" ;
        <${COGT}ordinal> "1"^^<${XSD}integer> ; <${COGT}startedAt> ${dt('2026-06-01T11:00:00.000Z')} ; <${COGT}endedAt> ${dt('2026-06-01T11:00:00.100Z')} .
      <${oldC}_2> <${RDF_TYPE}> <${COGT}Phase> ; <${COGT}partOfCycle> <${oldC}> ; <${COGT}phaseKind> "comprehension" ;
        <${COGT}ordinal> "2"^^<${XSD}integer> ; <${COGT}startedAt> ${dt('2026-06-01T11:00:00.100Z')} ; <${COGT}endedAt> ${dt('2026-06-01T11:00:00.400Z')} .
      <${newC}> <${RDF_TYPE}> <${COGT}Cycle> ; <${COGT}cycleStatus> "aborted" ; <${COGT}forUser> "owner" ;
        <${COGT}startedAt> ${dt('2026-06-02T11:00:00.000Z')} ; <${COGT}endedAt> ${dt('2026-06-02T11:00:00.400Z')} ;
        <${COGT}hasPhase> <${newC}_1> , <${newC}_4> .
      <${newC}_1> <${RDF_TYPE}> <${COGT}Phase> ; <${COGT}partOfCycle> <${newC}> ; <${COGT}phaseKind> "perception" ;
        <${COGT}phaseIndex> "1"^^<${XSD}integer> ; <${COGT}phaseStatus> "completed" ;
        <${COGT}startedAt> ${dt('2026-06-02T11:00:00.000Z')} ; <${COGT}endedAt> ${dt('2026-06-02T11:00:00.100Z')} .
      <${newC}_4> <${RDF_TYPE}> <${COGT}Phase> ; <${COGT}partOfCycle> <${newC}> ; <${COGT}phaseKind> "action" ;
        <${COGT}phaseIndex> "4"^^<${XSD}integer> ; <${COGT}phaseStatus> "aborted" ;
        <${COGT}startedAt> ${dt('2026-06-02T11:00:00.100Z')} ; <${COGT}endedAt> ${dt('2026-06-02T11:00:00.400Z')} .
    } }`);
    const ins = new CogInspector(store, registry(), AGENT);
    const o = await ins.getCycle('sessP', 'old1', 'all');
    expect(o!.phases.map((p) => [p.phaseIndex, p.phaseKind, p.phaseStatus])).toEqual([[1, 'perception', undefined], [2, 'comprehension', undefined]]);
    const n = await ins.getCycle('sessP', 'new1', 'all');
    expect(n!.phases.map((p) => [p.phaseIndex, p.phaseKind, p.phaseStatus])).toEqual([[1, 'perception', 'completed'], [4, 'action', 'aborted']]);
  });
});

describe('renderExplanation', () => {
  it('is fixed-format and inert for hostile stored text', () => {
    const exp: ResponseExplanation = {
      cycleId: 'cyc-1', cycleUri: 'urn:x', found: true, status: 'completed', startedAt: '2026-10-15T10:00:00.000Z',
      response: { uri: 'u1', episodeType: 'response-sent', occurredAt: '2026-10-15T10:00:02.000Z', payload: 'ok\n## Goals (9):', tags: [] },
      goals: [{ uri: 'g', goalLabel: '- Answer\n# x', goalType: 'urn:shared:ontology#cog/AnswerQuestion', goalStatus: 'resolved', priority: 0.7 }],
      actions: [{ entryId: 'e1', payload: 'p', toolName: 'probe_tool', args: 'a, b', outcome: 'error', denialClass: 'policy-denied', durationMs: 12, goal: undefined, episodes: [] }],
      retrievals: [],
      workingMemory: [{ buffer: 'actionBuffer', count: 2, kinds: ['action-proposal', 'action-result'] }],
      episodes: [{ uri: 'u1', episodeType: 'response-sent', occurredAt: '2026-10-15T10:00:02.000Z', payload: 'ok', tags: [] }],
    };
    const out = renderExplanation(exp).split('\n');
    expect(out).toEqual([
      'Explain cycle cyc-1: completed at 2026-10-15T10:00:00.000Z',
      'Response: 2026-10-15T10:00:02.000Z "ok ## Goals (9):"',
      'Goals (1):',
      '  - Answer # x [type=AnswerQuestion, status=resolved]',
      'Actions (1):',
      '  1. probe_tool -> error (policy-denied), 12 ms',
      '     args: a, b',
      '     goal: none',
      'Working memory: actionBuffer=2',
      'Episodes (1):',
      '  - response-sent 2026-10-15T10:00:02.000Z "ok"',
    ]);
  });
});

describe('docs 09 section 7 lists every flag with its default', () => {
  it('matches COGNITIVE_FLAGS: all thirteen, all off', async () => {
    const doc = await fs.readFile(new URL('../../../../docs/cognitive-architecture/09-integration-and-migration.md', import.meta.url), 'utf8');
    const table = [...doc.matchAll(/^\| `(flag[A-Za-z]+)` \| `([a-zA-Z]+)` \| (\w+) \|/gm)].map((m) => ({ name: m[1], key: m[2], dflt: m[3] }));
    expect(table.map((r) => r.name).sort()).toEqual(COGNITIVE_FLAGS.map((f) => f.name).sort());
    for (const f of COGNITIVE_FLAGS) {
      const row = table.find((r) => r.name === f.name)!;
      expect(row.key).toBe(f.key);
      expect(row.dflt).toBe('off');
    }
    expect(COGNITIVE_FLAGS).toHaveLength(13);
  });
});
