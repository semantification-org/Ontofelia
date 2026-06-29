# Skills & Plugins

Ontofelia has two extension mechanisms: **Skills** (prompt + tool bundles) and **Plugins** (ESM modules that extend the gateway).

## Skills

Skills are lightweight extensions that add domain-specific capabilities to the agent. A skill consists of a prompt fragment, optional tool definitions, and configuration.

### Built-in Skills

| Skill | Description |
|-------|-------------|
| `summarize` | Summarize long texts, documents, or conversations |
| `translate` | Translate between languages |
| `explain` | Explain complex topics at different levels |
| `code-review` | Review code and suggest improvements |

### Skill Definition

```json5
// ~/.ontofelia/skills/my-skill.json5
{
  name: "research",
  description: "Deep research on a topic with source citation",
  prompt: `When the user asks you to research a topic, follow these steps:
    1. Search your semantic memory for existing knowledge
    2. Use web_fetch to find current information
    3. Store new facts in memory with source attribution
    4. Provide a structured summary with citations`,
  tools: ["memory_query", "memory_store", "web_fetch"],
  config: {
    maxSources: 5,
    citationStyle: "inline"
  }
}
```

### Using Skills

Skills are activated via chat commands or configuration:

```
User: /skill research "history of semantic web"
Agent: [Activates research skill, queries memory, fetches sources...]
```

Or always-on:

```json5
// In agent config
agents: [{
  skills: ["summarize", "translate", "research"]
}]
```

### Creating a Skill

1. Create a `.json5` file in `~/.ontofelia/skills/`
2. Define `name`, `description`, `prompt`
3. Optionally list required `tools`
4. Restart the gateway

---

## Plugins

Plugins are ESM modules that can extend any part of the Ontofelia system.

### Plugin Capabilities

| Capability | Description |
|------------|-------------|
| **Tools** | Register new tools |
| **Commands** | Add CLI commands |
| **Middleware** | Hook into the request pipeline |
| **Events** | Listen to gateway events |
| **Config** | Add custom configuration sections |

### Plugin Structure

```typescript
// ~/.ontofelia/plugins/my-plugin/index.ts
import type { OntofeliaPlugin, PluginContext } from '@ontofelia/core';

const myPlugin: OntofeliaPlugin = {
  name: 'my-plugin',
  version: '1.0.0',
  description: 'A custom plugin',

  async onLoad(ctx: PluginContext): Promise<void> {
    ctx.logger.info('Plugin loaded!');
    
    // Register a custom tool
    ctx.tools.register({
      name: 'my_tool',
      description: 'Does something useful',
      inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
      execute: async (args) => {
        return { result: `Processed: ${args.input}` };
      }
    });
  },

  async onUnload(ctx: PluginContext): Promise<void> {
    ctx.logger.info('Plugin unloaded');
  }
};

export default myPlugin;
```

### Plugin Context

```typescript
interface PluginContext {
  logger: Logger;
  config: OntofeliaConfig;
  tools: ToolRegistry;
  events: EventBus;
  memory: SemanticMemoryAdapter;
}
```

### Installing Plugins

1. Place plugin directory in `~/.ontofelia/plugins/`
2. Add to config:

```json5
plugins: {
  enabled: ["my-plugin"]
}
```

3. Restart the gateway

### Plugin Lifecycle

```
Gateway Start
    │
    ▼
┌─────────────┐
│ Load Plugin │ → onLoad(ctx)
│ Module      │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Register   │ → Tools, commands, events
│  Extensions │
└──────┬──────┘
       │
       ▼
┌─────────────┐
│   Active    │ → Handles events, tool calls
│             │
└──────┬──────┘
       │
       ▼ (on shutdown)
┌─────────────┐
│   Unload    │ → onUnload(ctx)
│             │
└─────────────┘
```

## Differences

| Aspect | Skills | Plugins |
|--------|--------|---------|
| Complexity | Low (JSON5) | Medium (TypeScript/ESM) |
| Capabilities | Prompt + tools | Full system extension |
| Isolation | Sandboxed | Runs in gateway process |
| Hot reload | Yes | On restart |
| Use case | Domain-specific prompts | Custom integrations |
