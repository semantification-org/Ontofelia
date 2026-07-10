import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { NoopSandboxAdapter } from '../noop/NoopSandboxAdapter.js';
import { SandboxConfig } from '../SandboxAdapter.js';

const CFG: SandboxConfig = { scope: 'agent', workspaceAccess: 'rw' };
// Unusual duration so we can find/kill exactly our own processes.
const SENTINEL = 'sleep 91737';

// Count live processes whose args contain the sentinel. The `[s]leep` trick
// keeps the grep/ps pipeline from matching itself.
function sentinelProcs(): number {
  const out = execSync(`ps -eo args= | grep -c '[s]leep 91737' || true`).toString().trim();
  return Number(out) || 0;
}

async function newAdapter() {
  const a = new NoopSandboxAdapter();
  const instance = await a.getOrCreate('a', 's', CFG, '/tmp');
  return { a, instance };
}

describe('NoopSandboxAdapter.exec', () => {
  afterEach(() => {
    try { execSync(`pkill -f '${SENTINEL}' || true`); } catch { /* ignore */ }
  });

  it('runs a command and returns stdout + exit code 0', async () => {
    const { a, instance } = await newAdapter();
    const r = await a.exec(instance, 'echo hello-world');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe('hello-world');
    expect(r.timedOut).toBe(false);
  });

  it('reports a non-zero exit code', async () => {
    const { a, instance } = await newAdapter();
    const r = await a.exec(instance, 'exit 3');
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
  });

  it('kills the WHOLE process tree on timeout — no orphan survives (BUG-A)', async () => {
    const { a, instance } = await newAdapter();
    // A nested shell so the sentinel is a grandchild (sh → sh → sleep); the old
    // execFile path left this grandchild running after killing only /bin/sh.
    // Timeout is generous enough that the whole tree is up before teardown.
    const r = await a.exec(instance, `sh -c "${SENTINEL}"`, { timeoutMs: 700 });
    expect(r.timedOut).toBe(true);
    // give SIGTERM/SIGKILL time to land
    await new Promise((res) => setTimeout(res, 400));
    expect(sentinelProcs()).toBe(0);
  });

  it('kills the process tree when the abort signal fires (BUG-A)', async () => {
    const { a, instance } = await newAdapter();
    const ac = new AbortController();
    const p = a.exec(instance, `sh -c "${SENTINEL}"`, { timeoutMs: 30_000, signal: ac.signal });
    setTimeout(() => ac.abort(), 500); // let the whole tree come up first
    const r = await p;
    expect(r.timedOut).toBe(true);
    await new Promise((res) => setTimeout(res, 400));
    expect(sentinelProcs()).toBe(0);
  });
});
