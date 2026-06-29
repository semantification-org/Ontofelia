 
import { Command } from 'commander';
import chalk from 'chalk';


import { loadConfig } from '@ontofelia/config';



export function registerSkillsCommand(program: Command) {
  // ---- SKILLS COMMANDS ----
  const skillsCmd = program.command('skills').description('Manage skills');
  skillsCmd
    .command('list')
    .description('List available skills')
    .action(async () => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/skills`, {
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const skills = await res.json() as { name: string, description: string, source: string }[];
        console.log(chalk.blue.bold(`\nAvailable Skills (${skills.length}):`));
        skills.forEach(s => {
          console.log(`- ${chalk.green(s.name)}: ${s.description} [${s.source}]`);
        });
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to list skills: ${(err as Error).message}`));
      }
    });
  
}