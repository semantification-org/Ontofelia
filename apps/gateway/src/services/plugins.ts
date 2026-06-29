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

  // Load Plugins
  const pluginLoader = new PluginLoader();
  const pluginRegistry = new PluginRegistry();
  const bundledPluginsPath = path.resolve(currentDir, '..', '..', 'plugins', 'dist', 'bundled');
  try {
    const entries = await fs.promises.readdir(bundledPluginsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const pluginPath = path.join(bundledPluginsPath, entry.name);
        try {
          const plugin = await pluginLoader.loadFromPath(pluginPath, config.plugins?.trusted as string[] || []);
          pluginRegistry.register(plugin);
          if (plugin.trusted || (config.plugins as { allowUntrusted?: boolean })?.allowUntrusted) {
            await pluginRegistry.activate(plugin.manifest.name, (config.plugins as { allowUntrusted?: boolean })?.allowUntrusted);
          }
        } catch (e) {
          logger.warn(`Failed to load plugin from ${pluginPath}: ${(e as Error).message}`);
        }
      }
    }
  } catch {
    // Ignore if no plugins found
  }

  return { skillLoader, skillRegistry, skillExecutor, pluginLoader, pluginRegistry };
}
