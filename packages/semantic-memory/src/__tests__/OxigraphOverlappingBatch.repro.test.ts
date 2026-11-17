/**
 * Repro: overlapping independent batches on one OxigraphAdapter.
 *
 * `batch()` keeps one adapter-wide `batchDepth`. While batch A is still open,
 * a second, independent batch B (or a plain `update()`) that writes and
 * finishes sees `batchDepth > 0`, so its write is only marked dirty and no
 * flush happens: the promise resolves although nothing is on disk yet.
 *
 * The finding tests assert the CORRECT behaviour (an awaited write is on disk
 * when its promise resolves) and are `it.fails` while the defect exists.
 *
 * Nothing is mocked: a real file-backed adapter, interleaving forced with a
 * promise that is resolved by hand. Disk state is read from the persisted
 * dataset file and the exact N-Quads line is matched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { OxigraphAdapter } from '../adapters/OxigraphAdapter.js';

const TRIPLE_LINE = '<urn:repro:overlap:subject> <urn:repro:overlap:predicate> <urn:repro:overlap:object> .';
const INSERT_TRIPLE = `INSERT DATA { ${TRIPLE_LINE} }`;

async function makeAdapter(dataDir: string): Promise<OxigraphAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir,
    port: 0,
    endpoint: '',
  });
  return store;
}

/** True when the persisted dataset file holds exactly this triple as one line. */
async function tripleOnDisk(dataDir: string): Promise<boolean> {
  let text: string;
  try {
    text = await fs.readFile(path.join(dataDir, 'dataset.nq'), 'utf-8');
  } catch {
    return false; // no dataset file yet: nothing persisted
  }
  return text.split('\n').some((line) => line.trim() === TRIPLE_LINE);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('OxigraphAdapter overlapping batches', () => {
  let dataDir: string;
  let adapter: OxigraphAdapter;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-oxoverlap-'));
    adapter = await makeAdapter(dataDir);
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('control: without another batch open, an awaited batch has its write on disk', async () => {
    expect(await tripleOnDisk(dataDir)).toBe(false);
    await adapter.batch(async () => {
      await adapter.update(INSERT_TRIPLE);
    });
    expect(await tripleOnDisk(dataDir)).toBe(true);
  });

  it('control: after the open batch is released, the write of the overlapping batch is on disk (late, not lost)', async () => {
    const gate = deferred();
    const batchA = adapter.batch(async () => {
      await gate.promise;
    });

    await adapter.batch(async () => {
      await adapter.update(INSERT_TRIPLE);
    });

    gate.resolve();
    await batchA;
    expect(await tripleOnDisk(dataDir)).toBe(true);
  });

  it.fails('a batch that resolved while another batch is open has its write on disk', async () => {
    const gate = deferred();
    const batchA = adapter.batch(async () => {
      await gate.promise;
    });

    try {
      await adapter.batch(async () => {
        await adapter.update(INSERT_TRIPLE);
      });
      // Batch B has resolved; batch A is still open.
      expect(await tripleOnDisk(dataDir)).toBe(true);
    } finally {
      gate.resolve();
      await batchA;
    }
  });

  it.fails('a plain update() awaited while a batch is open has its write on disk', async () => {
    const gate = deferred();
    const batchA = adapter.batch(async () => {
      await gate.promise;
    });

    try {
      await adapter.update(INSERT_TRIPLE);
      // The update has resolved; batch A is still open.
      expect(await tripleOnDisk(dataDir)).toBe(true);
    } finally {
      gate.resolve();
      await batchA;
    }
  });
});
