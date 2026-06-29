 
import { Command } from 'commander';
import chalk from 'chalk';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';


import { loadConfig, saveConfig } from '@ontofelia/config';
import { OAuthPKCE, TokenStore } from '@ontofelia/providers';



export function registerAuthCommand(program: Command) {
  // ---- AUTH COMMANDS ----
  const authCmd = program.command('auth').description('Authentication commands');
  
  authCmd
    .command('login')
    .description('Login with OpenAI via OAuth')
    .action(async () => {
      try {
        console.log(chalk.blue('Opening browser for OpenAI login...'));
        const pkce = new OAuthPKCE();
        const tokens = await pkce.login();
        const store = new TokenStore();
        await store.save(tokens);
  
        const baseDir = path.join(os.homedir(), '.ontofelia');
        const configPath = path.join(baseDir, 'ontofelia.json5');
        const content = await fs.readFile(configPath, 'utf-8');
        const JSON5 = (await import('json5')).default;
        const parsed = JSON5.parse(content);
        
        parsed.provider = parsed.provider || {};
        parsed.provider.name = 'openai-codex';
        if (!parsed.provider.defaultModel) {
          parsed.provider.defaultModel = 'gpt-5.5';
        }
        await saveConfig(parsed, configPath);
  
        console.log(chalk.green(`✅ Logged in! Token expires at ${tokens.expiresAt}`));
        process.exit(0);
      } catch (err: unknown) {
        console.error(chalk.red(`Login failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
  
  authCmd
    .command('status')
    .description('Show current authentication status')
    .action(async () => {
      try {
        const store = new TokenStore();
        const tokens = await store.load();
        if (!tokens) {
          console.log(chalk.yellow('No OAuth token found.'));
        } else {
          const expired = store.isExpired(tokens);
          if (expired) {
            console.log(chalk.red(`Token is expired (since ${tokens.expiresAt}).`));
          } else {
            console.log(chalk.green(`✔ Token is valid (expires ${tokens.expiresAt}).`));
          }
        }
        
        const config = await loadConfig();
        console.log(`Active Provider: ${chalk.cyan(config.provider?.name || 'mock')}`);
      } catch (err: unknown) {
        console.error(chalk.red(`Status failed: ${(err as Error).message}`));
      }
    });
  
  authCmd
    .command('logout')
    .description('Clear saved OAuth token')
    .action(async () => {
      try {
        const store = new TokenStore();
        await store.clear();
        console.log(chalk.green('✔ Logged out. Token cleared.'));
      } catch (err: unknown) {
        console.error(chalk.red(`Logout failed: ${(err as Error).message}`));
      }
    });
  
  authCmd
    .command('token')
    .description('Show the gateway access token')
    .action(async () => {
      try {
        const config = await loadConfig();
        const token = config.gateway?.token;
        if (!token) {
          console.log(chalk.yellow('No gateway token configured.'));
          console.log(chalk.gray('Run: ontofelia onboard'));
        } else {
          console.log('');
          console.log(chalk.white('  Gateway Token:'));
          console.log(chalk.yellow(`  ${token}`));
          console.log('');
          console.log(chalk.gray('  Use this to log into the Web UI.'));
        }
      } catch (err: unknown) {
        console.error(chalk.red(`Failed: ${(err as Error).message}`));
      }
    });
  
}