import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GraphRegistry, EpisodicMemory, ProceduralMemory } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { CycleManager } from '../cognitive/CycleManager.js';
import { WorkingMemory } from '../cognitive/WorkingMemory.js';
import { GoalStack, GOAL_TYPES } from '../cognitive/GoalStack.js';
import { Metacognition } from '../cognitive/Metacognition.js';
import {
  AGENT, ALL_ON, ZOE, aboutSource, canonicalQuads, dumpQuads, envelope, fact, makeStore, runScenario, toolRun,
  type ScenarioTurn,
} from './persistScenario.js';

// The queued persist writes the records of a turn in waves of independent
// writes that share one flush (see CycleManager.persist). These tests show that
// this changes how often the store is dumped and nothing about what it holds:
//  - the stored quads of a scripted sequence equal a reference taken from the
//    sequential persist (fixtures/persist-scenario.golden.txt, produced by
//    running the same script on the code before the change);
//  - the dumps of one turn with every flag on stay at or below three;
//  - a failing write is reported on its own and does not take the others with it;
//  - the persist promise resolves only when everything is on disk.

const COGT = 'urn:shared:ontology#cog/';
const GOLDEN = path.join(path.dirname(new URL(import.meta.url).pathname), 'fixtures', 'persist-scenario.golden.txt');

interface Spy {
  dumps: number;
  updates: string[];
}

/** Count the dumps of the embedded store (every flush is one full serialisation). */
function spyOnDumps(store: TriplestoreAdapter): Spy {
  const raw = (store as unknown as { store: { dump: (...a: unknown[]) => string } }).store;
  const orig = raw.dump.bind(raw);
  const spy: Spy = { dumps: 0, updates: [] };
  raw.dump = (...a: unknown[]) => {
    spy.dumps++;
    return orig(...a);
  };
  return spy;
}

/** A store whose updates can be counted and failed on demand. */
function instrument(store: TriplestoreAdapter, failOn?: (sparql: string) => boolean): { store: TriplestoreAdapter; updates: string[] } {
  const updates: string[] = [];
  const wrapped = new Proxy(store, {
    get(target, prop, recv) {
      if (prop === 'update') {
        return async (sparql: string) => {
          updates.push(sparql);
          if (failOn?.(sparql)) throw new Error('write refused');
          await target.update(sparql);
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  }) as TriplestoreAdapter;
  return { store: wrapped, updates };
}

describe('persist waves: the stored data does not change', () => {
  it('the scripted sequence stores the same quads as the sequential persist did', async () => {
    const errors: unknown[] = [];
    const store = await makeStore();
    await runScenario(store, (e) => errors.push(e));
    expect(errors).toEqual([]);
    const actual = canonicalQuads(dumpQuads(store));
    const expected = (await fs.readFile(GOLDEN, 'utf-8')).split('\n').filter((l) => l !== '');
    expect(actual.length).toBe(expected.length);
    // A readable first difference instead of a 3000-line diff.
    const firstDiff = actual.findIndex((l, i) => l !== expected[i]);
    expect(firstDiff === -1 ? 'identical' : `line ${firstDiff}: ${actual[firstDiff]} <> ${expected[firstDiff]}`).toBe('identical');
  });

  it('positive control: the comparison sees a changed chain, a missing quad and a changed link', async () => {
    const mk = async (swap: boolean): Promise<string[]> => {
      const store = await makeStore();
      const em = new EpisodicMemory(store, AGENT);
      const a = { episodeType: 'message-received' as const, sessionId: 's', payload: 'first', occurredAt: new Date('2026-10-01T10:00:00Z') };
      const b = { episodeType: 'response-sent' as const, sessionId: 's', payload: 'second', occurredAt: new Date('2026-10-01T10:00:00Z') };
      for (const ep of swap ? [b, a] : [a, b]) await em.append(ep);
      return canonicalQuads(dumpQuads(store));
    };
    const normal = await mk(false);
    expect(await mk(false)).toEqual(normal); // generated ids do not matter
    expect(await mk(true)).not.toEqual(normal); // the order of the chain does
    expect(normal.slice(1)).not.toEqual(normal); // a missing quad does
    // The same two episodes with a different link: the neighbourhood labels differ.
    const linked = normal.map((l) => l.replace(/precededBy> <gen:[0-9a-f]+>/, 'precededBy> <gen:0>'));
    expect(linked).not.toEqual(normal);
  });

  it('a batch of episodes equals the same episodes appended one by one', async () => {
    const inputs = [
      { episodeType: 'goal-pushed' as const, sessionId: 's1', payload: 'g', occurredAt: new Date('2026-10-01T10:00:05Z'), forUser: 'alice' },
      { episodeType: 'message-received' as const, sessionId: 's1', payload: 'm', occurredAt: new Date('2026-10-01T10:00:01Z'), forUser: 'alice', about: [ZOE] },
      { episodeType: 'tool-called' as const, sessionId: 's2', payload: 't', occurredAt: new Date('2026-10-01T10:00:02Z'), tags: ['c1'] },
      { episodeType: 'response-sent' as const, sessionId: 's1', payload: 'r', occurredAt: new Date('2026-10-01T10:00:09Z') },
      { episodeType: 'meta-reflected' as const, payload: 'no session', occurredAt: new Date('2026-10-01T10:00:10Z') },
      { episodeType: 'tool-completed' as const, sessionId: 's2', payload: 'u', occurredAt: new Date('2026-10-01T10:00:03Z'), precededBy: 'urn:x:explicit' },
    ];
    const seq = await makeStore();
    const batch = await makeStore();
    // Both stores already hold two episodes of session s1.
    for (const s of [seq, batch]) {
      const em = new EpisodicMemory(s, AGENT);
      await em.append({ episodeType: 'message-received', sessionId: 's1', payload: 'old1', occurredAt: new Date('2026-10-01T09:00:00Z') });
      await em.append({ episodeType: 'response-sent', sessionId: 's1', payload: 'old2', occurredAt: new Date('2026-10-01T09:00:01Z') });
    }
    const emSeq = new EpisodicMemory(seq, AGENT);
    for (const ep of inputs) await emSeq.append(ep);
    const { commit, uris } = await new EpisodicMemory(batch, AGENT).prepareAppendMany(inputs);
    expect(uris).toHaveLength(inputs.length);
    await commit();
    expect(canonicalQuads(dumpQuads(batch))).toEqual(canonicalQuads(dumpQuads(seq)));
  });

  it('a batch whose combined update fails stores the episodes one by one and reports the one that fails', async () => {
    const raw = await makeStore();
    const { store } = instrument(raw, (q) => q.includes('"doomed"'));
    const errors: unknown[] = [];
    const inputs = ['fine1', 'doomed', 'fine2'].map((p, i) => ({
      episodeType: 'tool-called' as const, sessionId: 's', payload: p, occurredAt: new Date(`2026-10-01T10:00:0${i}Z`),
    }));
    const { commit } = await new EpisodicMemory(store, AGENT).prepareAppendMany(inputs, (e) => errors.push(e));
    await commit();
    expect(errors).toHaveLength(1);
    const res = await raw.query(`SELECT ?p WHERE { GRAPH ?g { ?e <${COGT}payload> ?p } }`);
    expect((res.bindings ?? []).map((b) => b.p.value).sort()).toEqual(['fine1', 'fine2']);
  });
});

describe('persist waves: dumps per turn', () => {
  it('a turn with every flag on is dumped at most three times, turn after turn', async () => {
    const store = await makeStore();
    const spy = spyOnDumps(store);
    const errors: unknown[] = [];
    const registry = GraphRegistry.create([AGENT]);
    const cm = new CycleManager(store, registry, AGENT, (e) => errors.push(e), { awaitPersist: true });
    const per: number[] = [];
    // Only the queued persist is counted: the writes of the hooks (the inbound episode, the goal
    // stack) happen while the core runs, before the reply, and are not part of it.
    let atCoreEnd = 0;
    for (let i = 0; i < 6; i++) {
      await cm.runCycle(
        envelope(i === 3 ? 'thanks, that was great' : `what is item ${i}?`),
        async (recordTool, prepareGoals, recordInbound, perceive, comprehendHook) => {
          perceive(aboutSource([ZOE]));
          await comprehendHook('sess-dumps');
          await prepareGoals('sess-dumps');
          await recordInbound('sess-dumps');
          for (const ev of [...toolRun('lookup', 'success'), ...toolRun('fetch', 'success')]) recordTool(ev);
          atCoreEnd = spy.dumps;
          return { text: 'ok', sessionId: 'sess-dumps' };
        },
        (r) => r.sessionId,
        (r) => r.text,
        { ...ALL_ON, promptMode: 'shadow', entityFacts: async () => [fact('worldview')] },
      );
      await cm.flushPending();
      per.push(spy.dumps - atCoreEnd);
    }
    expect(errors).toEqual([]);
    console.log(`dumps per turn (all flags on, 6 turns of one session): ${per.join(',')}`);
    for (const [i, n] of per.entries()) {
      expect(n, `turn ${i}`).toBeLessThanOrEqual(3);
    }
  });

  it('a turn with metacognition and attention off is dumped at most twice', async () => {
    const store = await makeStore();
    const spy = spyOnDumps(store);
    const cm = new CycleManager(store, GraphRegistry.create([AGENT]), AGENT, undefined, { awaitPersist: true });
    let atCoreEnd = 0;
    for (let i = 0; i < 3; i++) {
      await cm.runCycle(
        envelope(`hello ${i}`),
        async (_t, prepareGoals, recordInbound, perceive) => {
          perceive(aboutSource([]));
          await prepareGoals('sess-min');
          await recordInbound('sess-min');
          atCoreEnd = spy.dumps;
          return { text: 'ok', sessionId: 'sess-min' };
        },
        (r) => r.sessionId,
        (r) => r.text,
        { episodicEnabled: true, goalsEnabled: true },
      );
      await cm.flushPending();
      expect(spy.dumps - atCoreEnd, `turn ${i}`).toBeLessThanOrEqual(2);
    }
  });
});

describe('persist waves: a failing write', () => {
  async function oneTurn(failOn?: (sparql: string) => boolean) {
    const raw = await makeStore();
    const { store, updates } = instrument(raw, failOn);
    const errors: Error[] = [];
    const cm = new CycleManager(store, GraphRegistry.create([AGENT]), AGENT, (e) => errors.push(e as Error), { awaitPersist: true });
    await cm.runCycle(
      envelope('who is Zoe?'),
      async (recordTool, prepareGoals, recordInbound, perceive, comprehendHook) => {
        perceive(aboutSource([ZOE]));
        await comprehendHook('sess-fail');
        await prepareGoals('sess-fail');
        await recordInbound('sess-fail');
        for (const ev of toolRun('lookup', 'success')) recordTool(ev);
        return { text: 'ok', sessionId: 'sess-fail' };
      },
      (r) => r.sessionId,
      (r) => r.text,
      { ...ALL_ON, entityFacts: async () => [fact('worldview')] },
    );
    await cm.flushPending();
    const count = async (type: string) =>
      ((await raw.query(`SELECT ?s WHERE { GRAPH ?g { ?s a <${COGT}${type}> } }`)).bindings ?? []).length;
    const episodes = async (type: string) =>
      ((await raw.query(`SELECT ?s WHERE { GRAPH ?g { ?s <${COGT}episodeType> "${type}" } }`)).bindings ?? []).length;
    return {
      errors,
      updates,
      markers: await count('ReflectiveMarker'),
      cycles: await count('Cycle'),
      wm: await count('WorkingMemoryEntry'),
      traces: await count('SkillTrace'),
      responses: await episodes('response-sent'),
      toolEps: await episodes('tool-called'),
      reflected: await episodes('meta-reflected'),
    };
  }

  it('baseline: nothing fails, nothing is reported, every record is stored', async () => {
    const r = await oneTurn();
    expect(r.errors).toEqual([]);
    expect(r).toMatchObject({ markers: 1, cycles: 1, traces: 1, responses: 1, toolEps: 1, reflected: 1 });
    expect(r.wm).toBeGreaterThan(3);
  });

  it.each([
    ['the reflective marker', (q: string) => q.includes('ReflectiveMarker'), { markers: 0 }],
    ['the cycle record', (q: string) => q.includes(`${COGT}Cycle>`), { cycles: 0 }],
    ['the skill traces', (q: string) => q.includes('SkillTrace'), { traces: 0 }],
    ['one working-memory group (retrieval buffer)', (q: string) => q.includes('"retrievalBuffer"'), {}],
    ['the working-memory perception group', (q: string) => q.includes('"perceptionBuffer"'), {}],
  ])('%s: reported once, every other record is stored', async (_name, failOn, lost) => {
    const base = await oneTurn();
    const r = await oneTurn(failOn);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toContain('write refused');
    const expected = { ...base, ...lost };
    for (const k of ['markers', 'cycles', 'traces', 'responses', 'toolEps', 'reflected'] as const) {
      expect(r[k], k).toBe(expected[k]);
    }
    if (_name.startsWith('one working') || _name.includes('perception')) expect(r.wm).toBeLessThan(base.wm);
    else expect(r.wm).toBe(base.wm);
  });

  it('one failing episode is reported on its own; the other episodes of the turn are stored', async () => {
    const base = await oneTurn();
    const r = await oneTurn((q) => q.includes('"response-sent"'));
    expect(r.errors).toHaveLength(1);
    expect(r.responses).toBe(0);
    expect(r.toolEps).toBe(base.toolEps);
    expect(r.reflected).toBe(base.reflected);
    expect(r.markers).toBe(base.markers);
  });
});

describe('persist waves: durability', () => {
  it('when the persist promise resolves, everything the store holds is on disk', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'persist-durable-'));
    try {
      const store = await makeStore(dir);
      const lines = (text: string) => new Set(text.split('\n').filter((l) => l !== ''));
      const turns: ScenarioTurn[] = [
        { text: 'who is Zoe?', session: 'sA', about: [ZOE], tools: toolRun('lookup', 'success'), facts: () => [fact('worldview')], options: ALL_ON },
        { text: 'thanks', session: 'sA', about: [ZOE], tools: toolRun('lookup', 'error'), options: ALL_ON },
        { text: 'hello', session: 'sB', options: { episodicEnabled: true } },
      ];
      for (const t of turns) {
        // awaitPersist: runCycle resolves after the turn's records are written.
        await runScenario(store, undefined, [t]);
        const onDisk = lines(await fs.readFile(path.join(dir, 'dataset.nq'), 'utf-8'));
        const inStore = lines(dumpQuads(store));
        expect(inStore.size).toBeGreaterThan(0);
        expect(onDisk).toEqual(inStore);
      }
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

describe('persist waves: single-update helpers store what the separate updates stored', () => {
  it('setStatus, resolveImpasse, markClosed and the satisfaction back-fill are one update each', async () => {
    const raw = await makeStore();
    const { store, updates } = instrument(raw);
    const registry = GraphRegistry.create([AGENT]);
    const gs = new GoalStack(store, registry, AGENT, 'sess-h');
    const uri = await gs.push({ goalType: GOAL_TYPES.AnswerQuestion, goalLabel: 'g', priority: 0.5 });
    updates.length = 0;
    await gs.setStatus(uri, 'resolved');
    expect(updates).toHaveLength(1);
    const g = await gs.get(uri);
    expect(g?.status).toBe('resolved');
    expect(g?.resolvedAt).toBeDefined();
    // Setting it again replaces the values, it does not add a second one.
    await gs.setStatus(uri, 'resolved');
    const rows = await raw.query(`SELECT ?s WHERE { GRAPH ?g { <${uri}> <${COGT}goalStatus> ?s } }`);
    expect(rows.bindings).toHaveLength(1);

    const meta = new Metacognition(store, AGENT);
    const flagged = await meta.flagImpasse({ kind: 'tool-error', flaggedInPhase: 'urn:x:phase', context: 'c' });
    updates.length = 0;
    await meta.resolveImpasse(flagged.id, 'retry', 'metacog');
    await meta.resolveImpasse(flagged.id, 'retry', 'metacog');
    expect(updates).toHaveLength(2);
    const res = await raw.query(`SELECT ?r WHERE { GRAPH ?g { <${flagged.id}> <${COGT}resolution> ?r } }`);
    expect(res.bindings).toHaveLength(1);

    const wm = new WorkingMemory(store, registry, AGENT, 'sess-h', 'cyc1', 'alice');
    updates.length = 0;
    await wm.markClosed();
    await wm.markClosed();
    expect(updates).toHaveLength(2);
    const closed = await raw.query(`SELECT ?c WHERE { GRAPH ?g { ?x <${COGT}closedAt> ?c } }`);
    expect(closed.bindings).toHaveLength(1);

    const pm = new ProceduralMemory(store, AGENT, registry);
    const trace = await pm.recordTrace({
      toolName: 't', toolArgsHash: 'h', toolArgsBrief: '', executedAt: new Date(), durationMs: 1, outcome: 'success', sequencePos: 1,
    });
    updates.length = 0;
    await pm.backfillSatisfaction(trace, true, 0.5);
    await pm.backfillSatisfaction(trace, false, 0.5);
    await pm.backfillSatisfaction(trace, null);
    expect(updates).toHaveLength(3);
    const sat = await raw.query(`SELECT ?s WHERE { GRAPH ?g { <${trace}> <${COGT}userSatisfied> ?s } }`);
    expect(sat.bindings ?? []).toHaveLength(0);
  });

  it('hasRoomFor is true exactly while the entries fit under the cap', async () => {
    const store = await makeStore();
    const wm = new WorkingMemory(store, GraphRegistry.create([AGENT]), AGENT, 's', 'c', 'u', { capacity: 4 });
    const e = (i: number) => ({ buffer: 'perceptionBuffer' as const, entryKind: 'k', payload: `p${i}`, salience: 0.5 });
    expect(await wm.hasRoomFor(4)).toBe(true);
    expect(await wm.hasRoomFor(5)).toBe(false);
    await wm.insertMany([0, 1].map((i) => ({ entry: e(i), writtenBy: 'urn:x:p' })));
    expect(await wm.hasRoomFor(2)).toBe(true);
    expect(await wm.hasRoomFor(3)).toBe(false);
    await wm.insertMany([2, 3].map((i) => ({ entry: e(i), writtenBy: 'urn:x:p' })));
    expect(await wm.hasRoomFor(0)).toBe(true);
    expect(await wm.hasRoomFor(1)).toBe(false);
  });
});
