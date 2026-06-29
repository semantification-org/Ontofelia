import { Command } from 'commander';
import { stopGateway } from '../utils/process.js';
import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

/**
 * `ontofelia rebuild` — recompile every package and restart the gateway,
 * without touching anything under ~/.ontofelia (config, auth, triplestore,
 * conversations all stay intact).
 *
 * This rebuilds *code* only. It is the command to run after pulling changes
 * or editing source — distinct from `data-reset`, which wipes data.
 */
export function registerRebuildCommand(program: Command) {
  program
    .command('rebuild')
    .description('Recompile all packages and restart the gateway — configuration is left untouched')
    .option('--no-restart', 'Rebuild only, do not restart the gateway')
    .action(async (options) => {
      console.log('');
      console.log(chalk.cyan.bold('  🔨 Ontofelia Rebuild'));
      console.log(chalk.gray('  Recompiles all packages. Configuration and data are untouched.'));
      console.log('');

      // Locate the monorepo root. This file runs from apps/cli/dist/commands/
      // (compiled) or apps/cli/src/commands/ (tsx) — the repo root is three
      // levels up from apps/cli/<dist|src>.
      const currentFile = fileURLToPath(import.meta.url);
      const repoRoot = path.resolve(path.dirname(currentFile), '..', '..', '..', '..');

      if (!fs.existsSync(path.join(repoRoot, 'turbo.json'))) {
        console.log(chalk.red(`  ✖ Could not locate the Ontofelia repository (looked in ${repoRoot})`));
        process.exit(1);
      }

      // ── 1. Stop the gateway so it is not running stale code mid-build ──
      console.log(chalk.cyan('  [1/3] Stopping gateway...'));
      const wasRunning = await stopGateway();
      console.log(chalk.green(wasRunning ? '  ✔ Gateway stopped' : '  ✔ Gateway was not running'));

      // ── 2. Build all packages ──
      console.log(chalk.cyan('  [2/3] Building all packages...'));
      console.log('');
      const built = await runBuild(repoRoot);
      console.log('');
      if (!built) {
        console.log(chalk.red('  ✖ Build failed — see the errors above. Gateway not restarted.'));
        process.exit(1);
      }
      console.log(chalk.green('  ✔ All packages built'));

      // ── 3. Restart the gateway with the freshly built code ──
      if (options.restart === false) {
        console.log(chalk.gray('  [3/3] Skipping restart (--no-restart).'));
        console.log('');
        console.log(chalk.green.bold('  🦉 Rebuild complete.'));
        console.log(chalk.gray('  Start the gateway with: ontofelia gateway start'));
        process.exit(0);
      }

      console.log(chalk.cyan('  [3/3] Restarting gateway...'));
      try {
        const child = spawn(process.execPath, [process.argv[1], 'gateway', 'start'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        console.log(chalk.green('  ✔ Gateway restarting'));
      } catch {
        console.log(chalk.yellow('  ⚠ Gateway could not be started automatically'));
        console.log(chalk.gray('    Start it manually with: ontofelia gateway start'));
      }

      console.log('');
      console.log(chalk.green.bold('  🦉 Rebuild complete!'));
      console.log(chalk.gray('  Fresh code is running — configuration and data are unchanged.'));
      console.log('');
      process.exit(0);
    });
}

/**
 * Build order for the tsc fallback — every package after the packages it
 * imports (see the workspace dependency graph). web-ui is excluded: it is a
 * Vite app, not a tsc project.
 */
const TSC_BUILD_ORDER = [
  'packages/core',
  'packages/reasoner',
  'packages/testkit',
  'packages/config',
  'packages/plugins',
  'packages/sandbox',
  'packages/scheduler',
  'packages/security',
  'packages/session-store',
  'packages/skills',
  'packages/channels',
  'packages/semantic-memory',
  'packages/providers',
  'packages/media',
  'packages/nodes',
  'packages/tools',
  'packages/agent-runtime',
  'apps/gateway',
  'apps/cli',
];

/**
 * Build all packages. Tries `pnpm build` (the project standard, via
 * Turborepo) first; if pnpm is not available, falls back to compiling each
 * package with the local TypeScript compiler in dependency order — no
 * external package manager required.
 */
async function runBuild(repoRoot: string): Promise<boolean> {
  // Stale .turbo caches can mask source changes — clear them, as install.sh does.
  for (const dir of ['.turbo', 'node_modules/.cache/turbo']) {
    fs.rmSync(path.join(repoRoot, dir), { recursive: true, force: true });
  }

  // Attempt 1: pnpm build (Turborepo resolves order). Turbo itself needs a
  // package-manager binary, so this only works when pnpm is installed.
  if (await tryRun('pnpm', ['build'], repoRoot)) return true;

  // Attempt 2: compile each package with tsc, in dependency order. Needs only
  // the vendored TypeScript compiler — no pnpm, no turbo, no PATH lookups.
  const tsc = path.join(repoRoot, 'node_modules', '.bin', 'tsc');
  if (!fs.existsSync(tsc)) {
    console.log(chalk.red('  Neither pnpm nor a local TypeScript compiler is available.'));
    return false;
  }
  console.log(chalk.gray('  (pnpm unavailable — compiling each package with tsc in dependency order)'));
  console.log('');

  for (const pkg of TSC_BUILD_ORDER) {
    const pkgDir = path.join(repoRoot, pkg);
    if (!fs.existsSync(path.join(pkgDir, 'tsconfig.json'))) continue;
    process.stdout.write(chalk.gray(`    ${pkg} ... `));
    const ok = await tryRun(tsc, ['-p', 'tsconfig.json'], pkgDir, /* quiet */ true);
    if (!ok) {
      console.log(chalk.red('FAILED'));
      console.log('');
      // Re-run so the compiler errors are visible to the user.
      await tryRun(tsc, ['-p', 'tsconfig.json'], pkgDir);
      return false;
    }
    console.log(chalk.green('ok'));
  }
  return true;
}

/**
 * Spawn a command, resolve true on exit code 0.
 * Streams output to the terminal unless `quiet` is set.
 */
function tryRun(cmd: string, args: string[], cwd: string, quiet = false): Promise<boolean> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: quiet ? 'ignore' : 'inherit' });
    } catch {
      resolve(false);
      return;
    }
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}
