import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OxigraphDiskAdapter } from '@ontofelia/semantic-memory';
import memoryRoutes from '../memory.js';
import type { GatewayContext } from '../../context.js';

const GRAPH = 'urn:ontofelia:worldview';
const EX = 'http://example.org/';

// DELETE /api/knowledge writes a backup of the whole dataset before it clears it.
// With the on-disk backend that backup must come from the store, not from the
// stale dataset.nq an earlier file-backend run left behind. Skipped when the
// native binary was not built, unless the disk run was requested explicitly.
const diskRequested = process.env.ONTOFELIA_TEST_OXIGRAPH_STORE === 'disk';
let diskAvailable = true;
{
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-backup-probe-'));
  try {
    const probe = new OxigraphDiskAdapter();
    await probe.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: probeDir, port: 0, endpoint: '' });
    await probe.stop();
  } catch {
    diskAvailable = false;
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
}

describe.skipIf(!diskAvailable && !diskRequested)('DELETE /api/knowledge on the on-disk store', () => {
  let app: FastifyInstance;
  let store: OxigraphDiskAdapter;
  let tmpHome: string;
  let realHome: string | undefined;

  beforeAll(async () => {
    realHome = process.env.HOME;
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-backup-home-'));
    process.env.HOME = tmpHome;
    // A leftover file-backend dataset that no longer matches the store.
    const stale = path.join(tmpHome, '.ontofelia', 'triplestore', 'oxigraph');
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, 'dataset.nq'), `<${EX}stale> <${EX}p> "stale" <${GRAPH}> .\n`);

    store = new OxigraphDiskAdapter();
    await store.initialize({
      backend: 'oxigraph', type: 'embedded', dataDir: path.join(tmpHome, '.ontofelia', 'triplestore', 'oxigraph-disk'),
      port: 0, endpoint: '',
    });
    await store.insertTriples(GRAPH, [{ subject: EX + 'fresh', predicate: EX + 'p', object: { value: 'fresh' } }]);
    app = Fastify();
    await app.register(memoryRoutes, {
      triplestore: store,
      config: { memory: { sparqlTimeoutMs: 5000 } },
    } as unknown as GatewayContext);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await store.stop();
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('backs up what the store holds, not the stale dataset.nq, then clears the store', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/knowledge?confirm=true' });
    expect(res.statusCode).toBe(200);
    const { backupPath } = res.json() as { backupPath: string };
    expect(path.dirname(backupPath)).toBe(path.join(tmpHome, '.ontofelia', 'backups'));
    const backup = fs.readFileSync(backupPath, 'utf-8');
    expect(backup).toContain('"fresh"');
    expect(backup).not.toContain('stale');
    expect(await store.exportDataset()).not.toContain('"fresh"');
  });
});
