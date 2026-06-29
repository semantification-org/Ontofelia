import { describe, it, expect } from 'vitest';
import { PluginLoader } from '../loader.js';

describe('PluginLoader trust validation', () => {
  const loader = new PluginLoader();

  it('rejects untrusted plugin activation', async () => {
    // we mock a loaded plugin
    const plugin = {
      manifest: { name: 'untrusted-plugin', version: '1.0.0', description: 'test', entryPoint: 'index.js', type: 'system' as const, permissions: [] },
      basePath: '/test',
      active: false,
      trusted: false
    } as unknown as Parameters<typeof loader.loadModule>[0];

    await expect(loader.loadModule(plugin, false)).rejects.toThrow(/not trusted/);
  });

  it('allows untrusted plugin activation if allowUntrusted is true', async () => {
    const plugin = {
      manifest: { name: 'untrusted-plugin', version: '1.0.0', description: 'test', entryPoint: 'index.js', type: 'system' as const, permissions: [] },
      basePath: '/test',
      active: false,
      trusted: false
    } as unknown as Parameters<typeof loader.loadModule>[0];

    // Should throw a module resolution error instead of trust error
    await expect(loader.loadModule(plugin, true)).rejects.toThrow(/Failed to load plugin module/);
  });

  it('allows trusted plugin activation', async () => {
    const plugin = {
      manifest: { name: 'trusted-plugin', version: '1.0.0', description: 'test', entryPoint: 'index.js', type: 'system' as const, permissions: [] },
      basePath: '/test',
      active: false,
      trusted: true
    } as unknown as Parameters<typeof loader.loadModule>[0];

    await expect(loader.loadModule(plugin, false)).rejects.toThrow(/Failed to load plugin module/);
  });

  it('rejects plugin with missing manifest fields', () => {
    const invalidManifest = { version: '1.0.0' }; // missing name, type, entryPoint
    expect(() => loader.validateManifest(invalidManifest)).toThrow(/missing required fields/);
  });
});
