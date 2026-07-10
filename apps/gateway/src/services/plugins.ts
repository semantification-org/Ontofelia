import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import type { OntofeliaConfig } from '@ontofelia/config';
import type { Logger } from 'pino';
import { SkillLoader, SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginLoader, PluginRegistry } from '@ontofelia/plugins';

export async function initPluginsAndSkills(config: OntofeliaConfig, currentDir: string, logger: Logger) {
  // Load Skills
  const skillLoader = new SkillLoader();
  const skillRegistry = new SkillRegistry();
  const bundledSkillsPath = path.resolve(currentDir, '..', '..', 'skills', 'dist', 'bundled');
  const globalSkillsPath = path.join(os.homedir(), '.ontofelia', 'skills');
  const workspaceSkillsPath = path.resolve(currentDir, '..', '..', '..', 'skills');
  const skills = await skillLoader.loadAll(workspaceSkillsPath, globalSkillsPath, bundledSkillsPath);
  skills.forEach(s => skillRegistry.register(s));
  const skillExecutor = new SkillExecutor(skillRegistry);

  // Load Plugins — from the bundled directory AND the user directory that
  // `ontofelia plugins install` copies into (`~/.ontofelia/plugins`). Without
  // the user path, installed plugins were never loaded (silent no-op, #1057).
  const pluginLoader = new PluginLoader();
  const pluginRegistry = new PluginRegistry();
  const bundledPluginsPath = path.resolve(currentDir, '..', '..', 'plugins', 'dist', 'bundled');
  const globalPluginsPath = path.join(os.homedir(), '.ontofelia', 'plugins');
  const trusted = (config.plugins?.trusted as string[]) || [];
  const allowUntrusted = (config.plugins as { allowUntrusted?: boolean })?.allowUntrusted;
  const seen = new Set<string>();
  // Bundled first so a bundled plugin wins over a same-named user install.
  for (const basePath of [bundledPluginsPath, globalPluginsPath]) {
    let entries;
    try {
      entries = await fs.promises.readdir(basePath, { withFileTypes: true });
    } catch {
      continue; // directory absent (e.g. no user plugins installed yet)
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginPath = path.join(basePath, entry.name);
      try {
        const plugin = await pluginLoader.loadFromPath(pluginPath, trusted);
        if (seen.has(plugin.manifest.name)) {
          logger.warn(`Skipping duplicate plugin '${plugin.manifest.name}' from ${pluginPath} (already loaded)`);
          continue;
        }
        seen.add(plugin.manifest.name);
        pluginRegistry.register(plugin);
        // Activation still follows the trust policy: user-installed plugins are
        // untrusted by default and require `plugins.trusted`/allowUntrusted or a
        // manual `plugins activate` — installing must not auto-run untrusted code.
        if (plugin.trusted || allowUntrusted) {
          await pluginRegistry.activate(plugin.manifest.name, allowUntrusted);
        }
      } catch (e) {
        logger.warn(`Failed to load plugin from ${pluginPath}: ${(e as Error).message}`);
      }
    }
  }

  return { skillLoader, skillRegistry, skillExecutor, pluginLoader, pluginRegistry };
}
