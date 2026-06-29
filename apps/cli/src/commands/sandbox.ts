 
import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';


import { loadConfig } from '@ontofelia/config';



export function registerSandboxCommand(program: Command) {
  // ---- SANDBOX COMMANDS ----
  const sandboxCmd = program.command('sandbox').description('Manage sandboxes');
  
  sandboxCmd
    .command('list')
    .description('List active sandboxes')
    .action(async () => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/sandboxes`, {
          headers: { 'Authorization': `Bearer ${config.gateway.token}` }
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        
        const list = await res.json() as Record<string, unknown>[];
        console.log(chalk.blue.bold(`\nActive Sandboxes (${list.length}):`));
        list.forEach(s => {
          console.log(`- ${chalk.green(s.id)} [${s.status}] | Scope: ${s.scope} | Access: ${s.workspaceAccess} | Age: ${s.createdAt}`);
        });
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to list sandboxes: ${(err as Error).message}`));
      }
    });
  
  sandboxCmd
    .command('prune')
    .description('Prune inactive sandboxes')
    .option('--idle <hours>', 'Idle hours threshold')
    .option('--age <days>', 'Max age in days threshold')
    .action(async (options) => {
      try {
        const config = await loadConfig();
        const res = await fetch(`http://127.0.0.1:${config.gateway.port}/api/sandboxes/prune`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.gateway.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ idleHours: options.idle ? parseFloat(options.idle) : undefined, maxAgeDays: options.age ? parseFloat(options.age) : undefined })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} - ${await res.text()}`);
        const data = await res.json() as { removed: number };
        console.log(chalk.green(`✔ Pruned ${data.removed} sandboxes.`));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to prune sandboxes: ${(err as Error).message}`));
      }
    });
  
  sandboxCmd
    .command('build')
    .description('Build the Docker image for Sandboxing')
    .action(async () => {
      try {
        console.log(chalk.blue('Building ontofelia-sandbox image...'));
        // Find workspace root. Since CLI is running, let's assume PWD is the root, or find it
        const rootDir = process.cwd();
        const scriptPath = path.join(rootDir, 'packages', 'sandbox', 'scripts', 'build-image.sh');
        try {
          await fs.access(scriptPath);
        } catch {
          console.error(chalk.red('Could not find build-image.sh. Please run this command from the Ontofelia workspace root.'));
          process.exit(1);
        }
        const child = execFile(scriptPath);
        child.stdout?.pipe(process.stdout);
        child.stderr?.pipe(process.stderr);
        await new Promise<void>((resolve, reject) => {
          child.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Build script exited with code ${code}`));
          });
        });
        console.log(chalk.green('✔ Sandbox image built successfully.'));
      } catch (err: unknown) {
        console.error(chalk.red(`Failed to build sandbox image: ${(err as Error).message}`));
      }
    });
  
}