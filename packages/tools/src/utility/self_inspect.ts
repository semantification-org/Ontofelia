import { ToolDefinition, ToolPermission, ToolContext, ToolResult } from '@ontofelia/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';

interface SelfInspectInput {
  action: 'config' | 'system' | 'tools' | 'architecture' | 'source';
  /** For action='source', the relative file path within the Ontofelia workspace */
  filePath?: string;
}

export class SelfInspectTool implements ToolDefinition {
  name = 'self_inspect';
  description = 'Inspect your own configuration, system environment, architecture, and source code. Use this tool when asked about your LLM model, provider, system information, or architecture.';
  category = 'utility' as const;
  permissions: ToolPermission[] = ['fs:read'];
  
  inputSchema = {
    type: 'object',
    properties: {
      action: { 
        type: 'string', 
        enum: ['config', 'system', 'tools', 'architecture', 'source'],
        description: 'What should be inspected? config=Ontofelia configuration, system=host system info, tools=registered tools, architecture=architecture overview, source=read source code'
      },
      filePath: {
        type: 'string',
        description: 'For action=source: relative path from the Ontofelia root (e.g. packages/agent-runtime/src/index.ts)'
      }
    },
    required: ['action']
  };

  private configPath: string;
  private ontofeliaRoot: string;

  constructor() {
    this.configPath = path.join(os.homedir(), '.ontofelia', 'ontofelia.json5');
    this.ontofeliaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  }

  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const data = input as SelfInspectInput;
    const startTime = Date.now();

    try {
      let output: string;

      switch (data.action) {
        case 'config': {
          const configContent = fs.readFileSync(this.configPath, 'utf-8');
          // Mask API keys for safety
          const masked = configContent.replace(/(apiKey|token|secret)(['":]\s*['"]?)([^'"}\s]{8})[^'"}\s]*/gi, '$1$2$3***MASKED***');
          output = `📋 Ontofelia configuration (${this.configPath}):\n\n${masked}`;
          break;
        }

        case 'system': {
          const sysInfo = {
            hostname: os.hostname(),
            platform: os.platform(),
            arch: os.arch(),
            release: os.release(),
            uptime: `${(os.uptime() / 3600).toFixed(1)}h`,
            totalMemory: `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`,
            freeMemory: `${(os.freemem() / 1024 / 1024 / 1024).toFixed(1)} GB`,
            cpus: os.cpus().length,
            cpuModel: os.cpus()[0]?.model || 'unknown',
            nodeVersion: process.version,
            user: os.userInfo().username,
            homeDir: os.homedir(),
            cwd: process.cwd(),
            pid: process.pid,
          };
          output = `🖥️ System information:\n\n${Object.entries(sysInfo).map(([k, v]) => `${k}: ${v}`).join('\n')}`;
          break;
        }

        case 'tools': {
          output = `🔧 The list of registered tools is available through the /tools command.`;
          break;
        }

        case 'architecture': {
          output = `🏗️ Ontofelia Architecture:

Ontofelia is an autonomous AI agent ecosystem with semantic memory.

📦 Monorepo Structure (pnpm workspaces + turborepo):
├── apps/
│   ├── gateway/     — Fastify HTTP/WS server, central orchestration
│   ├── web-ui/      — React/Vite Chat-UI
│   ├── cli/         — Commander.js CLI ("ontofelia" command)
│   ├── skills/      — Skill-Bundles
│   └── plugins/     — Plugin-Bundles
├── packages/
│   ├── core/        — Types, interfaces, logger
│   ├── config/      — Load/save/validate JSON5 config
│   ├── providers/   — LLM Provider (OpenAI, OpenRouter, OAuth PKCE)
│   ├── agent-runtime/ — AgentRuntime: Session, Tool-Loop, Memory-Injection
│   ├── semantic-memory/ — KnowledgeEngine, Fuseki/InMemory Triplestore, SPARQL
│   ├── channels/    — Telegram, Discord, WebChat Adapter + Pairing
│   ├── sandbox/     — Docker/Noop sandbox for code execution
│   └── tools/       — Tool definitions (exec, fs, memory, ontology, etc.)

🧠 Memory:
- Apache Jena Fuseki as triplestore (TDB2)
- Knowledge Graph with OWL ontology
- Automatic fact extraction via NER
- Cross-session memory (30 newest facts on each request)

📡 Channels:
- WebChat (WebSocket through Gateway)
- Telegram (Long-Polling, Inline-Keyboards)
- Discord (Bot-API)

🔧 Configuration:
- ~/.ontofelia/ontofelia.json5
- ~/.ontofelia/logs/gateway.log
- ~/.ontofelia/triplestore/ (Fuseki + TDB2 data)
- ~/.ontofelia/pairing.db (SQLite for channel pairing)

⚙️ LLM Routing:
- Provider: OpenAI (OAuth PKCE), OpenRouter, Mock
- Auto-fallback to free OpenRouter models on errors
- Model can be switched via /model command`;
          break;
        }

        case 'source': {
          if (!data.filePath) {
            output = 'Please provide a filePath (e.g. packages/agent-runtime/src/index.ts)';
            break;
          }
          const fullPath = path.resolve(this.ontofeliaRoot, data.filePath);
          // Security: must be within Ontofelia root
          if (!fullPath.startsWith(this.ontofeliaRoot)) {
            output = '❌ Access is only allowed to Ontofelia source code.';
            break;
          }
          if (!fs.existsSync(fullPath)) {
            output = `❌ File not found: ${data.filePath}`;
            break;
          }
          const content = fs.readFileSync(fullPath, 'utf-8');
          // Truncate if too long
          const maxLen = 4000;
          const truncated = content.length > maxLen ? content.slice(0, maxLen) + '\n\n... (truncated, file has ' + content.length + ' characters)' : content;
          output = `📄 ${data.filePath}:\n\n${truncated}`;
          break;
        }

        default:
          output = `Unknown action: ${data.action}`;
      }

      return {
        success: true,
        output,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          input,
          output: { action: data.action },
          success: true,
          permissions: this.permissions,
        },
      };
    } catch (e: unknown) {
      return {
        success: false,
        output: null,
        error: (e as Error).message,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          input,
          output: null,
          success: false,
          error: (e as Error).message,
          permissions: this.permissions,
        },
      };
    }
  }
}
