 
import { Command } from 'commander';
import chalk from 'chalk';


import { loadConfig } from '@ontofelia/config';



export function registerAllowlistCommand(program: Command) {
  // ---- ALLOWLIST COMMANDS ----
  const allowlistCmd = program.command('allowlist').description('Manage allowed users');
  
  allowlistCmd
    .command('list')
    .description('List allowed users')
    .argument('[channel]', 'Filter by channel')
    .action(async (channel) => {
      try {
        const config = await loadConfig();
        const url = new URL(`http://127.0.0.1:${config.gateway.port}/api/allowlist`);
        if (channel) url.searchParams.set('channel', channel);
        
        const res = await fetch(url.toString(), { headers: { 'Authorization': `Bearer ${config.gateway.token}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const list = await res.json() as { channel: string, senderId: string, displayName?: string, pairedAt: string, pairedBy: string }[];
        console.log(chalk.blue.bold(`\nAllowed Users (${list.length}):`));
        list.forEach(u => {
          console.log(`- ${u.channel}: ${u.displayName || u.senderId} (${u.senderId}) [paired via ${u.pairedBy} at ${new Date(u.pairedAt).toLocaleString()}]`);
        });
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to list allowlist: ${(err as Error).message}`));
      }
    });
  
  allowlistCmd
    .command('add')
    .description('Manually add a user to the allowlist')
    .argument('<channel>', 'The channel type')
    .argument('<id>', 'The sender ID')
    .option('--name <name>', 'Display name')
    .action(async (channel, id, options) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/allowlist`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel, senderId: id, displayName: options.name })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Added ${id} to ${channel} allowlist.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to add to allowlist: ${(err as Error).message}`));
      }
    });
  
  allowlistCmd
    .command('remove')
    .description('Remove a user from the allowlist')
    .argument('<channel>', 'The channel type')
    .argument('<id>', 'The sender ID')
    .action(async (channel, id) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/allowlist`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${config.gateway.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel, senderId: id })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Removed ${id} from ${channel} allowlist.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to remove from allowlist: ${(err as Error).message}`));
      }
    });
  
}