import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, inject, it } from 'vitest';

// Runs a nested vitest on fixtures with a private TMPDIR and checks that no
// temporary home or per-run root is left behind when a file ends abnormally.
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'isolate-home');
const vitestBin = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);
// Inside this run's own root, which the global teardown removes.
const privateTmp = mkdtempSync(join(inject('isolatedHomeRoot'), 'nested-'));

function leftovers(): string[] {
  return readdirSync(privateTmp).filter((name) => name.startsWith('ontofelia-gateway-'));
}

function runFixtures(...filters: string[]): string {
  const run = spawnSync(process.execPath, [vitestBin, 'run', '--no-color', ...filters], {
    cwd: fixtureDir,
    env: { ...process.env, TMPDIR: privateTmp },
    encoding: 'utf8',
  });
  // Positive control: the run really ended abnormally.
  expect(run.status).not.toBe(0);
  return `${run.stdout}\n${run.stderr}`;
}

it('removes every temporary home when a test file fails to load', () => {
  expect(runFixtures('loadFailure', 'passing')).toMatch(/1 failed \| 1 passed/);
  expect(leftovers()).toEqual([]);
}, 120_000);

it('removes every temporary home when a worker is killed', () => {
  runFixtures('workerCrash');
  expect(leftovers()).toEqual([]);
}, 120_000);
