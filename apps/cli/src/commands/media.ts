 
import { Command } from 'commander';
import chalk from 'chalk';


import { loadConfig } from '@ontofelia/config';



export function registerMediaCommand(program: Command) {
  // ---- MEDIA COMMANDS ----
  const mediaCmd = program.command('media').description('Manage media files');
  
  mediaCmd
    .command('list')
    .description('List media files')
    .action(async () => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/media`, {
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const list = await res.json() as Record<string, unknown>[];
        console.log(chalk.blue.bold(`\nMedia Files (${list.length}):`));
        list.forEach(m => {
          console.log(`- ${chalk.blue(m.id)}: ${m.filename} (${m.mimeType}) [${(Number(m.sizeBytes) / 1024).toFixed(1)} KB]`);
        });
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to list media: ${(err as Error).message}`));
      }
    });
  
  mediaCmd
    .command('delete')
    .description('Delete a media file')
    .argument('<id>', 'Media ID')
    .action(async (id) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/media/${id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        console.log(chalk.green(`✔ Media ${id} deleted.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to delete media: ${(err as Error).message}`));
      }
    });
  
}