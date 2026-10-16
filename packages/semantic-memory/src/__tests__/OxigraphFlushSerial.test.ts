import { describe, it, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';

describe('OxigraphAdapter concurrent writers', () => {
  it('overlapping updates all succeed and the persisted file holds every write', async () => {
    const dataDir = `/tmp/oxi-flush-${Math.random().toString(16).slice(2)}`;
    const store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir, port: 0, endpoint: '' });
    const n = 25;
    await Promise.all(
      Array.from({ length: n }, (_, i) =>
        store.update(`INSERT DATA { GRAPH <urn:t:g> { <urn:t:s${i}> <urn:t:p> "v${i}" . } }`),
      ),
    );
    const onDisk = await fs.readFile(`${dataDir}/dataset.nq`, 'utf-8');
    for (let i = 0; i < n; i++) expect(onDisk).toContain(`urn:t:s${i}>`);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
});
