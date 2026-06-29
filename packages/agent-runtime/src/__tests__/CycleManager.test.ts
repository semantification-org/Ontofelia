import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphRegistry, GraphUriResolver, ProceduralMemory, SelfModel } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter, MessageEnvelope } from '@ontofelia/core';
import { CycleManager } from '../cognitive/CycleManager.js';
import { CognitiveConfig } from '../cognitive/CognitiveConfig.js';

// Like the WorkingMemory suite, these need a real SPARQL backend, so they run
// against the embedded Oxigraph store rather than the SPARQL-less InMemoryAdapter.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/cm-test-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

function makeEnvelope(text: string, sessionId?: string): MessageEnvelope {
  return {
    id: 'msg1',
    channel: 'webchat',
    accountId: 'acc1',
    chatType: 'web',
    sender: { id: 'user:testuser', channelPrefix: 'webchat', isOwner: true },
    timestamp: new Date().toISOString(),
    text,
    mentions: [],
    attachments: [],
    routingHints: sessionId ? { sessionId } : undefined,
  };
}

describe('CycleManager', () => {
  let store: TriplestoreAdapter;
  let registry: GraphRegistry;
  let cm: CycleManager;

  beforeEach(async () => {
    store = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    cm = new CycleManager(store, registry, AGENT);
  });

  it('returns the core result unchanged and persists a completed cycle with 6 phases', async () => {
    const SESS = 'sessC1';
    const out = await cm.runCycle(
      makeEnvelope('hello world'),
      async () => ({ text: 'hi back', sessionId: SESS }),
      (r) => r.sessionId,
    );
    expect(out).toEqual({ text: 'hi back', sessionId: SESS });

    const cyclesGraph = GraphUriResolver.getCogCyclesGraph(AGENT, SESS);
    const cycles = await store.query(
      `SELECT ?c ?s WHERE { GRAPH <${cyclesGraph}> { ?c a <${COGT}Cycle> ; <${COGT}cycleStatus> ?s } }`,
    );
    expect(cycles.bindings).toHaveLength(1);
    expect(cycles.bindings![0].s.value).toBe('completed');

    const phases = await store.query(
      `SELECT ?p ?o WHERE { GRAPH <${cyclesGraph}> { ?p a <${COGT}Phase> ; <${COGT}ordinal> ?o } }`,
    );
    expect(phases.bindings).toHaveLength(6);
    const ordinals = phases.bindings!.map((b) => Number(b.o.value)).sort((a, b) => a - b);
    expect(ordinals).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('writes perception entries (message text + sender) into the cycle working graph', async () => {
    const SESS = 'sessC2';
    let cycleWorkingGraph = '';
    await cm.runCycle(
      makeEnvelope('what is oxigraph?'),
      async () => ({ text: 'a triplestore', sessionId: SESS }),
      (r) => r.sessionId,
    );

    // The working graph URI embeds the cycle id, which we don't know here; find it.
    const graphs = await store.query(
      `SELECT DISTINCT ?g WHERE { GRAPH ?g { ?e a <${COGT}WorkingMemoryEntry> } }`,
    );
    const working = graphs.bindings!.map((b) => b.g.value).find((g) => g.includes(`:working:${SESS}:`));
    expect(working).toBeTruthy();
    cycleWorkingGraph = working!;

    const entries = await store.query(
      `SELECT ?kind ?payload WHERE { GRAPH <${cycleWorkingGraph}> {
         ?e a <${COGT}WorkingMemoryEntry> ; <${COGT}entryKind> ?kind ; <${COGT}payload> ?payload } }`,
    );
    const byKind = Object.fromEntries(entries.bindings!.map((b) => [b.kind.value, b.payload.value]));
    expect(byKind['message-text']).toBe('what is oxigraph?');
    expect(byKind['sender-id']).toBe('user:testuser');
  });

  it('writes a reflective marker into cog:meta linked to the cycle', async () => {
    const SESS = 'sessC3';
    await cm.runCycle(
      makeEnvelope('reflect please'),
      async () => ({ text: 'done', sessionId: SESS }),
      (r) => r.sessionId,
    );
    const metaGraph = GraphUriResolver.getCogMetaGraph(AGENT);
    const markers = await store.query(
      `SELECT ?m ?c WHERE { GRAPH <${metaGraph}> {
         ?m a <${COGT}ReflectiveMarker> ; <${COGT}reflectsOn> ?c } }`,
    );
    expect(markers.bindings).toHaveLength(1);
    expect(markers.bindings![0].c.value).toContain(':cog:cycle:');
  });

  it('still returns when core throws, marks the cycle aborted, and re-throws', async () => {
    const SESS = 'sessC4';
    const boom = new Error('core exploded');
    await expect(
      cm.runCycle(
        makeEnvelope('trigger', SESS),
        async () => {
          throw boom;
        },
        (r: { sessionId: string }) => r.sessionId,
      ),
    ).rejects.toThrow('core exploded');

    // With no result the cycle falls back to the routing-hint session id.
    const cyclesGraph = GraphUriResolver.getCogCyclesGraph(AGENT, SESS);
    const cycles = await store.query(
      `SELECT ?s WHERE { GRAPH <${cyclesGraph}> { ?c a <${COGT}Cycle> ; <${COGT}cycleStatus> ?s } }`,
    );
    expect(cycles.bindings).toHaveLength(1);
    expect(cycles.bindings![0].s.value).toBe('aborted');
  });

  it('records message-received and response-sent episodes for a turn (C2/C3)', async () => {
    const SESS = 'sessC5';
    await cm.runCycle(
      makeEnvelope('hello there'),
      async () => ({ text: 'general kenobi', sessionId: SESS }),
      (r) => r.sessionId,
      (r) => r.text,
    );
    const ep = 'urn:ontofelia:cog:episodic';
    const rows = await store.query(
      `SELECT ?type ?payload WHERE { GRAPH <${ep}> {
         ?e a <${COGT}Episode> ; <${COGT}episodeType> ?type ; <${COGT}payload> ?payload } }`,
    );
    const byType = Object.fromEntries(rows.bindings!.map((b) => [b.type.value, b.payload.value]));
    expect(byType['message-received']).toBe('hello there');
    expect(byType['response-sent']).toBe('general kenobi');
  });

  it('Phase 2 pulls a matching prior episode into the retrieval buffer (C4)', async () => {
    const SESS = 'sessC6';
    // Turn 1 establishes a topic.
    await cm.runCycle(
      makeEnvelope('oxigraph is the embedded triplestore'),
      async () => ({ text: 'noted', sessionId: SESS }),
      (r) => r.sessionId,
      (r) => r.text,
    );
    // Turn 2 references it; its retrieval buffer should surface turn 1.
    const secondCycleId = '';
    await cm.runCycle(
      makeEnvelope('remind me about oxigraph'),
      async () => ({ text: 'it is the triplestore', sessionId: SESS }),
      (r) => r.sessionId,
      (r) => r.text,
    );

    // Find the second cycle's working graph and inspect its retrieval buffer.
    const graphs = await store.query(
      `SELECT DISTINCT ?g WHERE { GRAPH ?g {
         ?e <${COGT}writtenTo> "retrievalBuffer" } }`,
    );
    expect(graphs.bindings!.length).toBeGreaterThan(0);
    const retr = await store.query(
      `SELECT ?payload ?score ?src WHERE { GRAPH ?g {
         ?e <${COGT}writtenTo> "retrievalBuffer" ;
            <${COGT}payload> ?payload ;
            <${COGT}retrievalScore> ?score ;
            <${COGT}sourceGraph> ?src } }`,
    );
    expect(retr.bindings!.length).toBeGreaterThan(0);
    expect(retr.bindings!.some((b) => b.payload.value.includes('oxigraph'))).toBe(true);
    expect(retr.bindings!.every((b) => b.src.value === 'urn:ontofelia:cog:episodic')).toBe(true);
    void secondCycleId;
  });

  it('records tool-called/tool-completed episodes when core emits tool events (C3)', async () => {
    const SESS = 'sessC7';
    await cm.runCycle(
      makeEnvelope('use a tool please'),
      async (recordTool) => {
        const t0 = new Date();
        recordTool({
          phase: 'called',
          toolName: 'searchKb',
          callId: 'call-1',
          occurredAt: t0,
          argsBrief: 'query',
        });
        recordTool({
          phase: 'completed',
          toolName: 'searchKb',
          callId: 'call-1',
          occurredAt: new Date(),
          outcome: 'success',
          durationMs: 12,
        });
        return { text: 'tool ran', sessionId: SESS };
      },
      (r) => r.sessionId,
      (r) => r.text,
    );

    const ep = 'urn:ontofelia:cog:episodic';
    const rows = await store.query(
      `SELECT ?type ?payload WHERE { GRAPH <${ep}> {
         ?e a <${COGT}Episode> ; <${COGT}episodeType> ?type ; <${COGT}payload> ?payload } }`,
    );
    const types = rows.bindings!.map((b) => b.type.value);
    expect(types).toContain('tool-called');
    expect(types).toContain('tool-completed');
    const called = rows.bindings!.find((b) => b.type.value === 'tool-called');
    expect(called!.payload.value).toContain('searchKb');
  });

  it('Phase 3/4/5: manages a goal, exposes [Active goal], backfills partOfGoal (D2-D4)', async () => {
    const SESS = 'sessC8';
    let goalSection: string | undefined;
    await cm.runCycle(
      makeEnvelope('what is oxigraph?'),
      async (_rt, prepareGoals) => {
        goalSection = await prepareGoals(SESS);
        return { text: 'a triplestore', sessionId: SESS };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { goalsEnabled: true },
    );

    // Phase 4 — an [Active goal] prompt section was produced for the question.
    expect(goalSection).toBeTruthy();
    expect(goalSection).toContain('[Active goal]');
    expect(goalSection).toContain('AnswerQuestion');

    // Phase 3 — exactly one goal was pushed into the session goals graph.
    const goalsGraph = `urn:${AGENT}:cog:goals:${SESS}`;
    const goals = await store.query(
      `SELECT ?g ?label WHERE { GRAPH <${goalsGraph}> {
         ?g a <${COGT}Goal> ; <${COGT}goalLabel> ?label } }`,
    );
    expect(goals.bindings).toHaveLength(1);

    // Phase 5 — both turn episodes are backfilled with cogt:partOfGoal.
    const ep = 'urn:ontofelia:cog:episodic';
    const rows = await store.query(
      `SELECT ?type ?goal WHERE { GRAPH <${ep}> {
         ?e a <${COGT}Episode> ; <${COGT}episodeType> ?type ; <${COGT}partOfGoal> ?goal } }`,
    );
    const types = rows.bindings!.map((b) => b.type.value);
    expect(types).toContain('message-received');
    expect(types).toContain('response-sent');
    expect(rows.bindings!.every((b) => b.goal.value === goals.bindings![0].g.value)).toBe(true);
  });

  it('continues an existing substantive goal instead of pushing a duplicate', async () => {
    const SESS = 'sessC8b';
    const core =
      (text: string) =>
      async (_rt: unknown, prepareGoals: (s: string) => Promise<string | undefined>) => {
        await prepareGoals(SESS);
        return { text, sessionId: SESS };
      };
    await cm.runCycle(makeEnvelope('what is oxigraph?'), core('a'), (r) => r.sessionId, (r) => r.text, {
      goalsEnabled: true,
    });
    await cm.runCycle(makeEnvelope('and how fast is it?'), core('b'), (r) => r.sessionId, (r) => r.text, {
      goalsEnabled: true,
    });
    const goalsGraph = `urn:${AGENT}:cog:goals:${SESS}`;
    const goals = await store.query(
      `SELECT ?g WHERE { GRAPH <${goalsGraph}> { ?g a <${COGT}Goal> } }`,
    );
    expect(goals.bindings).toHaveLength(1); // second turn continued the first goal
  });

  it('goal stack stays dormant when goalsEnabled is false (flag OFF)', async () => {
    const SESS = 'sessC9';
    let section: string | undefined = 'sentinel';
    await cm.runCycle(
      makeEnvelope('what is oxigraph?'),
      async (_rt, prepareGoals) => {
        section = await prepareGoals(SESS);
        return { text: 'a triplestore', sessionId: SESS };
      },
      (r) => r.sessionId,
      (r) => r.text,
    );
    expect(section).toBeUndefined();
    const goalsGraph = `urn:${AGENT}:cog:goals:${SESS}`;
    const goals = await store.query(
      `SELECT ?g WHERE { GRAPH <${goalsGraph}> { ?g a <${COGT}Goal> } }`,
    );
    expect(goals.bindings).toHaveLength(0);
  });

  it('writes one redacted SkillTrace per tool call when proceduralEnabled (E2)', async () => {
    const SESS = 'sessE2';
    await cm.runCycle(
      makeEnvelope('what is oxigraph?'),
      async (recordTool, prepareGoals) => {
        await prepareGoals(SESS); // establish an active goal for forGoalType
        recordTool({
          phase: 'called',
          toolName: 'searchKb',
          callId: 'c1',
          occurredAt: new Date(),
          argsBrief: 'query, limit',
        });
        recordTool({
          phase: 'completed',
          toolName: 'searchKb',
          callId: 'c1',
          occurredAt: new Date(),
          outcome: 'success',
          durationMs: 9,
        });
        recordTool({
          phase: 'called',
          toolName: 'fsRead',
          callId: 'c2',
          occurredAt: new Date(),
          argsBrief: 'path',
        });
        recordTool({
          phase: 'completed',
          toolName: 'fsRead',
          callId: 'c2',
          occurredAt: new Date(),
          outcome: 'error',
          durationMs: 3,
          errorClass: 'NotFound',
        });
        return { text: 'a triplestore', sessionId: SESS };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { goalsEnabled: true, proceduralEnabled: true },
    );

    const proc = `urn:${AGENT}:cog:procedural`;
    const rows = await store.query(
      `SELECT ?t ?tool ?brief ?hash ?out ?pos ?gt WHERE { GRAPH <${proc}> {
         ?t a <${COGT}SkillTrace> ;
            <${COGT}toolName>      ?tool ;
            <${COGT}toolArgsBrief> ?brief ;
            <${COGT}toolArgsHash>  ?hash ;
            <${COGT}outcome>       ?out ;
            <${COGT}sequencePos>   ?pos .
         OPTIONAL { ?t <${COGT}forGoalType> ?gt . } } }`,
    );
    expect(rows.bindings).toHaveLength(2);
    const byTool = Object.fromEntries(rows.bindings!.map((b) => [b.tool.value, b]));
    expect(byTool['searchKb'].out.value).toBe('success');
    expect(byTool['fsRead'].out.value).toBe('error');
    // Redaction: brief is keys-only (no values), hash is non-empty.
    expect(byTool['searchKb'].brief.value).toBe('query, limit');
    expect(byTool['searchKb'].hash.value).toMatch(/^[0-9a-f]{8}$/);
    // forGoalType is the active goal's type (AnswerQuestion).
    expect(byTool['searchKb'].gt.value).toContain('AnswerQuestion');
    // sequencePos covers both calls.
    const positions = rows.bindings!.map((b) => Number(b.pos.value)).sort();
    expect(positions).toEqual([1, 2]);
  });

  it('writes no SkillTrace when proceduralEnabled is false (flag OFF)', async () => {
    const SESS = 'sessE2off';
    await cm.runCycle(
      makeEnvelope('use a tool'),
      async (recordTool) => {
        recordTool({ phase: 'called', toolName: 'searchKb', callId: 'c1', occurredAt: new Date(), argsBrief: 'q' });
        recordTool({ phase: 'completed', toolName: 'searchKb', callId: 'c1', occurredAt: new Date(), outcome: 'success', durationMs: 5 });
        return { text: 'ok', sessionId: SESS };
      },
      (r) => r.sessionId,
      (r) => r.text,
    );
    const proc = `urn:${AGENT}:cog:procedural`;
    const rows = await store.query(
      `SELECT ?t WHERE { GRAPH <${proc}> { ?t a <${COGT}SkillTrace> } }`,
    );
    expect(rows.bindings).toHaveLength(0);
  });

  it('backfills userSatisfied onto the prior cycle traces from the next message (E3)', async () => {
    const SESS = 'sessE3';
    const toolTurn =
      (text: string) =>
      async (
        recordTool: (e: import('../cognitive/CycleManager.js').ToolEpisodeEvent) => void,
        prepareGoals: (s: string) => Promise<string | undefined>,
      ): Promise<{ text: string; sessionId: string }> => {
        await prepareGoals(SESS);
        recordTool({ phase: 'called', toolName: 'searchKb', callId: 'c1', occurredAt: new Date(), argsBrief: 'q' });
        recordTool({ phase: 'completed', toolName: 'searchKb', callId: 'c1', occurredAt: new Date(), outcome: 'success', durationMs: 5 });
        return { text, sessionId: SESS };
      };

    // Turn 1: a tool runs (one trace, no satisfaction yet).
    await cm.runCycle(makeEnvelope('what is oxigraph?'), toolTurn('a triplestore'), (r) => r.sessionId, (r) => r.text, {
      goalsEnabled: true,
      proceduralEnabled: true,
    });
    // Turn 2: user says thanks -> turn 1's trace is marked satisfied.
    await cm.runCycle(makeEnvelope('perfect, thanks!'), toolTurn('you are welcome'), (r) => r.sessionId, (r) => r.text, {
      goalsEnabled: true,
      proceduralEnabled: true,
    });

    const proc = `urn:${AGENT}:cog:procedural`;
    const sat = await store.query(
      `SELECT ?t ?v WHERE { GRAPH <${proc}> {
         ?t a <${COGT}SkillTrace> ; <${COGT}userSatisfied> ?v } }`,
    );
    // Exactly the first turn's trace got the signal; turn 2's is still unjudged.
    expect(sat.bindings).toHaveLength(1);
    expect(sat.bindings![0].v.value).toBe('true');
  });

  it('surfaces learned skills into the retrieval buffer and prompt (E4)', async () => {
    const SESS = 'sessE4';
    // Seed a consolidated skill for AnswerQuestion so suggestions exist.
    const pm = new ProceduralMemory(store, AGENT);
    for (let i = 0; i < 3; i++) {
      const uri = await pm.recordTrace({
        toolName: 'searchKb',
        toolArgsHash: 'h',
        toolArgsBrief: 'query',
        executedAt: new Date(),
        durationMs: 20,
        outcome: 'success',
        forGoalType: `${COGT}AnswerQuestion`,
        sequencePos: 1,
      });
      await pm.backfillSatisfaction(uri, true);
    }
    await pm.consolidate({ since: new Date(0), until: new Date(Date.now() + 1000) });

    let section: string | undefined;
    await cm.runCycle(
      makeEnvelope('what is oxigraph?'),
      async (_rt, prepareGoals) => {
        section = await prepareGoals(SESS);
        return { text: 'a triplestore', sessionId: SESS };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { goalsEnabled: true, proceduralEnabled: true },
    );

    // The prompt section carries the [Skills that worked] block.
    expect(section).toContain('[Skills that worked');
    expect(section).toContain('searchKb');

    // And a skill-suggestion entry landed in a retrieval buffer with a score.
    const suggestions = await store.query(
      `SELECT ?payload ?score ?ref WHERE { GRAPH ?g {
         ?e <${COGT}entryKind> "skill-suggestion" ;
            <${COGT}payload> ?payload ;
            <${COGT}retrievalScore> ?score ;
            <${COGT}refersTo> ?ref } }`,
    );
    expect(suggestions.bindings!.length).toBeGreaterThan(0);
    expect(suggestions.bindings!.some((b) => b.payload.value === 'searchKb')).toBe(true);
  });

  it('surfaces no skill suggestions when proceduralEnabled is false (E4 flag OFF)', async () => {
    const SESS = 'sessE4off';
    const pm = new ProceduralMemory(store, AGENT);
    for (let i = 0; i < 3; i++) {
      await pm.recordTrace({
        toolName: 'searchKb',
        toolArgsHash: 'h',
        toolArgsBrief: 'query',
        executedAt: new Date(),
        durationMs: 20,
        outcome: 'success',
        forGoalType: `${COGT}AnswerQuestion`,
        sequencePos: 1,
      });
    }
    await pm.consolidate({ since: new Date(0), until: new Date(Date.now() + 1000) });

    let section: string | undefined;
    await cm.runCycle(
      makeEnvelope('what is oxigraph?'),
      async (_rt, prepareGoals) => {
        section = await prepareGoals(SESS);
        return { text: 'a triplestore', sessionId: SESS };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { goalsEnabled: true, proceduralEnabled: false },
    );
    expect(section).not.toContain('[Skills that worked');
    const suggestions = await store.query(
      `SELECT ?e WHERE { GRAPH ?g { ?e <${COGT}entryKind> "skill-suggestion" } }`,
    );
    expect(suggestions.bindings).toHaveLength(0);
  });

  it('surfaces the [Self] block from the self-model in Phase 4 (G2)', async () => {
    const SESS = 'sessG2';
    const sm = new SelfModel(store, AGENT);
    await sm.seed({
      capabilities: [
        { id: 'answer', label: 'Answer questions', requires: ['searchKb'], relevantToGoalType: [`${COGT}AnswerQuestion`] },
        { id: 'doc', label: 'Write docs', relevantToGoalType: [`${COGT}WriteConceptDoc`] },
      ],
      constraints: [{ id: 'no_secret', label: 'Never persist secrets', applies: ['memory_store'], enforcedBy: 'MemorySkill' }],
    });

    let section: string | undefined;
    await cm.runCycle(
      makeEnvelope('what is oxigraph?'),
      async (_rt, prepareGoals) => {
        section = await prepareGoals(SESS);
        return { text: 'a triplestore', sessionId: SESS };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { goalsEnabled: true, selfModelEnabled: true },
    );

    expect(section).toContain('[Self]');
    expect(section).toContain('Answer questions');
    expect(section).toContain('Never persist secrets');
    // A capability scoped to a different goal type is not surfaced here.
    expect(section).not.toContain('Write docs');
  });

  it('adds no [Self] block when selfModelEnabled is false (G2 flag OFF)', async () => {
    const SESS = 'sessG2off';
    const sm = new SelfModel(store, AGENT);
    await sm.seed({ capabilities: [{ id: 'answer', label: 'Answer questions', relevantToGoalType: [`${COGT}AnswerQuestion`] }] });

    let section: string | undefined;
    await cm.runCycle(
      makeEnvelope('what is oxigraph?'),
      async (_rt, prepareGoals) => {
        section = await prepareGoals(SESS);
        return { text: 'ok', sessionId: SESS };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { goalsEnabled: true, selfModelEnabled: false },
    );
    expect(section).not.toContain('[Self]');
  });

  it('attributes constraint pressure from a governed tool error (G3)', async () => {
    const SESS = 'sessG3';
    const sm = new SelfModel(store, AGENT);
    // A constraint governs memory_store; an error there is constraint pressure
    // even though the error class is not a policy/permission string.
    await sm.seed({ constraints: [{ id: 'no_secret', label: 'Never persist secrets', applies: ['memory_store'], enforcedBy: 'MemorySkill' }] });

    await cm.runCycle(
      makeEnvelope('remember this'),
      async (recordTool) => {
        recordTool({ phase: 'called', toolName: 'memory_store', callId: 'c1', occurredAt: new Date(), argsBrief: 'key' });
        recordTool({ phase: 'completed', toolName: 'memory_store', callId: 'c1', occurredAt: new Date(), outcome: 'error', errorClass: 'ValidationError' });
        return { text: 'tried', sessionId: SESS };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { metacognitionEnabled: true, selfModelEnabled: true },
    );

    const metaGraph = GraphUriResolver.getCogMetaGraph(AGENT);
    const marker = await store.query(
      `SELECT ?p WHERE { GRAPH <${metaGraph}> {
         ?m a <${COGT}ReflectiveMarker> ; <${COGT}constraintPressure> ?p } }`,
    );
    expect(marker.bindings?.[0]?.p.value).toBe('1');
  });

  it('flags + resolves a tool-error impasse and writes the full marker (F2/F3/F4)', async () => {
    const SESS = 'sessF1';
    await cm.runCycle(
      makeEnvelope('do the thing'),
      async (recordTool) => {
        recordTool({ phase: 'called', toolName: 'fs_read', callId: 'c1', occurredAt: new Date(), argsBrief: 'path' });
        recordTool({
          phase: 'completed',
          toolName: 'fs_read',
          callId: 'c1',
          occurredAt: new Date(),
          outcome: 'error',
          durationMs: 3,
          errorClass: 'ENOENT',
        });
        return { text: 'tried', sessionId: SESS };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { metacognitionEnabled: true },
    );

    const metaGraph = GraphUriResolver.getCogMetaGraph(AGENT);
    const imp = await store.query(
      `SELECT ?i ?kind ?res ?by WHERE { GRAPH <${metaGraph}> {
         ?i a <${COGT}Impasse> ; <${COGT}impasseKind> ?kind ;
            <${COGT}resolution> ?res ; <${COGT}resolvedBy> ?by } }`,
    );
    expect((imp.bindings ?? []).length).toBe(1);
    expect(imp.bindings?.[0]?.kind.value).toBe('tool-error');
    expect(imp.bindings?.[0]?.res.value).toBe('retry');
    expect(imp.bindings?.[0]?.by.value).toBe('metacog');

    const marker = await store.query(
      `SELECT ?status ?errors ?flagged WHERE { GRAPH <${metaGraph}> {
         ?m a <${COGT}ReflectiveMarker> ; <${COGT}cycleStatus> ?status ;
            <${COGT}toolErrors> ?errors ; <${COGT}flaggedImpasse> ?flagged } }`,
    );
    expect(marker.bindings?.[0]?.status.value).toBe('impasse-resolved');
    expect(marker.bindings?.[0]?.errors.value).toBe('1');
  });

  it('flags an action-selection-empty impasse when core does nothing (F2)', async () => {
    await cm.runCycle(
      makeEnvelope('hello?'),
      async () => ({ text: '', sessionId: 'sessF2' }),
      (r) => r.sessionId,
      (r) => r.text,
      { metacognitionEnabled: true },
    );
    const metaGraph = GraphUriResolver.getCogMetaGraph(AGENT);
    const imp = await store.query(
      `SELECT ?kind WHERE { GRAPH <${metaGraph}> {
         ?i a <${COGT}Impasse> ; <${COGT}impasseKind> ?kind } }`,
    );
    expect(imp.bindings?.[0]?.kind.value).toBe('action-selection-empty');
  });

  it('raises no impasse and writes the minimal marker when metacognition is OFF', async () => {
    await cm.runCycle(
      makeEnvelope('do the thing'),
      async (recordTool) => {
        recordTool({ phase: 'called', toolName: 'fs_read', callId: 'c1', occurredAt: new Date(), argsBrief: 'path' });
        recordTool({
          phase: 'completed',
          toolName: 'fs_read',
          callId: 'c1',
          occurredAt: new Date(),
          outcome: 'error',
          errorClass: 'ENOENT',
        });
        return { text: 'tried', sessionId: 'sessF3' };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { metacognitionEnabled: false },
    );
    const metaGraph = GraphUriResolver.getCogMetaGraph(AGENT);
    const imp = await store.query(
      `SELECT ?i WHERE { GRAPH <${metaGraph}> { ?i a <${COGT}Impasse> } }`,
    );
    expect((imp.bindings ?? []).length).toBe(0);
    // The minimal Phase B marker carries cogt:noted but no cogt:cycleStatus.
    const marker = await store.query(
      `SELECT ?m ?status WHERE { GRAPH <${metaGraph}> {
         ?m a <${COGT}ReflectiveMarker> ; <${COGT}noted> ?n .
         OPTIONAL { ?m <${COGT}cycleStatus> ?status } } }`,
    );
    expect((marker.bindings ?? []).length).toBe(1);
    expect(marker.bindings?.[0]?.status).toBeUndefined();
  });

  it('a cognitive-write failure never breaks the user response', async () => {
    // An agent the registry does not know — assertWritable throws on every cog
    // graph, so persistence fails, but runCycle must still return the result.
    const rogue = new CycleManager(store, GraphRegistry.create(['someoneelse']), AGENT);
    const out = await rogue.runCycle(
      makeEnvelope('hi'),
      async () => ({ text: 'ok', sessionId: 'sX' }),
      (r) => r.sessionId,
    );
    expect(out.text).toBe('ok');
  });
});

describe('CognitiveConfig', () => {
  let store: TriplestoreAdapter;
  let cfg: CognitiveConfig;

  beforeEach(async () => {
    store = await makeStore();
    cfg = new CognitiveConfig(store, AGENT);
  });

  it('defaults to OFF when the flag is unseeded', async () => {
    expect(await cfg.isCycleManagerEnabled()).toBe(false);
  });

  it('round-trips the flag and reflects runtime toggles', async () => {
    await cfg.setCycleManagerEnabled(true);
    expect(await cfg.isCycleManagerEnabled()).toBe(true);
    await cfg.setCycleManagerEnabled(false);
    expect(await cfg.isCycleManagerEnabled()).toBe(false);
  });
});
