import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { OntofeliaConfig } from '@ontofelia/config';
import { initPluginsAndSkills } from '../plugins.js';

// Regression for #1057: `ontofelia plugins install` copies a plugin into
// ~/.ontofelia/plugins, but the gateway loader only ever read the bundled
// directory — so installed plugins were never loaded (silent no-op). These
// tests point HOME at a temp dir, drop a plugin under ~/.ontofelia/plugins,
// and assert the loader picks it up.

const silentLogger = { warn() {}, info() {}, error() {}, debug() {} } as unknown as Parameters<typeof initPluginsAndSkills>[2];

function writeUserPlugin(home: string, name: string) {
  const dir = path.join(home, '.ontofelia', 'plugins', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify({
    name,
    version: '1.0.0',
    description: `test plugin ${name}`,
    entryPoint: 'index.js',
    type: 'system',
    permissions: [],
  }));
}

describe('initPluginsAndSkills — user plugin directory (#1057)', () => {
  let tmpHome: string;
  let prevHome: string | undefined;
  // currentDir points into the temp tree so the (absent) bundled plugin/skill
  // dirs resolve under tmp and are simply skipped.
  let currentDir: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'onto-plugins-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmpHome;
    currentDir = path.join(tmpHome, 'app', 'src');
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('loads a plugin installed into ~/.ontofelia/plugins', async () => {
    writeUserPlugin(tmpHome, 'user-plug');
    const config = { plugins: {} } as unknown as OntofeliaConfig;

    const { pluginRegistry } = await initPluginsAndSkills(config, currentDir, silentLogger);

    const loaded = pluginRegistry.list().find(p => p.manifest.name === 'user-plug');
    expect(loaded).toBeDefined();
    // Security-critical: an untrusted user plugin is registered (visible in
    // /api/plugins) but NOT activated — installing must never auto-run code.
    expect(loaded!.trusted).toBe(false);
    expect(loaded!.active).toBe(false);
  });

  it('marks a user plugin trusted when listed in config.plugins.trusted', async () => {
    writeUserPlugin(tmpHome, 'user-plug');
    const config = { plugins: { trusted: ['user-plug'] } } as unknown as OntofeliaConfig;

    const { pluginRegistry } = await initPluginsAndSkills(config, currentDir, silentLogger);

    const loaded = pluginRegistry.list().find(p => p.manifest.name === 'user-plug');
    expect(loaded).toBeDefined();
    expect(loaded!.trusted).toBe(true);
  });

  it('does not crash when the user plugin directory is absent', async () => {
    const config = { plugins: {} } as unknown as OntofeliaConfig;
    const { pluginRegistry } = await initPluginsAndSkills(config, currentDir, silentLogger);
    expect(pluginRegistry.list()).toEqual([]);
  });
});
