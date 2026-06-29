import { LoadedPlugin, PluginLoader } from './loader.js';
import { DefaultPluginContext, PluginCommand } from './context.js';
import { ToolDefinition, createLogger } from '@ontofelia/core';

export class PluginRegistry {
  private plugins = new Map<string, LoadedPlugin>();
  private contexts = new Map<string, DefaultPluginContext>();
  private loader = new PluginLoader();
  private logger = createLogger('PluginRegistry');

  register(plugin: LoadedPlugin): void {
    this.plugins.set(plugin.manifest.name, plugin);
    if (!plugin.trusted) {
      this.logger.warn(`Plugin '${plugin.manifest.name}' is registered but NOT trusted.`);
    }
  }

  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  list(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  getActive(): LoadedPlugin[] {
    return this.list().filter(p => p.active);
  }

  async activate(name: string, allowUntrusted: boolean = false): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new Error(`Plugin not found: ${name}`);
    if (plugin.active) return;

    await this.loader.loadModule(plugin, allowUntrusted);

    if (plugin.module && typeof plugin.module.activate === 'function') {
      const context = new DefaultPluginContext(plugin.manifest.config || {}, {
        info: (msg) => this.logger.info(`[${name}] ${msg}`),
        warn: (msg) => this.logger.warn(`[${name}] ${msg}`),
        error: (msg) => this.logger.error(`[${name}] ${msg}`)
      });
      this.contexts.set(name, context);
      
      await plugin.module.activate(context);
    }
    
    plugin.active = true;
    this.logger.info(`Plugin activated: ${name}`);
  }

  async deactivate(name: string): Promise<void> {
    const plugin = this.plugins.get(name);
    if (!plugin) throw new Error(`Plugin not found: ${name}`);
    if (!plugin.active) return;

    if (plugin.module && typeof plugin.module.deactivate === 'function') {
      await plugin.module.deactivate();
    }
    
    this.contexts.delete(name);
    plugin.active = false;
    this.logger.info(`Plugin deactivated: ${name}`);
  }

  getCommands(): Array<{ name: string; plugin: string; handler: PluginCommand['handler'] }> {
    const allCmds: Array<{ name: string; plugin: string; handler: PluginCommand['handler'] }> = [];
    
    for (const [pluginName, context] of this.contexts.entries()) {
      const plugin = this.plugins.get(pluginName);
      if (plugin?.active) {
        for (const cmd of context.commands) {
          allCmds.push({ name: cmd.name, plugin: pluginName, handler: cmd.handler });
        }
      }
    }
    
    return allCmds;
  }

  getTools(): ToolDefinition[] {
    const allTools: ToolDefinition[] = [];
    
    for (const [pluginName, context] of this.contexts.entries()) {
      const plugin = this.plugins.get(pluginName);
      if (plugin?.active) {
        allTools.push(...context.tools);
      }
    }
    
    return allTools;
  }
}
