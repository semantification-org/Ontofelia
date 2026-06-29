 
import { Command } from 'commander';
import { confirm } from '@inquirer/prompts';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { getPidsByPort } from '../utils/process.js';




export function registerUninstallCommand(program: Command) {
  // ---- UNINSTALL COMMAND ----
  program
    .command('uninstall')
    .description('Completely uninstall Ontofelia from this system')
    .option('--yes', 'Skip confirmation prompt')
    .option('--keep-data', 'Keep ~/.ontofelia data (config, knowledge, sessions)')
    .action(async (options) => {
      console.log('');
      console.log(chalk.red.bold('  ⚠️  Ontofelia Uninstall'));
      console.log(chalk.gray('  This will remove:'));
      console.log(chalk.gray('    • Stop running gateway'));
      console.log(chalk.gray('    • Systemd daemon (if installed)'));
      console.log(chalk.gray('    • CLI command (~/.local/bin/ontofelia)'));
      if (!options.keepData) {
        console.log(chalk.gray('    • All data (~/.ontofelia — config, knowledge, sessions, logs)'));
      }
  
      console.log('');
  
      if (!options.yes) {
        const confirmed = await confirm({
          message: chalk.red('Really uninstall Ontofelia completely?'),
          default: false
        });
        if (!confirmed) {
          console.log(chalk.gray('Cancelled.'));
          process.exit(0);
        }
      }
  
      const { execSync } = await import('child_process');
  
      // 1. Stop gateway
      console.log(chalk.blue('  Stopping gateway...'));
      try {
        const pids = await getPidsByPort(18780);
        for (const pid of pids) {
          try { process.kill(pid, 'SIGTERM'); } catch {}
        }
      } catch {}
      const pidFile = path.join(os.homedir(), '.ontofelia', 'gateway.pid');
      await fs.unlink(pidFile).catch(() => {});
      console.log(chalk.green('  ✔ Gateway stopped'));
  
      // 2. Uninstall systemd daemon
      console.log(chalk.blue('  Removing systemd daemon...'));
      try {
        execSync('systemctl --user stop ontofelia 2>/dev/null', { stdio: 'pipe' });
        execSync('systemctl --user disable ontofelia 2>/dev/null', { stdio: 'pipe' });
      } catch {}
      const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'ontofelia.service');
      await fs.unlink(servicePath).catch(() => {});
      try { execSync('systemctl --user daemon-reload 2>/dev/null', { stdio: 'pipe' }); } catch {}
      console.log(chalk.green('  ✔ Daemon removed'));
  
      // 3. Remove CLI symlink
      console.log(chalk.blue('  Removing CLI command...'));
      const binDir = path.join(os.homedir(), '.local', 'bin');
      if (process.platform === 'win32') {
        await fs.unlink(path.join(binDir, 'ontofelia.cmd')).catch(() => {});
        await fs.unlink(path.join(binDir, 'ontofelia.ps1')).catch(() => {});
      } else {
        await fs.unlink(path.join(binDir, 'ontofelia')).catch(() => {});
      }
      console.log(chalk.green('  ✔ CLI removed'));
  
      // 4. Stop Triplestores (Fuseki / Oxigraph cleanup is via Gateway stop)
      console.log(chalk.blue('  Stopping Triplestores...'));
      try {
        const pids = await getPidsByPort(18787);
        for (const pid of pids) {
          try { process.kill(pid, 'SIGKILL'); } catch {}
        }
      } catch {}
      console.log(chalk.green('  ✔ Triplestores stopped'));
  
      // 5. Remove data directory
      if (!options.keepData) {
        console.log(chalk.blue('  Removing data (~/.ontofelia)...'));
        const dataDir = path.join(os.homedir(), '.ontofelia');
        await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
        console.log(chalk.green('  ✔ Data removed'));
      } else {
        console.log(chalk.yellow('  ⚠ Data preserved (--keep-data)'));
      }
  
      // 6. Remove PATH entry from shell rc / registry
      console.log(chalk.blue('  Cleaning shell config...'));
      if (process.platform === 'win32') {
        try {
          const binDir = path.join(os.homedir(), '.local', 'bin');
          const cleanPathCmd = `
            $userPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
            if ($userPath -like "*${binDir}*") {
              $paths = $userPath -split ";" | Where-Object { $_ -ne "${binDir}" -and $_ -ne "" }
              $newUserPath = $paths -join ";"
              [System.Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
            }
          `.replace(/\n/g, ' ').trim();
          execSync(`powershell -Command "${cleanPathCmd}"`, { stdio: 'ignore' });
          console.log(chalk.green('  ✔ Cleaned Windows User PATH'));
        } catch {}
      } else {
        for (const rcFile of ['.bashrc', '.zshrc', '.profile']) {
          const rcPath = path.join(os.homedir(), rcFile);
          try {
            const content = await fs.readFile(rcPath, 'utf-8');
            const cleaned = content
              .replace(/\n# Ontofelia CLI\n.*?local\/bin.*?\n/g, '\n')
              .replace(/\n# Ontofelia\n.*?local\/bin.*?\n/g, '\n');
            if (cleaned !== content) {
              await fs.writeFile(rcPath, cleaned);
              console.log(chalk.green(`  ✔ Cleaned ${rcFile}`));
            }
          } catch {}
        }
      }
  
  
  
      console.log('');
      console.log(chalk.green.bold('  🦉 Ontofelia has been uninstalled.'));
      console.log('');
      if (!options.keepData) {
        console.log(chalk.gray('  All data has been removed.'));
      } else {
        console.log(chalk.gray('  Data has been preserved under ~/.ontofelia.'));
      }
      console.log(chalk.gray('  Open a new terminal for the PATH change to take effect.'));
      console.log('');
      process.exit(0);
    });
  
}
