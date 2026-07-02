#!/usr/bin/env node
/**
 * Build wrapper for the native @ontofelia/reasoner addon.
 *
 * The compiled `.node` binary is NO LONGER checked into the repo (it is a
 * native artifact that nobody could verify was built from `src/lib.rs`, and
 * a stale committed copy silently diverges from the source). Instead:
 *   - CI builds it per-platform and publishes it as a workflow artifact /
 *     release asset (see .github/workflows/reasoner-build.yml);
 *   - a local build compiles it from source with `napi build`, which needs
 *     the Rust toolchain (`cargo`).
 *
 * This script:
 *   1. skips the build if a matching `.node` binary is already present
 *      (e.g. a previous local build, or a CI artifact dropped in place);
 *   2. otherwise checks for `cargo` and fails with an actionable message if
 *      it is missing;
 *   3. compiles the addon via the locally-installed `napi` CLI.
 */
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');

const { platform, arch } = process;
let expectedFile = '';
if (platform === 'win32') {
  expectedFile = `reasoner.win32-${arch}-msvc.node`;
} else if (platform === 'darwin') {
  expectedFile = `reasoner.darwin-${arch}.node`;
} else if (platform === 'linux') {
  expectedFile = `reasoner.linux-${arch}`;
}

const hasPrebuilt = readdirSync(pkgDir).some(f => {
  if (!f.endsWith('.node')) return false;
  if (platform === 'linux' && expectedFile) {
    return f.startsWith(expectedFile);
  }
  return f === expectedFile;
});

if (hasPrebuilt) {
  console.log(`[reasoner] native binary for ${platform}-${arch} already present — skipping cargo build`);
  process.exit(0);
}

// A Rust toolchain is mandatory from here on. Check it explicitly so we can
// emit a clear, actionable message instead of napi's terse "cargo: not found".
function hasCargo() {
  try {
    execSync('cargo --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!hasCargo()) {
  console.error(
    '[reasoner] cannot build the native addon: the Rust toolchain (cargo) was not found.\n' +
    '\n' +
    '  The reasoner is a Rust/N-API module compiled from packages/reasoner/src/lib.rs.\n' +
    '  Prebuilt binaries are no longer committed to the repo (they cannot be verified\n' +
    '  against source), so a Rust toolchain is required to build from a fresh clone.\n' +
    '\n' +
    '  Fix it one of these ways:\n' +
    '    • Run the project installer, which installs Rust for you when it is missing:\n' +
    '        bash install.sh            (see the rustup logic around install.sh:329)\n' +
    '    • Or install Rust manually via https://rustup.rs and re-run `pnpm build`.\n' +
    '    • Or drop a CI-built reasoner.<triple>.node into packages/reasoner/ (from the\n' +
    '      "reasoner-build" GitHub Actions workflow artifacts) to skip compilation.\n'
  );
  process.exit(1);
}

console.log('[reasoner] no native binary — compiling from source with napi/cargo...');
try {
  // Invoke the package-local `napi` CLI directly (installed by pnpm into this
  // package's node_modules/.bin) rather than shelling out to `npm run`, so the
  // build does not depend on npm being present in a pnpm monorepo.
  const binName = platform === 'win32' ? 'napi.cmd' : 'napi';
  const napiBin = join(pkgDir, 'node_modules', '.bin', binName);
  const args = ['build', '--platform', '--release'];
  if (existsSync(napiBin)) {
    execFileSync(napiBin, args, { cwd: pkgDir, stdio: 'inherit', shell: platform === 'win32' });
  } else {
    // Fallback: resolve `napi` from PATH (e.g. hoisted node_modules layouts).
    execFileSync('napi', args, { cwd: pkgDir, stdio: 'inherit', shell: platform === 'win32' });
  }
} catch {
  console.error(
    '[reasoner] native build failed.\n' +
    '  cargo is installed but `napi build` did not produce a binary.\n' +
    '  Re-run with more output: cd packages/reasoner && pnpm build:native'
  );
  process.exit(1);
}
