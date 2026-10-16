import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';

const G = 'urn:g:flush';
let dir: string;

async function open(): Promise<OxigraphAdapter> {
  const a = new OxigraphAdapter();
  await a.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
  return a;
}

const ins = (a: OxigraphAdapter, s: string, o = 'v') =>
  a.update(`INSERT DATA { GRAPH <${G}> { <urn:s:${s}> <urn:p> "${o}" } }`);

async function has(a: OxigraphAdapter, s: string, o = 'v'): Promise<boolean> {
  return a.ask(`ASK { GRAPH <${G}> { <urn:s:${s}> <urn:p> "${o}" } }`);
}

function spyDump(a: OxigraphAdapter) {
  const store = (a as unknown as { store: { dump: (...x: unknown[]) => string } }).store;
  return vi.spyOn(store, 'dump');
}

describe('OxigraphAdapter flush coalescing', () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flush-coalesce-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a write is on disk once its await resolves (reload from file)', async () => {
    const a = await open();
    await ins(a, 'one');
    const b = await open();
    expect(await has(b, 'one')).toBe(true);
  });

  it('concurrent writes A, B, C cost at most 2 dumps and are all durable when their awaits resolve', async () => {
    const a = await open();
    const spy = spyDump(a);
    const durableAtResolve: Record<string, boolean> = {};
    const write = async (name: string) => {
      await ins(a, name);
      // Reload from the file at the moment this caller's await resolved.
      durableAtResolve[name] = await has(await open(), name);
    };
    await Promise.all([write('A'), write('B'), write('C')]);
    // The reloads above do not dump (fresh adapters, no writes), so the spy counts only A/B/C.
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(durableAtResolve).toEqual({ A: true, B: true, C: true });
  });

  it('a write arriving while a flush is running gets its own later flush', async () => {
    const a = await open();
    const spy = spyDump(a);
    const first = ins(a, 'first');
    await new Promise((r) => setImmediate(r)); // flush 1 is now running or done
    const second = ins(a, 'second');
    await Promise.all([first, second]);
    expect(spy.mock.calls.length).toBe(2);
    const b = await open();
    expect(await has(b, 'first')).toBe(true);
    expect(await has(b, 'second')).toBe(true);
  });

  it('sequential writers flush once each, as before', async () => {
    const a = await open();
    const spy = spyDump(a);
    await ins(a, 'x1');
    await ins(a, 'x2');
    await ins(a, 'x3');
    expect(spy.mock.calls.length).toBe(3);
  });

  it('a failed flush rejects every joined caller, and the next write recovers', async () => {
    const a = await open();
    const spy = spyDump(a);
    spy.mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const results = await Promise.allSettled([ins(a, 'e1'), ins(a, 'e2'), ins(a, 'e3')]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    for (const r of results) {
      expect((r as PromiseRejectedResult).reason.message).toContain('disk full');
    }
    spy.mockRestore();
    await ins(a, 'e4'); // next write tries again and succeeds
    const b = await open();
    // The failed writes were applied in memory, so the recovery flush persists them too.
    expect(await has(b, 'e4')).toBe(true);
    expect(await has(b, 'e1')).toBe(true);
  });

  it('latest state wins on disk (insert then delete in a burst)', async () => {
    const a = await open();
    await Promise.all([
      ins(a, 'k', 'old'),
      a.update(`DELETE DATA { GRAPH <${G}> { <urn:s:k> <urn:p> "old" } }`),
      ins(a, 'k', 'new'),
    ]);
    const b = await open();
    expect(await has(b, 'k', 'new')).toBe(true);
    expect(await has(b, 'k', 'old')).toBe(false);
  });
});
