 
import { Command } from 'commander';
import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import * as path from 'path';
import * as os from 'os';


import { loadConfig, saveConfig } from '@ontofelia/config';
import { OAuthPKCE, TokenStore } from '@ontofelia/providers';



export function registerModelCommand(program: Command) {
  // ---- MODEL COMMAND ----
  program
    .command('model')
    .description('Configure LLM provider and model')
    .action(async () => {
      try {
        const config = await loadConfig();
        const currentProvider = config.provider?.name || 'not configured';
        const currentModel = config.provider?.defaultModel || 'none';
  
        console.log();
        console.log(chalk.bold('  🧠 LLM Configuration'));
        console.log(chalk.gray(`  Current: ${currentProvider} → ${currentModel}`));
        console.log();
  
        const providerChoice = await select({
          message: 'Which provider do you want to use?',
          choices: [
            { name: '🔑 OpenAI (ChatGPT Plus via OAuth — no API key needed)', value: 'openai-oauth' },
            { name: '🔑 OpenAI (API-Key)', value: 'openai' },
            { name: '🌐 OpenRouter (many models, including free ones)', value: 'openrouter' },
            { name: '🧪 Mock (test mode without a real LLM)', value: 'mock' },
          ],
        });
  
        const baseDir = path.join(os.homedir(), '.ontofelia');
        const configPath = path.join(baseDir, 'ontofelia.json5');
  
        if (providerChoice === 'openai-oauth') {
          console.log();
          console.log(chalk.blue('  Your browser will open for OpenAI login.'));
          console.log(chalk.gray('  Sign in with your ChatGPT account.'));
          console.log();
  
          const pkce = new OAuthPKCE();
          const tokens = await pkce.login();
          const store = new TokenStore();
          await store.save(tokens);
  
          const model = await select({
            message: 'Which model?',
            choices: [
              { name: 'GPT-4o (recommended)', value: 'gpt-4o' },
              { name: 'GPT-4o Mini (faster, cheaper)', value: 'gpt-4o-mini' },
              { name: 'GPT-4.1', value: 'gpt-4.1' },
              { name: 'o3-mini (Reasoning)', value: 'o3-mini' },
            ],
          });
  
          config.provider = { name: 'openai', defaultModel: model, aliases: {} };
          await saveConfig(config, configPath);
  
          console.log();
          console.log(chalk.green(`  ✅ Logged in via OAuth! Token valid until ${tokens.expiresAt}`));
          console.log(chalk.green(`  ✅ Provider: openai → ${model}`));
  
        } else if (providerChoice === 'openai') {
          const apiKey = await input({
            message: 'OpenAI API-Key (sk-...):',
            validate: (v: string) => v.startsWith('sk-') ? true : 'Must start with sk-',
          });
  
          const model = await select({
            message: 'Which model?',
            choices: [
              { name: 'GPT-4o (recommended)', value: 'gpt-4o' },
              { name: 'GPT-4o Mini', value: 'gpt-4o-mini' },
              { name: 'GPT-4.1', value: 'gpt-4.1' },
              { name: 'o3-mini (Reasoning)', value: 'o3-mini' },
            ],
          });
  
          config.provider = { name: 'openai', apiKey, defaultModel: model, aliases: {} };
          await saveConfig(config, configPath);
  
          console.log(chalk.green(`  ✅ Provider: openai → ${model}`));
  
        } else if (providerChoice === 'openrouter') {
          const apiKey = await input({
            message: 'OpenRouter API-Key (sk-or-...):',
            validate: (v: string) => v.length > 10 ? true : 'Key is too short',
          });
  
          const model = await select({
            message: 'Which model?',
            choices: [
              { name: 'DeepSeek Chat V3 (free)', value: 'deepseek/deepseek-chat-v3-0324:free' },
              { name: 'Llama 3.1 70B (free)', value: 'meta-llama/llama-3.1-70b-instruct:free' },
              { name: 'GPT-4o via OpenRouter', value: 'openai/gpt-4o' },
              { name: 'Claude 3.5 Sonnet', value: 'anthropic/claude-3.5-sonnet' },
            ],
          });
  
          config.provider = { name: 'openrouter', apiKey, defaultModel: model, aliases: {} };
          await saveConfig(config, configPath);
  
          console.log(chalk.green(`  ✅ Provider: openrouter → ${model}`));
  
        } else {
          config.provider = { name: 'mock', defaultModel: 'mock', aliases: {} };
          await saveConfig(config, configPath);
          console.log(chalk.yellow('  Mock provider enabled (no real LLM responses)'));
        }
  
        console.log(chalk.gray('  Restart the gateway for this change to take effect:'));
        console.log(chalk.cyan('  $ ontofelia gateway restart'));
        console.log();
        
        process.exit(0);
  
      } catch (err: unknown) {
        console.error(chalk.red(`Configuration failed: ${(err as Error).message}`));
        process.exit(1);
      }
    });
  
}
