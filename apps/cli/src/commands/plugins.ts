 
import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';


import { loadConfig } from '@ontofelia/config';



export function registerPluginsCommand(program: Command) {
  // ---- PLUGINS COMMANDS ----
  const pluginsCmd = program.command('plugins').description('Manage plugins');
  
  pluginsCmd
    .command('list')
    .description('List installed plugins')
    .action(async () => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/plugins`, {
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const plugins = await res.json() as { name: string, version: string, description: string, active: boolean, trusted: boolean }[];
        console.log(chalk.blue.bold(`\nInstalled Plugins (${plugins.length}):`));
        plugins.forEach(p => {
          const status = p.active ? chalk.green('active') : chalk.gray('inactive');
          const trust = p.trusted ? '' : chalk.yellow(' ⚠ UNTRUSTED');
          console.log(`- ${chalk.green(p.name)} v${p.version}: ${p.description} [${status}]${trust}`);
        });
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to list plugins: ${(err as Error).message}`));
      }
    });
  
  pluginsCmd
    .command('install')
    .description('Install a plugin from a local path')
    .argument('<path>', 'Path to the plugin directory')
    .action(async (pluginPath) => {
      try {
        const resolvedPath = path.resolve(pluginPath);
        const targetDir = path.join(os.homedir(), '.ontofelia', 'plugins', path.basename(resolvedPath));
        
        await fs.cp(resolvedPath, targetDir, { recursive: true });
        console.log(chalk.green(`✔ Plugin installed to ${targetDir}. Please restart the gateway to load it.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to install plugin: ${(err as Error).message}`));
      }
    });
  
  pluginsCmd
    .command('activate')
    .description('Activate a plugin')
    .argument('<name>', 'Name of the plugin')
    .action(async (name) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/plugins/${name}/activate`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Plugin ${name} activated.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to activate plugin: ${(err as Error).message}`));
      }
    });
  
  pluginsCmd
    .command('deactivate')
    .description('Deactivate a plugin')
    .argument('<name>', 'Name of the plugin')
    .action(async (name) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/plugins/${name}/deactivate`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Plugin ${name} deactivated.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to deactivate plugin: ${(err as Error).message}`));
      }
    });
  
}