import * as fs from 'fs/promises';
import * as path from 'path';
import { PluginManifest } from '@ontofelia/core';

export interface LoadedPlugin {
  manifest: PluginManifest;
  basePath: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  module?: any;         // Dynamisch geladenes Modul
  active: boolean;
  trusted: boolean;
}

export class PluginLoader {
  async loadFromPath(pluginPath: string, trustedList: string[] = []): Promise<LoadedPlugin> {
    const manifestPath = path.join(pluginPath, 'plugin.json');
    const content = await fs.readFile(manifestPath, 'utf-8');
    const manifest = this.validateManifest(JSON.parse(content));
    
    // A plugin is trusted ONLY if it is explicitly listed in the trustedList config
    const isTrusted = trustedList.includes(manifest.name);
    
    return {
      manifest,
      basePath: pluginPath,
      active: false,
      trusted: isTrusted
    };
  }

  validateManifest(manifest: unknown): PluginManifest {
    const m = manifest as PluginManifest;
    if (!m.name || !m.version || !m.description || !m.entryPoint) {
      throw new Error('Invalid Plugin Manifest: missing required fields');
    }
    return m;
  }

  async loadModule(plugin: LoadedPlugin, allowUntrusted: boolean = false): Promise<void> {
    if (plugin.module) return; // already loaded
    
    if (!plugin.trusted && !allowUntrusted) {
      throw new Error(`Plugin ${plugin.manifest.name} is not trusted. Please add it to config.plugins.trusted.`);
    }

    const modulePath = path.join(plugin.basePath, plugin.manifest.entryPoint);
    // Use import() for ESM.
    // Windows/local file paths may need file://.
    const fileUrl = 'file://' + path.resolve(modulePath);
    try {
      const imported = await import(fileUrl);
      plugin.module = imported.default || imported;
    } catch (e: unknown) {
      throw new Error(`Failed to load plugin module at ${fileUrl}: ${(e as Error).message}`);
    }
  }
}
