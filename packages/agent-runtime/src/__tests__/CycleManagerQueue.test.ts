import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter, GraphRegistry, GraphUriResolver } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter, MessageEnvelope } from '@ontofelia/core';
import { CycleManager } from '../cognitive/CycleManager.js';

// Persistence runs off the reply path: queued per session, in order, with errors
// routed to onError. These tests drive the queue through a store wrapper whose
// writes can be held back and failed on demand.

const AGENT = 'ontofelia';
const COGT = 'urn:shared:ontology#cog/';

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/cmq-test-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

function envelope(text: string): MessageEnvelope {
  return {
    id: 'm',
    channel: 'webchat',
    accountId: 'acc',
    chatType: 'web',
    sender: { id: 'user:owner', channelPrefix: 'webchat', isOwner: true },
    timestamp: new Date().toISOString(),
    text,
    mentions: [],
    attachments: [],
  };
}

interface Hooks {
  /** Holds every update whose text includes the marker until released. */
  hold?: { marker: string; gate: Promise<void> };
  /** Throws for updates whose text includes the marker. */
  failOn?: string;
  /** Texts of the updates that completed, in order. */
  done: string[];
}

function wrap(store: TriplestoreAdapter, hooks: Hooks): TriplestoreAdapter {
  return new Proxy(store, {
    get(target, prop, recv) {
      if (prop === 'update') {
        return async (sparql: string) => {
          if (hooks.hold && sparql.includes(hooks.hold.marker)) await hooks.hold.gate;
          if (hooks.failOn && sparql.includes(hooks.failOn)) throw new Error('write refused');
          await target.update(sparql);
          hooks.done.push(sparql);
        };
      }
      const v = Reflect.get(target, prop, recv);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

function cycleCount(store: TriplestoreAdapter, sess: string): Promise<number> {
  const g = GraphUriResolver.getCogCyclesGraph(AGENT, sess);
  return store
    .query(`SELECT ?c WHERE { GRAPH <${g}> { ?c a <${COGT}Cycle> } }`)
    .then((r) => (r.bindings ?? []).length);
}

describe('CycleManager persistence queue', () => {
  let raw: TriplestoreAdapter;
  let registry: GraphRegistry;
  let hooks: Hooks;
  let errors: unknown[];
  let cm: CycleManager;
  let release: () => void;

  beforeEach(async () => {
    raw = await makeStore();
    registry = GraphRegistry.create([AGENT]);
    errors = [];
    let r!: () => void;
    const gate = new Promise<void>((res) => (r = res));
    release = r;
    hooks = { done: [], hold: { marker: 'cog:cycles:', gate } };
    cm = new CycleManager(wrap(raw, hooks), registry, AGENT, (e) => errors.push(e));
  });

  it('returns the core result before the cycle records are written, and flushPending waits for them', async () => {
    const out = await cm.runCycle(envelope('hi'), async () => ({ text: 'ok', sessionId: 'q1' }), (r) => r.sessionId);
    expect(out).toEqual({ text: 'ok', sessionId: 'q1' });
    // Held back: the reply is already out, the cycle graph is still empty.
    expect(await cycleCount(raw, 'q1')).toBe(0);

    release();
    await cm.flushPending();
    expect(await cycleCount(raw, 'q1')).toBe(1);
    expect(errors).toEqual([]);
  });

  it('awaitPersist: true makes runCycle resolve only after the records exist', async () => {
    release();
    await cm.runCycle(envelope('hi'), async () => ({ text: 'ok', sessionId: 'q2' }), (r) => r.sessionId, undefined, {
      awaitPersist: true,
    });
    expect(await cycleCount(raw, 'q2')).toBe(1);
  });

  it('writes the cycles of one session in order even when the first one is slow', async () => {
    // Hold only the first cycle's graph write: the second must still come after it.
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((res) => (releaseFirst = res));
    let seen = 0;
    const slow = new Proxy(raw, {
      get(target, prop, recv) {
        if (prop === 'update') {
          return async (sparql: string) => {
            if (sparql.includes('cog:cycles:q3')) {
              const n = ++seen;
              if (n === 1) await firstGate;
              order.push(sparql.match(/cyc-[0-9a-f-]+/)![0]);
            }
            await target.update(sparql);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const m = new CycleManager(slow, registry, AGENT, (e) => errors.push(e));
    const core = async () => ({ text: 'ok', sessionId: 'q3' });
    await m.runCycle(envelope('one'), core, (r) => r.sessionId);
    await m.runCycle(envelope('two'), core, (r) => r.sessionId);
    // Second persist must not overtake the blocked first one.
    await new Promise((r) => setTimeout(r, 50));
    expect(order).toEqual([]);
    releaseFirst();
    await m.flushPending();
    expect(order).toHaveLength(2);
    expect(new Set(order).size).toBe(2);
    expect(await cycleCount(raw, 'q3')).toBe(2);
    // Episodes were chained in call order: message one precedes message two.
    const eps = await raw.query(
      `SELECT ?p ?prev WHERE { GRAPH <urn:ontofelia:cog:episodic> { ?e <${COGT}payload> ?p . OPTIONAL { ?e <${COGT}precededBy> ?prev } } }`,
    );
    expect((eps.bindings ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('routes a persist error to onError, keeps the reply, and keeps the queue going', async () => {
    release();
    hooks.failOn = 'cog:cycles:q4';
    const out = await cm.runCycle(envelope('a'), async () => ({ text: 'ok', sessionId: 'q4' }), (r) => r.sessionId);
    expect(out.text).toBe('ok');
    await cm.flushPending();
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toContain('write refused');

    // A later cycle of the same session still persists.
    hooks.failOn = undefined;
    await cm.runCycle(envelope('b'), async () => ({ text: 'ok2', sessionId: 'q4' }), (r) => r.sessionId);
    await cm.flushPending();
    expect(errors).toHaveLength(1);
    expect(await cycleCount(raw, 'q4')).toBe(1);
  });

  it('still throws the core error and persists an aborted cycle', async () => {
    release();
    await expect(
      cm.runCycle(
        { ...envelope('x'), routingHints: { sessionId: 'q5' } },
        async () => {
          throw new Error('core failed');
        },
        (r: { sessionId: string }) => r.sessionId,
      ),
    ).rejects.toThrow('core failed');
    await cm.flushPending();
    expect(await cycleCount(raw, 'q5')).toBe(1);
  });

  it('the inbound episode is already written when the core reads it (arm_goal mandate), persist not awaited', async () => {
    // Persist stays held for the whole turn: only the pre-core write can explain
    // the episode being visible inside the core.
    let inboundUri: string | undefined;
    let visibleInCore = false;
    await cm.runCycle(
      envelope('arm a goal for me'),
      async (_t, prepareGoals, recordInbound) => {
        await prepareGoals('q6');
        inboundUri = await recordInbound('q6');
        const r = await raw.query(
          `SELECT ?o WHERE { GRAPH <urn:ontofelia:cog:episodic> { <${inboundUri}> <${COGT}episodeType> ?o } }`,
        );
        visibleInCore = (r.bindings ?? []).length === 1;
        return { text: 'armed', sessionId: 'q6' };
      },
      (r) => r.sessionId,
    );
    expect(inboundUri).toBeTruthy();
    expect(visibleInCore).toBe(true);
    expect(await cycleCount(raw, 'q6')).toBe(0); // persist really was not awaited

    release();
    await cm.flushPending();
    const inbound = await raw.query(
      `SELECT ?e WHERE { GRAPH <urn:ontofelia:cog:episodic> { ?e <${COGT}episodeType> "message-received" } }`,
    );
    expect((inbound.bindings ?? []).map((b) => b.e.value)).toEqual([inboundUri]);
  });

  it('requests a consolidation after the configured number of new traces, once, without awaiting it', async () => {
    release();
    let calls = 0;
    cm.setConsolidationTrigger(async () => {
      calls++;
    }, 3);
    const tools = (n: number) => async (recordTool: (e: never) => void) => {
      for (let i = 0; i < n; i++) {
        (recordTool as (e: unknown) => void)({ phase: 'called', toolName: 't', callId: `c${i}`, occurredAt: new Date(), argsBrief: 'k' });
        (recordTool as (e: unknown) => void)({ phase: 'completed', toolName: 't', callId: `c${i}`, occurredAt: new Date(), outcome: 'success', durationMs: 1 });
      }
      return { text: 'ok', sessionId: 'q7' };
    };
    const run = (n: number) =>
      cm.runCycle(envelope('use tools'), tools(n) as never, (r: { sessionId: string }) => r.sessionId, undefined, {
        proceduralEnabled: true,
        awaitPersist: true,
      });
    await run(2);
    await cm.flushPending();
    expect(calls).toBe(0);
    await run(1); // 3 traces in total
    await cm.flushPending();
    expect(calls).toBe(1);
    await run(2);
    await cm.flushPending();
    expect(calls).toBe(1); // counter was reset; 2 < 3
    await run(1);
    await cm.flushPending();
    expect(calls).toBe(2);
    expect(errors).toEqual([]);
  });

  it('a failing consolidation trigger goes to onError, not to the caller', async () => {
    release();
    cm.setConsolidationTrigger(async () => {
      throw new Error('consolidation failed');
    }, 1);
    await cm.runCycle(
      envelope('use tool'),
      (async (recordTool: (e: unknown) => void) => {
        recordTool({ phase: 'called', toolName: 't', callId: 'c', occurredAt: new Date(), argsBrief: 'k' });
        recordTool({ phase: 'completed', toolName: 't', callId: 'c', occurredAt: new Date(), outcome: 'success', durationMs: 1 });
        return { text: 'ok', sessionId: 'q8' };
      }) as never,
      (r: { sessionId: string }) => r.sessionId,
      undefined,
      { proceduralEnabled: true },
    );
    await cm.flushPending();
    expect(errors.map((e) => (e as Error).message)).toEqual(['consolidation failed']);
  });
});
