 
import { Command } from 'commander';
import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);

import { loadConfig, saveConfig } from '@ontofelia/config';



export function registerChannelCommand(program: Command) {
  // ---- CHANNEL COMMAND ----
  program
    .command('channel')
    .description('Configure channel integrations (Telegram, Discord)')
    .action(async () => {
      try {
        const config = await loadConfig();
  
         
        const channels = config.channels || {};
        const telegramEnabled = channels.telegram?.enabled || false;
        const discordEnabled = channels.discord?.enabled || false;
  
        console.log();
        console.log(chalk.bold('  📡 Channel Configuration'));
        console.log(chalk.gray(`  Telegram: ${telegramEnabled ? chalk.green('✅ Active') : chalk.yellow('⚪ Disabled')}`));
        console.log(chalk.gray(`  Discord:  ${discordEnabled ? chalk.green('✅ Active') : chalk.yellow('⚪ Disabled')}`));
        console.log();
  
        const channelChoice = await select({
          message: 'Which channel do you want to configure?',
          choices: [
            { 
              name: `📱 Telegram ${telegramEnabled ? '(active — reconfigure)' : '(set up)'}`,
              value: 'telegram' 
            },
            { 
              name: `💬 Discord ${discordEnabled ? '(active — reconfigure)' : '(set up)'}`,
              value: 'discord' 
            },
            { name: '❌ Cancel', value: 'cancel' },
          ],
        });
  
        if (channelChoice === 'cancel') {
          console.log(chalk.gray('  Cancelled.'));
          return;
        }
  
        if (channelChoice === 'telegram') {
          console.log();
          console.log(chalk.cyan('  📱 Set up Telegram bot'));
          console.log(chalk.gray('  1. Open Telegram and search for @BotFather'));
          console.log(chalk.gray('  2. Send /newbot and follow the instructions'));
          console.log(chalk.gray('  3. Copy the bot token'));
          console.log();
  
          const token = await input({
            message: 'Telegram Bot Token:',
            validate: (val: string) => {
              if (!val.trim()) return 'Token cannot be empty';
              if (!val.includes(':')) return 'Invalid token format (expected: 123456:ABC-DEF...)';
              return true;
            },
          });
  
           
          config.channels = {
             
            ...config.channels,
            telegram: {
              enabled: true,
              token: token.trim(),
              allowedChats: [],
            },
          };
  
          await saveConfig(config);
          console.log();
          console.log(chalk.green('  ✅ Telegram configured!'));
          console.log(chalk.gray('  Restart the gateway:'));
          console.log(chalk.white.bold('  ontofelia gateway restart'));
          console.log();
          console.log(chalk.gray('  Then you can message your bot in Telegram.'));
          console.log(chalk.gray('  New users must send /pair and be approved by an admin.'));
        }
  
        if (channelChoice === 'discord') {
          console.log();
          console.log(chalk.cyan('  💬 Set up Discord bot'));
          console.log(chalk.gray('  1. Go to https://discord.com/developers/applications'));
          console.log(chalk.gray('  2. Create a new application'));
          console.log(chalk.gray('  3. Under "Bot" → "Reset Token" → copy the token'));
          console.log();
  
          const token = await input({
            message: 'Discord Bot Token:',
            validate: (val: string) => {
              if (!val.trim()) return 'Token cannot be empty';
              return true;
            },
          });
  
           
          config.channels = {
             
            ...config.channels,
            discord: {
              enabled: true,
              token: token.trim(),
            },
          };
  
          await saveConfig(config);
          console.log();
          console.log(chalk.green('  ✅ Discord configured!'));
          console.log(chalk.gray('  Restart the gateway:'));
          console.log(chalk.white.bold('  ontofelia gateway restart'));
        }
  
      } catch (err: unknown) {
        console.error(chalk.red(`Configuration failed: ${(err as Error).message}`));
      }
    });
  
  const daemonCmd = program.command('daemon').description('Manage Ontofelia as a system service');
  
  daemonCmd.command('install').description('Install as systemd user service').action(async () => {
    const { execSync } = await import('child_process');
    const user = os.userInfo().username;
    const homeDir = os.homedir();
    const nodePath = process.execPath; // gets the current node binary path
    const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.js');
    
    const serviceContent = `[Unit]
  Description=Ontofelia AI Gateway
  After=network-online.target
  
  [Service]
  Type=simple
  ExecStart=${nodePath} ${cliPath} gateway run
  Restart=always
  RestartSec=5
  Environment=NODE_ENV=production
  WorkingDirectory=${homeDir}
  
  [Install]
  WantedBy=default.target
  `;
  
    const serviceDir = path.join(homeDir, '.config', 'systemd', 'user');
    await fs.mkdir(serviceDir, { recursive: true });
    const servicePath = path.join(serviceDir, 'ontofelia.service');
    await fs.writeFile(servicePath, serviceContent);
    
    execSync('systemctl --user daemon-reload');
    execSync('systemctl --user enable ontofelia');
    execSync('systemctl --user start ontofelia');
    
    try { execSync(`loginctl enable-linger ${user}`); } catch {}
    
    console.log(chalk.green('✅ Ontofelia daemon installed and started!'));
    console.log(chalk.gray(`   Service: ${servicePath}`));
    console.log(chalk.gray('   Status: ontofelia daemon status'));
  });
  
  daemonCmd.command('status').action(async () => {
    try {
      const { stdout } = await execFileAsync('systemctl', ['--user', 'status', 'ontofelia']);
      console.log(stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) { console.log(e.stdout || e.message); }
  });
  
  daemonCmd.command('logs').action(async () => {
    const { spawn } = await import('child_process');
    const child = spawn('journalctl', ['--user', '-u', 'ontofelia', '-f', '-n', '50'], { stdio: 'inherit' });
    child.on('exit', () => process.exit(0));
  });
  
  daemonCmd.command('uninstall').action(async () => {
    const { execSync } = await import('child_process');
    execSync('systemctl --user stop ontofelia', { stdio: 'pipe' });
    execSync('systemctl --user disable ontofelia', { stdio: 'pipe' });
    const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'ontofelia.service');
    await fs.unlink(servicePath).catch(() => {});
    execSync('systemctl --user daemon-reload');
    console.log(chalk.green('✅ Ontofelia daemon uninstalled.'));
  });
  
}
