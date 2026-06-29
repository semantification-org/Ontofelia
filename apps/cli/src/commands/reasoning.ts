 
import { Command } from 'commander';
import chalk from 'chalk';


import { loadConfig } from '@ontofelia/config';



export function registerReasoningCommand(program: Command) {
  // ---- REASONING COMMANDS ----
  const reasoningCmd = program.command('reasoning').description('Manage reasoning and reflection');
  
  reasoningCmd
    .command('conflicts')
    .description('Show reasoning conflicts')
    .action(async () => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/reasoning/conflicts`, {
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const list = await res.json() as Record<string, unknown>[];
        console.log(chalk.red.bold(`\\nConflicts (${list.length}):`));
        list.forEach(c => {
          console.log(`- [${c.type}] ${c.description}`);
        });
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to get conflicts: ${(err as Error).message}`));
      }
    });
  
  reasoningCmd
    .command('reflect')
    .description('Trigger a memory reflection manually')
    .action(async () => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/reasoning/reflect`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        const data = await res.json() as { id: string, conflicts: unknown[], recentTriplesCount: number };
        console.log(chalk.green(`✔ Reflection ${data.id} finished. Found ${data.conflicts.length} conflicts. Processed ${data.recentTriplesCount} recent triples.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to trigger reflection: ${(err as Error).message}`));
      }
    });
  
}