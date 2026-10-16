import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';

describe('OxigraphAdapter dump counter', () => {
  it('counts full dumps, matches the real dump calls, and is read-only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dump-count-'));
    try {
      const a = new OxigraphAdapter();
      await a.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: dir, port: 0, endpoint: '' });
      expect(a.dumpCount).toBe(0);
      await a.update('INSERT DATA { GRAPH <urn:g:c> { <urn:s:1> <urn:p> "a" } }');
      expect(a.dumpCount).toBe(1);
      // a burst shares flushes: never more dumps than writes
      await Promise.all(Array.from({ length: 6 }, (_, i) => a.update(`INSERT DATA { GRAPH <urn:g:c> { <urn:s:b${i}> <urn:p> "b" } }`)));
      expect(a.dumpCount).toBeGreaterThanOrEqual(2);
      expect(a.dumpCount).toBeLessThanOrEqual(7);
      // reads do not dump
      const before = a.dumpCount;
      await a.query('SELECT * WHERE { GRAPH <urn:g:c> { ?s ?p ?o } }');
      expect(a.dumpCount).toBe(before);
      expect(() => { (a as unknown as { dumpCount: number }).dumpCount = 99; }).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
