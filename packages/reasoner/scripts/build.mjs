#!/usr/bin/env node
/**
 * Build wrapper for the native @ontofelia/reasoner addon.
 *
 * The compiled `.node` binary is checked into the repo, so an ordinary
 * install does not need a Rust toolchain. This script:
 *   1. skips the build entirely if a matching prebuilt binary exists;
 *   2. otherwise runs `napi build`, which requires `cargo`.
 *
 * `napi build` itself fails hard with "cargo: not found" when Rust is
 * missing — installing Rust is the installer's job (see install.sh).
 */
import { existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
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
  console.log(`[reasoner] prebuilt native binary for ${platform}-${arch} found — skipping cargo build`);
  process.exit(0);
}

console.log('[reasoner] no prebuilt binary — compiling with napi/cargo...');
try {
  // Run the `build:native` script so the locally-installed `napi` CLI
  // (a devDependency in this package's node_modules/.bin) is on PATH.
  execSync('npm run build:native', { cwd: pkgDir, stdio: 'inherit' });
} catch {
  console.error(
    '[reasoner] native build failed.\n' +
    '  This package needs the Rust toolchain (cargo) to compile.\n' +
    '  Install it via https://rustup.rs and re-run the build.'
  );
  process.exit(1);
}
