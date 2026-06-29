 
import { Command } from 'commander';
import { input, confirm } from '@inquirer/prompts';
import chalk from 'chalk';


import { loadConfig } from '@ontofelia/config';



export function registerCronCommand(program: Command) {
  // ---- CRON COMMANDS ----
  const cronCmd = program.command('cron').description('Manage cron jobs');
  
  cronCmd
    .command('list')
    .description('List all jobs')
    .action(async () => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/cron`, {
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const { cronJobs, oneTimeJobs } = await res.json() as { cronJobs: Record<string, unknown>[], oneTimeJobs: Record<string, unknown>[] };
        
        console.log(chalk.blue.bold(`\nCron Jobs (${cronJobs.length}):`));
        cronJobs.forEach((j: Record<string, unknown>) => {
          console.log(`- ${chalk.green(j.id)}: ${j.name} | ${j.cron} | Agent: ${j.agentId} | Enabled: ${j.enabled} | Next: ${j.nextRun || 'N/A'}`);
        });
        
        console.log(chalk.blue.bold(`\nOne-Time Jobs (${oneTimeJobs.length}):`));
        oneTimeJobs.forEach((j: Record<string, unknown>) => {
          console.log(`- ${chalk.green(j.id)}: ${j.name} | ${j.runAt} | Agent: ${j.agentId} | Status: ${j.status}`);
        });
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to list jobs: ${(err as Error).message}`));
      }
    });
  
  cronCmd
    .command('add')
    .description('Add a new cron job')
    .action(async () => {
      try {
        const name = await input({ message: 'Job name:' });
        const cronExpr = await input({ message: 'Cron expression (e.g. 0 * * * *):' });
        const agentId = await input({ message: 'Agent ID:', default: 'default' });
        const promptTxt = await input({ message: 'Prompt for the agent:' });
        const isEnabled = await confirm({ message: 'Enable job?', default: true });
        
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/cron`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, cron: cronExpr, agentId, prompt: promptTxt, enabled: isEnabled })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Job added.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to add job: ${(err as Error).message}`));
      }
    });
  
  cronCmd
    .command('remove')
    .description('Remove a job')
    .argument('<id>', 'Job ID')
    .action(async (id) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/cron/${id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Job ${id} removed.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to remove job: ${(err as Error).message}`));
      }
    });
  
  cronCmd
    .command('run')
    .description('Trigger a job manually')
    .argument('<id>', 'Job ID')
    .action(async (id) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/cron/${id}/trigger`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Job ${id} triggered.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to trigger job: ${(err as Error).message}`));
      }
    });
  
}