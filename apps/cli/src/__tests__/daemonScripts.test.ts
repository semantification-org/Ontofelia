import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

// The two scripts are run for real, but every external command with a side
// effect (crontab, systemctl, ss, curl, ps, ontofelia, node, nohup, pkill,
// sleep) is replaced by a shim that only appends its arguments to a log file.
// `kill` is a bash builtin and cannot be shimmed; the tests never create a PID
// file pointing at a live process, so it is never reached with a real PID.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');
const INSTALL = path.join(repoRoot, 'scripts', 'install-daemon.sh');
const WATCHDOG = path.join(repoRoot, 'scripts', 'gateway-watchdog.sh');
const BUS_MSG = "systemd user bus found — use 'ontofelia daemon install' for supervision (cron not installed)";

let tmp: string;
let shimDir: string;
let home: string;
let runtime: string;

function shim(name: string, body: string): void {
  const file = path.join(shimDir, name);
  fs.writeFileSync(
    file,
    `#!/bin/bash\necho "$(basename "$0") $*" >> "${shimDir}/${name}.log"\n${body}\n`,
    { mode: 0o755 },
  );
}

function calls(name: string): string[] {
  const f = path.join(shimDir, `${name}.log`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
}

function run(script: string, extra: Record<string, string> = {}) {
  return spawnSync('bash', [script], {
    env: {
      PATH: `${shimDir}:/usr/bin:/bin`,
      HOME: home,
      XDG_RUNTIME_DIR: runtime,
      ONTOFELIA_PORT: '18799',
      ...extra,
    },
    encoding: 'utf8',
    timeout: 20000,
  });
}

function installShims(opts: { systemctl: string; curl: string; ss?: string }): void {
  // crontab: `-l` replays the last written content, `-` stores stdin.
  shim(
    'crontab',
    `if [ "$1" = "-l" ]; then cat "${shimDir}/crontab.content" 2>/dev/null; exit 0; fi
if [ "$1" = "-" ]; then cat > "${shimDir}/crontab.content"; exit 0; fi
exit 0`,
  );
  shim('systemctl', opts.systemctl);
  shim('curl', opts.curl);
  shim('ss', opts.ss ?? 'exit 0');
  shim('ps', 'echo 4242');
  for (const n of ['ontofelia', 'node', 'nohup', 'pkill', 'sleep']) shim(n, 'exit 0');
}

const crontabWrites = () => calls('crontab').filter((c) => c !== 'crontab -l');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-scripts-'));
  shimDir = path.join(tmp, 'shims');
  home = path.join(tmp, 'home');
  runtime = path.join(tmp, 'run');
  for (const d of [shimDir, home, runtime]) fs.mkdirSync(d, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('install-daemon.sh supervisor choice', () => {
  const healthy = 'printf 200';

  it('installs no cron when a systemd user bus is usable', () => {
    installShims({ systemctl: 'echo running', curl: healthy });
    fs.writeFileSync(path.join(runtime, 'bus'), '');
    const r = run(INSTALL);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(BUS_MSG);
    expect(crontabWrites()).toEqual([]);
    expect(calls('crontab')).toEqual([]);
  });

  it('falls back to cron when systemctl reports no usable bus', () => {
    installShims({ systemctl: 'exit 1', curl: healthy });
    fs.writeFileSync(path.join(runtime, 'bus'), '');
    const r = run(INSTALL);
    expect(r.status).toBe(0);
    expect(crontabWrites()).toContain('crontab -');
    const content = fs.readFileSync(path.join(shimDir, 'crontab.content'), 'utf8');
    expect(content).toContain('# ontofelia-daemon (managed by scripts/install-daemon.sh)');
  });

  it('falls back to cron when the bus socket is missing', () => {
    installShims({ systemctl: 'echo running', curl: healthy });
    const r = run(INSTALL);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('systemd user bus found');
    expect(crontabWrites()).toContain('crontab -');
  });

  it('ONTOFELIA_SUPERVISOR=cron forces cron even with a usable bus', () => {
    installShims({ systemctl: 'echo running', curl: healthy });
    fs.writeFileSync(path.join(runtime, 'bus'), '');
    const r = run(INSTALL, { ONTOFELIA_SUPERVISOR: 'cron' });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('systemd user bus found');
    expect(crontabWrites()).toContain('crontab -');
    expect(fs.readFileSync(path.join(shimDir, 'crontab.content'), 'utf8')).toContain('ontofelia-daemon');
  });
});

describe('gateway-watchdog.sh ownership guard', () => {
  const noRestart = () => {
    for (const n of ['ontofelia', 'node', 'nohup', 'pkill']) expect(calls(n)).toEqual([]);
  };

  it('does nothing when the health check passes', () => {
    installShims({ systemctl: 'exit 1', curl: 'printf 200' });
    const r = run(WATCHDOG);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
    expect(calls('ss')).toEqual([]);
    noRestart();
  });

  it('leaves a gateway owned by another user alone (listener without pid)', () => {
    installShims({
      systemctl: 'exit 1',
      curl: 'printf 000; exit 7',
      ss: 'echo "LISTEN 0 511 127.0.0.1:18799 0.0.0.0:*"',
    });
    const r = run(WATCHDOG);
    expect(r.status).toBe(3);
    expect(r.stdout).toMatch(/gateway on port 18799 is not owned by \S+; not touching it/);
    noRestart();
  });

  it('leaves a listener whose pid belongs to another uid alone', () => {
    installShims({
      systemctl: 'exit 1',
      curl: 'printf 000; exit 7',
      ss: 'echo "LISTEN 0 511 127.0.0.1:18799 0.0.0.0:* users:((\\"node\\",pid=4242,fd=19))"',
    });
    shim('ps', 'echo 0');
    const r = run(WATCHDOG);
    expect(r.status).toBe(3);
    expect(r.stdout).toContain('not touching it');
    noRestart();
  });

  it('restarts when nothing listens on the port', () => {
    installShims({ systemctl: 'exit 1', curl: 'printf 000; exit 7', ss: 'exit 0' });
    const r = run(WATCHDOG);
    expect(calls('ss').length).toBeGreaterThan(0);
    expect(r.stdout).toContain('recovering gateway');
    expect(r.stdout).not.toContain('not touching it');
    expect(calls('ontofelia')).toEqual(['ontofelia gateway start']);
    expect(r.status).toBe(0);
  });

  it('restarts when the listener is our own process', () => {
    installShims({
      systemctl: 'exit 1',
      curl: 'printf 000; exit 7',
      ss: 'echo "LISTEN 0 511 127.0.0.1:18799 0.0.0.0:* users:((\\"node\\",pid=4242,fd=19))"',
    });
    shim('ps', `id -u`);
    const r = run(WATCHDOG);
    expect(r.stdout).not.toContain('not touching it');
    expect(calls('ontofelia')).toEqual(['ontofelia gateway start']);
  });
});
