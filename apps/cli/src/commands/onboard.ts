
import { Command } from 'commander';
import { input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

import { saveConfig, getDefaultConfig } from '@ontofelia/config';
import { OAuthPKCE, TokenStore } from '@ontofelia/providers';

export function registerOnboardCommand(program: Command) {
  // ---- ONBOARD COMMAND ----
  program
    .command('onboard')
    .description('Interactive setup for Ontofelia')
    .option('--install-daemon', 'Install systemd/launchd daemon')
    .option('--non-interactive', 'Run without prompts (uses defaults)')
    .action(async (options) => {
      console.log('');
      console.log(chalk.blue.bold('  🦉 Welcome to Ontofelia'));
      console.log(chalk.gray('  The AI agent with semantic memory'));
      console.log('');

      // ── Step 1: Prerequisites ──
      console.log(chalk.cyan.bold('  Step 1/5 — Prerequisites'));

      // Check Node.js
      const nodeVersion = process.version;
      const nodeMajor = parseInt(nodeVersion.slice(1).split('.')[0], 10);
      if (nodeMajor >= 20) {
        console.log(chalk.green(`  ✔ Node.js ${nodeVersion}`));
      } else {
        console.log(chalk.red(`  ✘ Node.js ${nodeVersion} — version 20+ required`));
      }

      // Check Java — only needed for the optional legacy Fuseki backend.
      // The default Oxigraph backend is embedded and requires no Java.
      try {
        const { stdout, stderr } = await execFileAsync('java', ['-version']);
        const javaInfo = (stderr || stdout || '').split('\n')[0];
        console.log(chalk.green(`  ✔ Java: ${javaInfo}`));
      } catch (_e) {
        console.log(chalk.gray('  ○ Java not found — only needed for the optional Fuseki backend'));
        console.log(chalk.gray('    Default Oxigraph backend needs no Java. For Fuseki:'));
        console.log(chalk.gray('    sudo apt install openjdk-17-jre-headless'));
      }
      console.log('');

      const config = getDefaultConfig();
      const isTTY = process.stdout.isTTY;

      if (isTTY && !options.nonInteractive) {
        // ── Step 2: LLM Provider ──
        console.log(chalk.cyan.bold('  Step 2/5 — LLM Provider'));

        const providerChoice = await select({
          message: 'Which LLM provider do you want to use?',
          choices: [
            { name: '🔑 OpenAI (ChatGPT Plus via OAuth — no API key needed)', value: 'openai-oauth' },
            { name: '🤖 OpenAI (API Key)', value: 'openai' },
            { name: '🌐 OpenRouter (recommended — access to 100+ models)', value: 'openrouter' },
            { name: '🏠 Ollama (local, private, no API key needed)', value: 'ollama' },
            { name: '⚙️  Other OpenAI-compatible API', value: 'custom' },
          ]
        });

        const providerName = providerChoice === 'openai-oauth' ? 'openai-codex' : providerChoice;
        config.provider.name = providerName;

        if (providerChoice === 'openai-oauth') {
          console.log();
          console.log(chalk.blue('  Your browser will open for OpenAI login.'));
          console.log(chalk.gray('  Please log in with your ChatGPT account.'));
          console.log();

          const pkce = new OAuthPKCE();
          const tokens = await pkce.login();
          const store = new TokenStore();
          await store.save(tokens);

          console.log(chalk.green(`  ✅ Logged in! Token expires at ${tokens.expiresAt}`));
        } else if (providerName !== 'ollama') {
          // API Key (optional for custom endpoints — local servers often need none)
          const apiKey = await input({
            message: providerName === 'custom'
              ? 'Enter your API key (leave empty if none):'
              : `Enter your ${providerName === 'openrouter' ? 'OpenRouter' : 'OpenAI'} key:`,
            validate: (v) => providerName === 'custom' || v.trim().length > 0 ? true : 'API key is required'
          });
          if (apiKey.trim()) config.provider.apiKey = apiKey.trim();
        }

        // Base URL for local/custom providers
        if (providerName === 'ollama') {
          const baseUrl = await input({
            message: 'Ollama API base URL:',
            default: 'http://localhost:11434/v1',
            validate: (v) => v.trim().startsWith('http') ? true : 'Must be a valid URL'
          });
          config.provider.baseUrl = baseUrl.trim();
        } else if (providerName === 'custom') {
          const baseUrl = await input({
            message: 'Base URL of the API (e.g. http://localhost:1234/v1):',
            validate: (v) => v.trim().startsWith('http') ? true : 'Must be a valid URL'
          });
          config.provider.baseUrl = baseUrl.trim();
        }

        // Model selection
        let defaultModel = 'deepseek/deepseek-v4-flash:free';
        if (providerName === 'openai') defaultModel = 'gpt-4o';
        if (providerName === 'openai-codex') defaultModel = 'gpt-5.5';
        if (providerName === 'ollama') defaultModel = 'llama3.2';
        if (providerName === 'custom') defaultModel = 'default';

        const model = await input({
          message: 'Which model should Ontofelia use?',
          default: defaultModel
        });
        config.provider.defaultModel = model;
        config.agents.defaults.model = `${providerName}/${model}`;

        console.log(chalk.green(`  ✔ Provider: ${providerName} — Model: ${model}`));
        console.log('');

        // ── Step 3: Network & Security ──
        console.log(chalk.cyan.bold('  Step 3/5 — Network & Security'));

        const mode = await select({
          message: 'Gateway network mode:',
          choices: [
            { name: '🔒 Loopback (local only — recommended)', value: 'loopback' },
            { name: '🏠 LAN (accessible from local network)', value: 'lan' },
          ]
        });
        config.gateway.bind = mode as 'loopback' | 'lan' | 'tailnet' | 'custom';

        // Always generate a secure token
        config.gateway.token = crypto.randomBytes(32).toString('hex');

        console.log(chalk.green(`  ✔ Bind: ${mode}`));
        console.log('');

        // ── Step 4: Memory ──
        console.log(chalk.cyan.bold('  Step 4/5 — Semantic Memory'));

        const memoryBackend = await select({
          message: 'Knowledge graph backend:',
          choices: [
            { name: '🦀 Oxigraph + Reasonable (recommended — blazing fast, embedded)', value: 'oxigraph' },
            { name: '🗄️  Apache Jena Fuseki (legacy Java server — full OWL-DL)', value: 'fuseki' },
            { name: '💾 In-memory (for testing, no persistence)', value: 'memory' },
          ]
        });
        config.memory.backend = memoryBackend as 'fuseki' | 'oxigraph' | 'memory';

        console.log(chalk.green(`  ✔ Backend: ${memoryBackend}`));
        console.log('');
      } else {
        // Non-interactive defaults
        config.gateway.token = crypto.randomBytes(32).toString('hex');
        config.provider.name = 'mock';
        config.provider.defaultModel = 'mock';
      }

      // ── Step 5: Create files ──
      console.log(chalk.cyan.bold('  Step 5/5 — Creating files'));

      const baseDir = path.join(os.homedir(), '.ontofelia');
      const dirsToCreate = [
        'workspace',
        'agents',
        'skills',
        'triplestore',
        'ontology/core',
        'logs',
        'backups',
        'media',
        'scheduler'
      ];

      for (const d of dirsToCreate) {
        await fs.mkdir(path.join(baseDir, d), { recursive: true });
      }
      console.log(chalk.green('  ✔ Directories created'));

      // Save config
      const configPath = path.join(baseDir, 'ontofelia.json5');
      await saveConfig(config, configPath);
      console.log(chalk.green(`  ✔ Config saved: ${configPath}`));

      // Create bootstrap workspace files if they don't exist
      const workspaceDir = path.join(baseDir, 'workspace');

      const soulContent = `# Personality

  You are Ontofelia — a knowledge-graph-native personal AI assistant with semantic memory.

  ## Core Character
  - You are self-directed: when a useful action is possible, do it instead of announcing it
  - You are purposeful: keep every response and tool action oriented toward concrete progress
  - You are concise: answer as briefly as possible and as completely as necessary
  - You are kind: friendly, attentive, respectful, and warm without being submissive or chatty
  - You are honest: if you do not know something, say so and check when checking is possible

  ## Operating Rules
  - Act first when the task is clear; report briefly after completion
  - Ask at most one precise question only when a user decision is genuinely required
  - Prefer small, safe, finishable steps over broad performative planning
  - Use the Knowledge Graph as your source of truth for memory and self-understanding
  - Do not use Markdown files as a substitute for your semantic memory

  ## Language
  - The user determines the conversation language
  - Always respond in the language of the user's latest message
  - Translate or adapt templates before replying; do not copy an English template into a non-English conversation
  - Use emojis sparingly and appropriately
  - Be concise, but not cold

  ## Knowledge Management (Semantic Memory)
  - You have permanent memory in the form of a Knowledge Graph (RDF/OWL)
  - Relevant facts about mentioned people, places, and concepts are automatically provided in the Knowledge Graph sections — use that knowledge in your answer
  - New ordinary facts are captured by the semantic ingestion pipeline; use memory tools deliberately for lookups, explanations, explicit writes, and retractions
  - Store ONLY facts, not opinions or temporary statements
  - Use the correct types: Person, Organization, Place, Concept, Event
  - If you need to answer a question that is not covered by the facts you were given, use memory_ask or memory_sparql
  - Refer to your knowledge when relevant: "You told me that..."
  - Do NOT store facts that are already in the Knowledge Graph

  ## Onboarding
  When you talk to someone for the first time and no Knowledge Graph entries exist for this person:
  1. Briefly introduce yourself
  2. Ask for their name
  3. Ask at most one natural follow-up about their work, interests, or preferred communication style
  4. Store durable facts in the Knowledge Graph
  `;

      const identityContent = `# Identity

  **Name:** Ontofelia
  **Role:** Knowledge-graph-native personal AI assistant with semantic memory

  ## What makes me special
  - I store facts as RDF triples in a governed Knowledge Graph
  - I can draw logical conclusions with OWL-DL reasoning
  - I keep memory across sessions with provenance and conflict detection
  - I can act through tools when action is useful and permitted

  ## Behavioral Contract
  I am self-directed, purposeful, concise, and kind.
  I act when I can, ask only when I must, and explain only as much as needed.
  My Knowledge Graph is my source of truth; Markdown is documentation or bootstrap material, not my brain.

  ## First Meeting
  When I meet someone for the first time, I say something like:

  "Hello! 👋 I am Ontofelia — your personal AI assistant with real memory.
  Unlike other bots, I do not forget what you tell me. How can I help?"

  I then learn durable facts naturally and store them in the Knowledge Graph.
  `;
      const userContent = `# User

  Information about the user is stored here once it is known.

  ## Status: Not Introduced Yet
  The user has not introduced themselves yet. On first contact:
  1. Greet and introduce yourself
  2. Ask for name and background
  3. Ask for preferred communication style
  4. Store all information in the Knowledge Graph
  `;

      const filesToCreate: Array<[string, string]> = [
        ['SOUL.md', soulContent],
        ['IDENTITY.md', identityContent],
        ['USER.md', userContent],
      ];

      for (const [filename, content] of filesToCreate) {
        const filePath = path.join(workspaceDir, filename);
        try {
          await fs.access(filePath);
          // File exists, don't overwrite
        } catch {
          await fs.writeFile(filePath, content, 'utf-8');
          console.log(chalk.green(`  ✔ Created ${filename}`));
        }
      }

      // ── Summary ──
      console.log('');
      console.log(chalk.blue.bold('  ═══════════════════════════════════════'));
      console.log(chalk.blue.bold('  🦉 Ontofelia is ready!'));
      console.log(chalk.blue.bold('  ═══════════════════════════════════════'));
      console.log('');
      console.log(chalk.white.bold('  Your Gateway Token:'));
      console.log(chalk.yellow(`  ${config.gateway.token}`));
      console.log('');
      console.log(chalk.gray('  ⚠ Save this token — you need it to connect the Web UI'));
      console.log('');
      console.log(chalk.white('  Start the gateway:'));
      console.log(chalk.cyan('  $ ontofelia gateway'));
      console.log('');
      console.log(chalk.white('  Then open in your browser:'));
      console.log(chalk.cyan(`  http://127.0.0.1:${config.gateway.port}`));
      console.log('');
      console.log(chalk.yellow.bold('  ⚠ First, reload your shell:'));
      console.log(chalk.cyan('  $ source ~/.bashrc'));
      console.log('');

      // Onboarding is done. The OAuth login may have left a callback server /
      // readline handle on the event loop, so exit explicitly instead of
      // hanging after the summary (mirrors `ontofelia auth login`).
      process.exit(0);
    });

}
