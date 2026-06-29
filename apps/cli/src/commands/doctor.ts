 
import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

import { saveConfig, validateConfig, getDefaultConfig } from '@ontofelia/config';



export function registerDoctorCommand(program: Command) {
  // ---- DOCTOR COMMAND ----
  program
    .command('doctor')
    .description('Check and repair configuration')
    .option('--repair', 'Repair configuration to defaults')
    .action(async (options) => {
      try {
        const baseDir = path.join(os.homedir(), '.ontofelia');
        const configPath = path.join(baseDir, 'ontofelia.json5');
        const content = await fs.readFile(configPath, 'utf-8');
        
        let parsed;
        try {
          const JSON5 = (await import('json5')).default;
          parsed = JSON5.parse(content);
        } catch {
          console.error(chalk.red('Invalid JSON5 in config file.'));
          process.exit(1);
        }
        
        const validationResult = validateConfig(parsed);
        if (validationResult.isOk()) {
          console.log(chalk.green('✔ Configuration is valid.'));
        } else {
          console.log(chalk.yellow('⚠ Configuration has issues:'));
          validationResult.error.forEach((err) => {
            console.log(chalk.yellow(`  - ${(err.path ?? []).map(String).join('.')}: ${err.message}`));
          });
          
          if (options.repair) {
            console.log(chalk.blue('Repairing configuration...'));
            const defaultConfig = getDefaultConfig();
            const { defu } = await import('defu');
            const merged = defu(parsed, defaultConfig);
            await saveConfig(merged, configPath);
            console.log(chalk.green('✔ Repaired and saved configuration.'));
          }
        }
  
        // Check session store directory
        const sessionDir = path.join(baseDir, 'agents', 'default', 'sessions');
        try {
          await fs.access(sessionDir);
          console.log(chalk.green('✔ Default Agent Session Store exists.'));
        } catch {
          console.log(chalk.yellow('⚠ Default Agent Session Store missing (will be created on first start).'));
        }
  
        // Check workspace
        const workspaceDir = path.join(baseDir, 'workspace');
        try {
          await fs.access(workspaceDir);
          console.log(chalk.green('✔ Workspace directory exists.'));
        } catch {
          console.log(chalk.yellow('⚠ Workspace directory missing.'));
        }
  
        // Check Fuseki Health
        try {
          const res = await fetch('http://127.0.0.1:18787/$/ping');
          if (res.ok) {
            console.log(chalk.green('✔ Fuseki Triplestore is healthy.'));
          } else {
            console.log(chalk.yellow('⚠ Fuseki Triplestore returned non-OK status.'));
          }
        } catch (_e) {
          console.log(chalk.yellow('⚠ Fuseki Triplestore is not reachable (maybe Gateway is stopped?).'));
        }
  
        // Check Docker Health
        try {
          const { stdout } = await execFileAsync('docker', ['info']);
          if (stdout.includes('Server Version')) {
            console.log(chalk.green('✔ Docker is available.'));
          }
        } catch (_e) {
          console.log(chalk.yellow('⚠ Docker is not available (Sandboxing will use Noop or fail).'));
        }
  
      } catch (err: unknown) {
        console.error(chalk.red(`Doctor failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
  
}