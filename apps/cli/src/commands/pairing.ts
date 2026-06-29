 
import { Command } from 'commander';
import chalk from 'chalk';


import { loadConfig } from '@ontofelia/config';



export function registerPairingCommand(program: Command) {
  // ---- PAIRING COMMANDS ----
  const pairingCmd = program.command('pairing').description('Manage channel pairing requests');
  
  pairingCmd
    .command('list')
    .description('List pending pairing requests')
    .argument('[channel]', 'Filter by channel')
    .action(async (channel) => {
      try {
        const config = await loadConfig();
        const url = new URL(`http://127.0.0.1:${config.gateway.port}/api/pairing`);
        if (channel) url.searchParams.set('channel', channel);
        
        const res = await fetch(url.toString(), { headers: { 'Authorization': `Bearer ${config.gateway.token}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const requests = await res.json() as { code: string, channel: string, senderId: string, displayName?: string, createdAt: string }[];
        console.log(chalk.blue.bold(`\nPending Pairing Requests (${requests.length}):`));
        requests.forEach(r => {
          console.log(`${chalk.yellow(r.code)}: ${r.channel} user ${r.displayName || r.senderId} (${r.senderId}) - requested at ${new Date(r.createdAt).toLocaleString()}`);
        });
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to list pairing requests: ${(err as Error).message}`));
      }
    });
  
  pairingCmd
    .command('approve')
    .description('Approve a pairing request')
    .argument('<code>', 'The pairing code')
    .action(async (code) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/pairing/approve`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Pairing request ${code} approved.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to approve pairing request: ${(err as Error).message}`));
      }
    });
  
  pairingCmd
    .command('reject')
    .description('Reject a pairing request')
    .argument('<code>', 'The pairing code')
    .action(async (code) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/pairing/reject`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ code })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Pairing request ${code} rejected.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to reject pairing request: ${(err as Error).message}`));
      }
    });
  
}