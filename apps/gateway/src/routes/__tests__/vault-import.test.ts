import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FastifyInstance } from 'fastify';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { startGateway } from '../../index.js';
import { getDefaultConfig } from '@ontofelia/config';

const FIXTURE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', '..', '..', '..', 'packages', 'semantic-memory', 'src', '__tests__', 'fixtures', 'vault',
);
const AUTH = { authorization: 'Bearer test-secret' };
const HUMMUS = 'Recipes/hummus.md';
const IMPORTED = [HUMMUS, 'Ingredients/Chickpeas.md', 'Vocabularies/Beginner.md'];

type Note = { path: string; status: string };
type Report = { apply: boolean; notes: Note[]; totals: Record<string, number> };

describe('POST /api/knowledge/vault-import', () => {
  let fastify: FastifyInstance;
  let root: string;

  // Backend: embedded oxigraph with HOME pointed at a temp dir. The 'memory'
  // backend (InMemoryAdapter) is a stub whose ASK always answers true, so
  // importVault's evidence check would report everything as unchanged. The
  // oxigraph dataDir is derived from os.homedir(), hence the temp HOME keeps the
  // real ~/.ontofelia untouched. The store is shared by all tests, so each test that
  // applies uses its own vaultName (evidence is keyed by vault://<vaultName>/...).
  // The store is observed through GET /api/knowledge/graphs (per-graph tripleCount).
  let tmpHome: string;
  const realHome = process.env.HOME;
  beforeAll(async () => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
    tmpHome = mkdtempSync(join(tmpdir(), 'gw-home-'));
    process.env.HOME = tmpHome;
    const config = getDefaultConfig();
    config.gateway.token = 'test-secret';
    config.gateway.port = 0;
    config.memory.backend = 'oxigraph';
    fastify = await startGateway(config);
  });

  afterAll(async () => {
    await fastify.close();
    process.env.HOME = realHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('ontofelia-gateway-started')];
    if (root) rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), 'gw-vault-'));
    cpSync(FIXTURE, root, { recursive: true });
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  const post = (payload: object, headers: Record<string, string> = AUTH) =>
    fastify.inject({ method: 'POST', url: '/api/knowledge/vault-import', headers, payload });

  const totalTriples = async (): Promise<number> => {
    const res = await fastify.inject({ method: 'GET', url: '/api/knowledge/graphs', headers: AUTH });
    const graphs = res.json().graphs as { tripleCount: number | null }[];
    return graphs.reduce((n, g) => n + (g.tripleCount ?? 0), 0);
  };
  const status = (r: Report, p: string) => r.notes.find(n => n.path === p)?.status;

  it('rejects a request without token with 401', async () => {
    const res = await post({ root, vaultName: 'demo' }, {});
    expect(res.statusCode).toBe(401);
  });

  it('dry run is the default: would-import, store unchanged', async () => {
    const before = await totalTriples();
    const res = await post({ root, vaultName: 'demo' });
    expect(res.statusCode).toBe(200);
    const report = res.json() as Report;
    expect(report.apply).toBe(false);
    for (const p of IMPORTED) expect(status(report, p)).toBe('would-import');
    expect(await totalTriples()).toBe(before);
  });

  it('apply imports, a second apply reports unchanged', async () => {
    const before = await totalTriples();
    const first = await post({ root, vaultName: 'applyrun', apply: true });
    expect(first.statusCode).toBe(200);
    for (const p of IMPORTED) expect(status(first.json(), p)).toBe('imported');
    expect(await totalTriples()).toBeGreaterThan(before);

    const second = await post({ root, vaultName: 'applyrun', apply: true });
    expect(second.statusCode).toBe(200);
    for (const p of IMPORTED) expect(status(second.json(), p)).toBe('unchanged');
  });

  it('rejects a relative root, a missing directory and a file with 400', async () => {
    expect((await post({ root: 'relative/dir', vaultName: 'demo' })).statusCode).toBe(400);
    expect((await post({ root: join(root, 'nope'), vaultName: 'demo' })).statusCode).toBe(400);
    expect((await post({ root: join(root, 'Plain.md'), vaultName: 'demo' })).statusCode).toBe(400);
    expect((await post({ vaultName: 'demo' })).statusCode).toBe(400);
  });

  it('rejects an invalid vaultName with 400 and the importer message', async () => {
    const res = await post({ root, vaultName: 'bad name!' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Invalid vaultName/);
  });

  it('returns 404 for an unknown agent', async () => {
    const res = await post({ root, vaultName: 'demo', agentId: 'nobody' });
    expect(res.statusCode).toBe(404);
  });

  it('serialises concurrent applies per agent', async () => {
    // A note whose facts exist nowhere else in the shared store (an all-duplicate
    // note stores nothing and so never gains evidence, i.e. never turns "unchanged").
    const NOTE = 'Recipes/concurrent-only.md';
    writeFileSync(join(root, NOTE), [
      '---', 'type: "[[Recipe]]"', 'requiresIngredient: "[[ConcurrentOnlyIngredient]]"',
      'prepTimeMinutes: 4711', '---', '# Concurrent only', ''].join('\n'));

    const [a, b] = await Promise.all([
      post({ root, vaultName: 'concurrent', apply: true }),
      post({ root, vaultName: 'concurrent', apply: true }),
    ]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    // Which request wins the lock is not defined; the loser must see the winner's note.
    const [first, second] = status(a.json(), NOTE) === 'imported' ? [a, b] : [b, a];
    expect(status(first.json(), NOTE)).toBe('imported');
    expect(status(second.json(), NOTE)).toBe('unchanged');
  });
});
