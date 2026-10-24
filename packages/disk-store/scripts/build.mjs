#!/usr/bin/env node
/**
 * Build wrapper for the native @ontofelia/disk-store addon.
 *
 * The addon bundles RocksDB (a C++ build of several minutes and a C++ toolchain
 * plus libclang), so it is opt-in:
 *   1. a matching prebuilt `.node` binary already present -> skip;
 *   2. ONTOFELIA_BUILD_DISK_STORE=1 not set -> skip with one clear line, exit 0;
 *   3. otherwise compile from source with the package-local `napi` CLI.
 */
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const { platform, arch } = process;

let expectedFile = '';
if (platform === 'win32') {
  expectedFile = `disk-store.win32-${arch}-msvc.node`;
} else if (platform === 'darwin') {
  expectedFile = `disk-store.darwin-${arch}.node`;
} else if (platform === 'linux') {
  expectedFile = `disk-store.linux-${arch}`;
}

const hasPrebuilt = readdirSync(pkgDir).some((f) => {
  if (!f.endsWith('.node')) return false;
  if (platform === 'linux' && expectedFile) return f.startsWith(expectedFile);
  return f === expectedFile;
});

if (hasPrebuilt) {
  console.log(`[disk-store] native binary for ${platform}-${arch} already present - skipping cargo build`);
  process.exit(0);
}

if (process.env.ONTOFELIA_BUILD_DISK_STORE !== '1') {
  console.log('[disk-store] skipped: set ONTOFELIA_BUILD_DISK_STORE=1 to build the native on-disk store');
  process.exit(0);
}

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
    '[disk-store] cannot build the native addon: the Rust toolchain (cargo) was not found.\n' +
    '  Install Rust via https://rustup.rs (a C++ compiler and libclang are also required\n' +
    '  to compile the bundled RocksDB) and re-run the build.'
  );
  process.exit(1);
}

console.log('[disk-store] compiling from source with napi/cargo (the bundled RocksDB takes several minutes)...');
try {
  const binName = platform === 'win32' ? 'napi.cmd' : 'napi';
  const napiBin = join(pkgDir, 'node_modules', '.bin', binName);
  const args = ['build', '--platform', '--release'];
  execFileSync(existsSync(napiBin) ? napiBin : 'napi', args, {
    cwd: pkgDir,
    stdio: 'inherit',
    shell: platform === 'win32',
  });
} catch {
  console.error(
    '[disk-store] native build failed.\n' +
    '  Re-run with more output: cd packages/disk-store && pnpm build:native'
  );
  process.exit(1);
}
