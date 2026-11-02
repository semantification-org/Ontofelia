// Vitest globalSetup, paired with ./isolate-home.ts.
//
// It creates one directory that is unique to this test run and hands its path
// to the per-file setup file, which puts every temporary home inside it. The
// teardown below removes that one directory, whatever happened to the
// individual test files: a file that fails to load never reaches its afterAll
// hook, and a worker that is killed never runs any exit handler of its own.
// The main process outlives all workers, so the cleanup lives here.
//
// Only the directory created below is ever removed, never a glob over the
// system temp directory, so a parallel run (by anyone) is not affected.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    isolatedHomeRoot: string;
  }
}

export default function setup(project: TestProject): () => void {
  const root = mkdtempSync(join(tmpdir(), 'ontofelia-gateway-run-'));
  project.provide('isolatedHomeRoot', root);
  // Workers are forked after this runs and inherit the environment, so every
  // tmpdir() in a test file (scratch stores, session and audit directories)
  // lands inside the root as well and goes with it, cleaned up or not.
  const previousTmp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.env.TMPDIR = root;
  process.env.TMP = root;
  process.env.TEMP = root;
  const remove = (): void => {
    for (const [key, value] of Object.entries(previousTmp)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  };
  // Vitest ends the main process without running the teardown when a worker
  // dies abruptly (SIGKILL, out of memory): it reports an unhandled rejection
  // and exits. The exit handler covers that case; removal is idempotent. It is
  // prepended because Vitest's own exit handler calls process.exit() again,
  // which skips every listener registered after it.
  process.prependOnceListener('exit', remove);
  return remove;
}
