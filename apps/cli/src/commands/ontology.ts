 
import { Command } from 'commander';
import chalk from 'chalk';


import { loadConfig } from '@ontofelia/config';



export function registerOntologyCommand(program: Command) {
  // ---- ONTOLOGY COMMANDS ----
  const ontologyCmd = program.command('ontology').description('Manage ontology and reasoning');
  
  ontologyCmd
    .command('versions')
    .description('List ontology versions')
    .action(async () => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/ontology/versions`, {
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const list = await res.json() as Record<string, unknown>[];
        console.log(chalk.blue.bold(`\\nOntology Versions (${list.length}):`));
        list.forEach(v => {
          const active = v.active ? chalk.green(' [ACTIVE]') : '';
          console.log(`- ${chalk.green(v.version)}: ${v.description || 'No description'} (${new Date(v.createdAt as string).toLocaleString()})${active}`);
        });
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to list versions: ${(err as Error).message}`));
      }
    });
  
  ontologyCmd
    .command('proposals')
    .description('List ontology proposals')
    .action(async () => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/ontology/proposals`, {
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const list = await res.json() as Record<string, unknown>[];
        console.log(chalk.blue.bold(`\\nOntology Proposals (${list.length}):`));
        list.forEach(p => {
          let statusColor = chalk.gray;
          if (p.status === 'approved') statusColor = chalk.green;
          if (p.status === 'rejected') statusColor = chalk.red;
          if (p.status === 'pending') statusColor = chalk.yellow;
          
          console.log(`- ${chalk.blue(p.id)}: ${p.description} [${statusColor(p.status)}]`);
        });
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to list proposals: ${(err as Error).message}`));
      }
    });
  
  ontologyCmd
    .command('approve')
    .description('Approve a proposal')
    .argument('<id>', 'Proposal ID')
    .action(async (id) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/ontology/proposals/${id}/approve`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        const data = await res.json() as { version: { version: string } };
        console.log(chalk.green(`✔ Proposal approved. New version: ${data.version.version}`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to approve proposal: ${(err as Error).message}`));
      }
    });
  
  ontologyCmd
    .command('rollback')
    .description('Rollback to a specific version')
    .argument('<version>', 'Version string (e.g. v001)')
    .action(async (version) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/ontology/rollback`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ version })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Rolled back to ${version}`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to rollback: ${(err as Error).message}`));
      }
    });
  
}