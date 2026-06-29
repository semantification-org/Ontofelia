 
import { Command } from 'commander';
import chalk from 'chalk';


import { loadConfig } from '@ontofelia/config';



export function registerHealthCommand(program: Command) {
  // ---- HEALTH COMMAND ----
  program
    .command('health')
    .description('Check system health')
    .option('--json', 'Output as JSON')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/health`);
        
        const data = await res.json() as { status?: string };
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          if (res.ok && data.status === 'ok') {
            console.log(chalk.green('✔ Gateway is healthy'));
          } else {
            console.log(chalk.red('✘ Gateway is unhealthy'));
          }
        }
      } catch (err: unknown) {
        console.error(chalk.red(`Health check failed: Gateway may not be running. (${(err as Error).message})`));
        process.exit(1);
      }
    });
  
}