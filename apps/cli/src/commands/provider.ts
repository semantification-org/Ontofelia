 
import { Command } from 'commander';
import chalk from 'chalk';


import { loadConfig } from '@ontofelia/config';



export function registerProviderCommand(program: Command) {
  // ---- PROVIDER COMMANDS ----
  const providerCmd = program.command('provider').description('Manage LLM provider');
  
  providerCmd
    .command('status')
    .description('Show provider status and active model')
    .action(async () => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/provider`, {
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const data = await res.json() as { name: string; model: string; healthy: boolean };
        console.log(chalk.blue.bold(`\nProvider Status:`));
        console.log(`- Name: ${chalk.cyan(data.name)}`);
        console.log(`- Model: ${chalk.cyan(data.model)}`);
        console.log(`- Health: ${data.healthy ? chalk.green('✔ Healthy') : chalk.red('✖ Unhealthy')}`);
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to get provider status: ${(err as Error).message}`));
      }
    });
  
  providerCmd
    .command('models')
    .description('List available models')
    .action(async () => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/models`, {
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const list = await res.json() as { id: string; name: string }[];
        console.log(chalk.blue.bold(`\nAvailable Models (${list.length}):`));
        list.forEach(m => {
          console.log(`- ${chalk.blue(m.id)}: ${m.name}`);
        });
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to list models: ${(err as Error).message}`));
      }
    });
  
  providerCmd
    .command('test')
    .description('Send a test message to the provider')
    .argument('[text]', 'Message to send', 'Hello, are you there?')
    .action(async (text) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/provider/test`, {
          method: 'POST',
          headers: { 
            'Authorization': `Bearer ${config.gateway.token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ text })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
         
        const data = await res.json() as Record<string, unknown>;
        console.log(chalk.green(`\n✔ Response received:`));
        console.log(chalk.white(data.content || JSON.stringify(data)));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to send test message: ${(err as Error).message}`));
      }
    });
  
}