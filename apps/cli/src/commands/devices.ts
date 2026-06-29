 
import { Command } from 'commander';
import chalk from 'chalk';


import { loadConfig } from '@ontofelia/config';



export function registerDevicesCommand(program: Command) {
  // ---- DEVICES COMMANDS ----
  const devicesCmd = program.command('devices').description('Manage connected nodes/devices');
  
  devicesCmd
    .command('list')
    .description('List connected devices')
    .action(async () => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/devices`, {
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const list = await res.json() as Record<string, unknown>[];
        console.log(chalk.blue.bold(`\nConnected Devices (${list.length}):`));
        list.forEach(d => {
          const color = d.status === 'paired' ? chalk.green : d.status === 'pending' ? chalk.yellow : chalk.gray;
          console.log(`- ${chalk.blue(d.id)}: ${d.name} (${d.type}) [${color(d.status)}]`);
        });
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to list devices: ${(err as Error).message}`));
      }
    });
  
  devicesCmd
    .command('approve')
    .description('Approve a device pairing')
    .argument('<code>', 'Pairing Code')
    .action(async (code) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/devices/${code}/approve`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Pairing approved for ${code}`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to approve: ${(err as Error).message}`));
      }
    });
  
  devicesCmd
    .command('reject')
    .description('Reject a device pairing')
    .argument('<code>', 'Pairing Code')
    .action(async (code) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/devices/${code}/reject`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Pairing rejected for ${code}`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to reject: ${(err as Error).message}`));
      }
    });
  
}