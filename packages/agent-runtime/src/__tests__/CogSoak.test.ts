import { describe, it, expect, afterEach } from 'vitest';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { OxigraphAdapter } from '@ontofelia/semantic-memory';
import { CogHealth, nearestRank, SOAK_MAX_CYCLES } from '../cognitive/CogHealth.js';
import { PERSIST_SAMPLE_CAP } from '../cognitive/CycleManager.js';
import { makeEnv, envelope, send, cleanup, OWNER, ALICE, AGENT, COGT, type Env } from './promptHarness.js';
import { bootFreshInstall } from './freshInstall.js';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// Soak metrics of /cog health: numbers only, bounded, owner only.

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const dt = (iso: string) => `"${iso}"^^<${XSD}dateTime>`;
const HOSTILE = 'HOSTILE-7f3a"; DROP GRAPH <urn:x:y>; </script> sk-secret-0000 \\u0000 ${jndi:x}';

describe('soak metrics (CogHealth.soak)', () => {
  let store: TriplestoreAdapter;
  let dir: string;
  const insert = (graph: string, triples: string) => store.update(`INSERT DATA { GRAPH <${graph}> {\n${triples}\n} }`);

  async function fresh(): Promise<CogHealth> {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cogsoak-'));
    const ox = new OxigraphAdapter();
    await ox.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
    store = ox;
    return new CogHealth(store, AGENT);
  }
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); });

  it('nearest-rank percentiles; empty gives null', () => {
    expect(nearestRank([], 0.5)).toBeNull();
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(nearestRank(ten, 0.5)).toBe(5);
    expect(nearestRank(ten, 0.95)).toBe(10);
    expect(nearestRank([7], 0.95)).toBe(7);
  });

  it('reports persist p50/p95 over the window, graph sizes per family, and no text', async () => {
    const ch = await fresh();
    await insert(`urn:${AGENT}:cog:episodic`, `<urn:e:1> <${RDF_TYPE}> <${COGT}Episode> ; <${COGT}payload> "${HOSTILE.replace(/"/g, '\\"').replace(/\\u/g, '\\\\u')}" .`);
    await insert(`urn:${AGENT}:cog:cycles:s1`, `<urn:c:1> <${RDF_TYPE}> <${COGT}Cycle> .`);
    await insert(`urn:${AGENT}:cog:cycles:s2`, `<urn:c:2> <${RDF_TYPE}> <${COGT}Cycle> . <urn:c:3> <${RDF_TYPE}> <${COGT}Cycle> .`);
    await insert(`urn:${AGENT}:cog:goals:s1`, `<urn:g:1> <${RDF_TYPE}> <${COGT}Goal> .`);
    await insert(`urn:${AGENT}:cog:goals:longterm`, `<urn:g:2> <${RDF_TYPE}> <${COGT}Goal> . <urn:g:3> <${RDF_TYPE}> <${COGT}Goal> .`);
    await insert(`urn:${AGENT}:cog:working:s1:c1`, `<urn:w:1> <${RDF_TYPE}> <${COGT}WMEntry> .`);
    const persist = Array.from({ length: 10 }, (_, i) => ({ ms: (i + 1) * 10, dumps: i < 4 ? 2 : 1 }));
    const m = await ch.soak({ persist });
    expect(m.persistLatencyMs).toEqual({ samples: 10, p50: 50, p95: 100 });
    expect(m.dumpsPerTurn).toBe(1.4);
    expect(m.graphSizes.episodic).toEqual({ triples: 2, capped: false });
    expect(m.graphSizes.cycles).toEqual({ triples: 3, graphs: 2, capped: false });
    expect(m.graphSizes.goalsSession).toEqual({ triples: 1, graphs: 1, capped: false }); // longterm is not a session graph
    expect(m.graphSizes.goalsLongterm.triples).toBe(2);
    expect(m.graphSizes.working).toEqual({ triples: 1, graphs: 1, capped: false });
    expect(m.graphSizes.procedural.triples).toBe(0);
    // numbers and fixed keys only
    const json = JSON.stringify(m);
    expect(json).not.toContain('HOSTILE');
    expect(json).not.toContain('sk-secret');
    expect(json).not.toContain('DROP GRAPH');
    const leaves: unknown[] = [];
    const walk = (v: unknown) => (v && typeof v === 'object' ? Object.values(v).forEach(walk) : leaves.push(v));
    walk(m);
    for (const l of leaves) expect(['number', 'boolean'].includes(typeof l) || l === null).toBe(true);
  });

  it('bounds the window: 0 gives 1, huge gives the cap; only the newest cycles count; persist samples are cut to the window', async () => {
    const ch = await fresh();
    // seven cycles, one per hour; the OLDEST and the NEWEST carry an impasse marker
    const meta = `urn:${AGENT}:cog:meta`;
    for (let i = 0; i < 7; i++) {
      const t = new Date(Date.UTC(2026, 9, 15, i, 0, 0)).toISOString();
      await insert(`urn:${AGENT}:cog:cycles:s1`, `<urn:${AGENT}:cog:cycle:c${i}> <${RDF_TYPE}> <${COGT}Cycle> ; <${COGT}startedAt> ${dt(t)} .`);
    }
    for (const i of [0, 6]) {
      await insert(meta, `<urn:m:${i}> <${RDF_TYPE}> <${COGT}ReflectiveMarker> ; <${COGT}reflectsOn> <urn:${AGENT}:cog:cycle:c${i}> ; <${COGT}flaggedImpasse> <urn:i:${i}> .`);
    }
    const m3 = await ch.soak({ cycles: 3 });
    expect(m3.windowCycles).toBe(3);
    expect(m3.impasses).toEqual({ cyclesInWindow: 3, flaggedInWindow: 1, per100Cycles: 33.33 });
    expect((await ch.soak({ cycles: 0 })).windowCycles).toBe(1);
    expect((await ch.soak({ cycles: 99_999 })).windowCycles).toBe(SOAK_MAX_CYCLES);
    expect((await ch.soak({ cycles: 2.5 })).windowCycles).toBe(100);
    const all = await ch.soak({ cycles: 500 });
    expect(all.impasses).toEqual({ cyclesInWindow: 7, flaggedInWindow: 2, per100Cycles: 28.57 });
    const small = await ch.soak({ cycles: 2, persist: [{ ms: 1000 }, { ms: 1 }, { ms: 3 }] });
    expect(small.persistLatencyMs).toEqual({ samples: 2, p50: 1, p95: 3 });
    expect(small.dumpsPerTurn).toBeNull();
  });

  it('empty store: nulls and zeros, never throws', async () => {
    const ch = await fresh();
    const m = await ch.soak();
    expect(m.persistLatencyMs).toEqual({ samples: 0, p50: null, p95: null });
    expect(m.impasses).toEqual({ cyclesInWindow: 0, flaggedInWindow: 0, per100Cycles: null });
    expect(m.dumpsPerTurn).toBeNull();
    expect(m.graphSizes.episodic).toEqual({ triples: 0, capped: false });
  });
});

describe('/cog health with soak metrics', () => {
  const made: Env[] = [];
  afterEach(async () => { await cleanup(made); made.length = 0; });

  it('owner: a bounded numbers-only soak object, no user text even with a hostile episode and message; non-owner gets nothing', async () => {
    const e = await makeEnv({
      tools: [{ name: 'searchKb' }],
      seed: async ({ store, em }) => {
        await bootFreshInstall(store);
        await em.append({ episodeType: 'message-received', sessionId: 's0', forUser: 'alice', payload: `seed ${HOSTILE}`, occurredAt: new Date() });
      },
    });
    made.push(e);
    await send(e, `hello ${HOSTILE}`, ALICE);
    await send(e, 'and again', ALICE);
    const cm = (e.runtime as unknown as { cycleManager: { recentPersists(n?: number): unknown[] } }).cycleManager;
    expect(cm.recentPersists()).toHaveLength(2);
    expect(cm.recentPersists(1)).toHaveLength(1);
    expect(cm.recentPersists(0)).toHaveLength(0);
    expect(cm.recentPersists(10 * PERSIST_SAMPLE_CAP).length).toBeLessThanOrEqual(PERSIST_SAMPLE_CAP);

    const out = (await e.runtime.handleMessage(envelope('/cog health', OWNER))).text;
    expect(out).toContain('"soak"');
    const payload = JSON.parse(out.replace(/^```json\n/, '').replace(/\n```$/, ''));
    expect(payload.soak.windowCycles).toBe(100);
    expect(payload.soak.persistLatencyMs.samples).toBe(2);
    expect(payload.soak.persistLatencyMs.p95).toBeGreaterThanOrEqual(payload.soak.persistLatencyMs.p50);
    expect(payload.soak.impasses.cyclesInWindow).toBe(2);
    expect(payload.soak.graphSizes.episodic.triples).toBeGreaterThan(0);
    expect(payload.soak.graphSizes.cycles.graphs).toBeGreaterThanOrEqual(1);
    expect(payload.soak.dumpsPerTurn).toBeGreaterThan(0);
    // no user text anywhere in the soak object
    for (const bad of ['HOSTILE', 'hello', 'sk-secret']) expect(out).not.toContain(bad); // the whole reply, not only the soak object
    const soakJson = JSON.stringify(payload.soak);
    for (const bad of ['HOSTILE', 'hello', 'and again', 'sk-secret', 'DROP GRAPH']) expect(soakJson).not.toContain(bad);

    const denied = (await e.runtime.handleMessage(envelope('/cog health', ALICE))).text;
    expect(denied).toBe('This command is owner-only.');
  });
});
