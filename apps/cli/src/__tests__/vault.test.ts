import { describe, it, expect, vi, beforeEach, afterEach, MockInstance } from 'vitest';
import { Command } from 'commander';
import * as path from 'path';
import { registerVaultCommand, sanitiseVaultName } from '../commands/vault.js';
import * as configPkg from '@ontofelia/config';

vi.mock('@ontofelia/config', () => ({
  loadConfig: vi.fn(),
}));

const originalFetch = global.fetch;
const SECRET = 'super-secret-token';

const report = (apply: boolean) => ({
  runId: 'r1',
  apply,
  notes: [
    { path: 'Recipes/hummus.md', status: apply ? 'imported' : 'would-import', facts: [{}, {}, {}], unmapped: [] },
    { path: 'Plain.md', status: 'refused', reason: 'no frontmatter', facts: [], unmapped: [] },
  ],
  totals: { [apply ? 'imported' : 'would-import']: 1, refused: 1 },
});

describe('sanitiseVaultName', () => {
  it('keeps allowed characters and replaces the rest', () => {
    expect(sanitiseVaultName('/home/me/My Vault.v2')).toBe('My_Vault_v2');
    expect(sanitiseVaultName('/x/ok-name_1')).toBe('ok-name_1');
  });
  it('truncates to 64 characters', () => {
    expect(sanitiseVaultName('/x/' + 'a'.repeat(100))).toHaveLength(64);
  });
});

describe('vault import command', () => {
  let program: Command;
  let logSpy: MockInstance;
  let errSpy: MockInstance;

  beforeEach(() => {
    program = new Command();
    registerVaultCommand(program);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.exitCode = undefined;
    vi.mocked(configPkg.loadConfig).mockResolvedValue({
      gateway: { port: 18780, token: SECRET },
    } as unknown as Awaited<ReturnType<typeof configPkg.loadConfig>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    global.fetch = originalFetch;
    process.exitCode = undefined;
  });

  const allOutput = () => [...logSpy.mock.calls, ...errSpy.mock.calls].flat().join('\n');

  it('defaults to a dry run, resolves the dir, sanitises the name and prints the dry-run line', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(report(false)) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await program.parseAsync(['node', 'test', 'vault', 'import', 'some dir/My Vault']);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:18780/api/knowledge/vault-import');
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.parse(init.body)).toEqual({
      root: path.resolve('some dir/My Vault'),
      vaultName: 'My_Vault',
      apply: false,
    });
    const out = allOutput();
    expect(out).toContain('Dry run — nothing written. Re-run with --apply to import.');
    expect(out).toContain('would-import');
    expect(out).toContain('Recipes/hummus.md  (3 facts)');
    expect(out).toContain('Plain.md  (0 facts, no frontmatter)');
    expect(out).toContain('Totals:');
    expect(out).not.toContain(SECRET);
    expect(process.exitCode).toBeUndefined();
  });

  it('passes --apply, --name and --agent and omits the dry-run line', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(report(true)) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await program.parseAsync(['node', 'test', 'vault', 'import', '/v', '--apply', '--name', 'demo', '--agent', 'ontofelia']);

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      root: '/v', vaultName: 'demo', apply: true, agentId: 'ontofelia',
    });
    expect(allOutput()).not.toContain('Dry run');
  });

  it('--json prints the raw report', async () => {
    const rep = report(false);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(rep) }) as unknown as typeof fetch;

    await program.parseAsync(['node', 'test', 'vault', 'import', '/v', '--json']);

    expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual(rep);
  });

  it('sets exit code 1 on an HTTP error and never prints the token', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 400, json: () => Promise.resolve({ error: 'root must be an absolute path' }),
    }) as unknown as typeof fetch;

    await program.parseAsync(['node', 'test', 'vault', 'import', '/v']);

    expect(process.exitCode).toBe(1);
    expect(allOutput()).toContain('HTTP 400 - root must be an absolute path');
    expect(allOutput()).not.toContain(SECRET);
  });
});
