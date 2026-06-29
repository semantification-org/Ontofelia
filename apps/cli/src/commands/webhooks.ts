 
import { Command } from 'commander';
import { input, select, confirm } from '@inquirer/prompts';
import chalk from 'chalk';


import { loadConfig } from '@ontofelia/config';



export function registerWebhooksCommand(program: Command) {
  // ---- WEBHOOKS COMMANDS ----
  const webhooksCmd = program.command('webhooks').description('Manage webhooks');
  
  webhooksCmd
    .command('list')
    .description('List webhooks')
    .action(async () => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/webhooks`, {
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const hooks = await res.json() as Record<string, unknown>[];
        console.log(chalk.blue.bold(`\nWebhooks (${hooks.length}):`));
        hooks.forEach(h => {
          console.log(`- ${chalk.green(h.id)}: ${h.name} | Path: ${h.path} | Agent: ${h.agentId} | Auth: ${h.authMethod} | Enabled: ${h.enabled}`);
        });
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to list webhooks: ${(err as Error).message}`));
      }
    });
  
  webhooksCmd
    .command('create')
    .description('Create a webhook')
    .action(async () => {
      try {
        const name = await input({ message: 'Webhook name:' });
        const hookPath = await input({ message: 'URL Path (e.g. /github):' });
        const authMethod = await select({
          message: 'Auth Method:',
          choices: [
            { name: 'HMAC-SHA256 (e.g. GitHub)', value: 'hmac-sha256' },
            { name: 'Bearer Token', value: 'bearer' }
          ]
        });
        const secret = await input({ message: 'Secret/Token:' });
        const agentId = await input({ message: 'Agent ID:', default: 'default' });
        const promptTxt = await input({ message: 'Prefix prompt (optional):' });
        const isEnabled = await confirm({ message: 'Enable webhook?', default: true });
        
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/webhooks`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, path: hookPath, secret, authMethod, agentId, prompt: promptTxt, enabled: isEnabled, maxPayloadBytes: 1048576, replayWindowMs: 300000 })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Webhook created.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to create webhook: ${(err as Error).message}`));
      }
    });
  
  webhooksCmd
    .command('delete')
    .description('Delete a webhook')
    .argument('<id>', 'Webhook ID')
    .action(async (id) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/webhooks/${id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Webhook ${id} deleted.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to delete webhook: ${(err as Error).message}`));
      }
    });
  
}