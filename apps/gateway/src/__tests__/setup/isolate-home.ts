// The gateway and @ontofelia/config build their paths from os.homedir(),
// some of them at module import time (e.g. DEFAULT_CONFIG_PATH in
// packages/config/src/index.ts). Without this setup file, running the
// gateway tests writes a whole ~/.ontofelia/ into the real home of whoever
// runs them. This file switches HOME to a fresh temporary directory before
// any test module (and therefore any of that import-time code) runs, and
// cleans it up again afterwards.
//
// The directory lives inside a per-run root created by ./global-isolate-home.ts,
// which removes the whole root when the run ends. The afterAll below only
// frees the space early and restores the environment; it is not the only
// cleanup, because it never runs for a test file that fails to load.
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, inject } from 'vitest';

// tmpdir() reads TMPDIR, not HOME, so this is unaffected by the switch below.
// Without the global setup (a config that omits it) fall back to the plain
// temp directory; the afterAll hook is then the only cleanup.
const dir = mkdtempSync(join(inject('isolatedHomeRoot') ?? tmpdir(), 'ontofelia-gateway-home-'));

const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;

process.env.HOME = dir;
process.env.USERPROFILE = dir;

if (homedir() !== dir) {
  throw new Error(
    `isolate-home setup failed: os.homedir() is "${homedir()}", expected the temp directory "${dir}". ` +
      'Refusing to run gateway tests, since they would write into the real home.',
  );
}

afterAll(() => {
  if (previousHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = previousHome;
  }

  if (previousUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = previousUserProfile;
  }

  rmSync(dir, { recursive: true, force: true });
});
