# LLM Providers

Ontofelia supports multiple LLM providers through a unified adapter interface. You can switch providers without changing any application code.

## Supported Providers

| Provider | Auth Method | Free Models | Status |
|----------|-----------|-------------|--------|
| [OpenRouter](https://openrouter.ai) | API Key | ✅ Yes | **Recommended** |
| [OpenAI](https://platform.openai.com) | API Key | ❌ No | Stable |
| OpenAI (ChatGPT Plus/Pro) | OAuth PKCE | ✅ Uses subscription | Stable |
| Any OpenAI-compatible API | API Key | Varies | Via `baseUrl` override |

## OpenRouter (Recommended)

OpenRouter provides access to 200+ models from multiple providers through a single API. It's the easiest way to get started because several models are available for free.

### Setup

1. Create an account at [openrouter.ai](https://openrouter.ai)
2. Generate an API key at [openrouter.ai/keys](https://openrouter.ai/keys)
3. Configure Ontofelia:

```json5
// ~/.ontofelia/ontofelia.json5
provider: {
  name: "openrouter",
  apiKey: "sk-or-v1-YOUR-KEY-HERE",
  defaultModel: "deepseek/deepseek-v4-flash:free"
}
```

### Free Models

These models are available without charges on OpenRouter:

| Model | Context | Best For |
|-------|---------|----------|
| `deepseek/deepseek-v4-flash:free` | 128K | General use, fast |
| `google/gemma-4-26b-a4b-it:free` | 128K | Reasoning |
| `meta-llama/llama-4-maverick:free` | 128K | Creative tasks |

### Model Aliases

Define shortcuts for frequently used models:

```json5
provider: {
  name: "openrouter",
  apiKey: "sk-or-v1-...",
  defaultModel: "deepseek/deepseek-v4-flash:free",
  aliases: {
    fast: "deepseek/deepseek-v4-flash:free",
    smart: "anthropic/claude-sonnet-4",
    code: "openai/gpt-4o"
  }
}
```

## OpenAI (API Key)

Use OpenAI's API directly with a platform API key.

### Setup

1. Create an API key at [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
2. Add billing at [platform.openai.com/settings/billing](https://platform.openai.com/settings/billing)
3. Configure:

```json5
provider: {
  name: "openai",
  apiKey: "sk-YOUR-API-KEY",
  defaultModel: "gpt-4o-mini"
}
```

### Available Models

| Model | Context | Price (approx.) |
|-------|---------|----------------|
| `gpt-4o` | 128K | $2.50/1M input |
| `gpt-4o-mini` | 128K | $0.15/1M input |
| `gpt-4.1` | 1M | $2.00/1M input |
| `o4-mini` | 200K | $1.10/1M input |

## OpenAI OAuth (ChatGPT Plus/Pro)

Use your existing ChatGPT subscription — no API key needed. Ontofelia authenticates via OAuth PKCE, the same mechanism used by the Codex CLI.

### Setup

```bash
# Opens your browser for OpenAI login
ontofelia auth login
```

This will:
1. Open your browser to OpenAI's login page
2. You sign in with your ChatGPT account
3. The OAuth token is stored securely in `~/.ontofelia/auth.json`
4. Provider is automatically set to `openai`

### Managing Auth

```bash
# Check authentication status
ontofelia auth status

# Logout (removes stored token)
ontofelia auth logout
```

### How It Works

```
User                    Ontofelia CLI              OpenAI Auth
  │                         │                         │
  │  ontofelia auth login   │                         │
  │─────────────────────────▶                         │
  │                         │  Generate PKCE verifier │
  │                         │  Start local HTTP server│
  │                         │  Open browser ──────────▶
  │                         │                         │
  │  Login in browser ──────────────────────────────▶│
  │                         │                         │
  │                         │◀── Callback with code ──│
  │                         │                         │
  │                         │── Exchange code ────────▶
  │                         │◀── Access + Refresh ────│
  │                         │                         │
  │  ✅ Logged in!          │  Store in auth.json     │
  │◀────────────────────────│                         │
```

## Custom / Self-Hosted Providers

Any API that follows the OpenAI chat completions format works with Ontofelia:

```json5
provider: {
  name: "openai",
  apiKey: "your-key",
  baseUrl: "http://localhost:11434/v1",  // e.g., Ollama
  defaultModel: "llama3.2"
}
```

### Compatible Services

- **Ollama** — `http://localhost:11434/v1`
- **LM Studio** — `http://localhost:1234/v1`
- **vLLM** — `http://localhost:8000/v1`
- **text-generation-webui** — `http://localhost:5000/v1`

## Auto-Fallback System

Ontofelia includes a two-layer automatic fallback system to handle unreliable free LLM models:

### How It Works

When the primary model returns an **empty response** (common with OpenRouter free tier), Ontofelia automatically retries with configured fallback models while preserving the full conversation context.

```
Primary Model → empty? → Fallback A → empty? → Fallback B → empty? → Error Message
```

### Configuration

```json5
provider: {
  name: "openrouter",
  apiKey: "sk-or-v1-...",
  defaultModel: "google/gemma-4-26b-a4b-it:free",
  autoFallback: true,
  fallbackModels: [
    "deepseek/deepseek-chat-v3-0324:free",
    "meta-llama/llama-3.3-70b-instruct:free"
  ]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `autoFallback` | boolean | `true` | Enable/disable automatic fallback |
| `fallbackModels` | string[] | `[]` | Ordered list of fallback model IDs |

If `fallbackModels` is empty, a built-in default list is used (DeepSeek, Gemma, Llama).

### Settings UI

The Web UI Settings panel provides:
- **Auto-Fallback toggle** — enable/disable the system
- **Fallback A dropdown** — first fallback model (alphabetically sorted)
- **Fallback B dropdown** — second fallback model

Changes are saved immediately and persisted to `ontofelia.json5`.

### Error Reporting

When all models fail, the error message lists all tried models:
```
⚠️ All models failed to respond (gemma-4-26b-a4b-it, gemma-4-31b-it, llama-3.3-70b-instruct).
```

The model label in the UI shows `primary (+ 2 Fallbacks)` to indicate how many alternatives were tried.

## CLI Commands

```bash
# Show current provider status
ontofelia provider status

# List available models
ontofelia provider models

# Test the connection
ontofelia provider test

# Send a specific test message
ontofelia provider test "Explain quantum entanglement in one sentence"
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/provider` | GET | Provider name, model, health, fallback config |
| `/api/models` | GET | List available models (alphabetically sorted) |
| `/api/provider/test` | POST | Send test message |
| `/api/config/model` | PUT | Change active model (persisted) |
| `/api/config/fallback` | PUT | Enable/disable auto-fallback (persisted) |
| `/api/config/fallback-models` | PUT | Set fallback model list (persisted) |

## Provider Architecture

```typescript
// All providers implement this interface
interface ProviderAdapter {
  readonly name: string;
  initialize(config: ProviderConfig): Promise<void>;
  healthCheck(): Promise<HealthResult>;
  chat(request: ChatRequest): Promise<ChatResponse>;
  chatStream(request: ChatRequest): AsyncIterable<StreamEvent>;
  listModels?(): Promise<ModelInfo[]>;
}
```

The `ProviderFactory` creates the right provider based on the config:

```typescript
const provider = ProviderFactory.create(config.provider.name);
await provider.initialize(config.provider);
```

## Switching Providers

You can switch providers at any time by editing the config and restarting the gateway. All conversation history is preserved — only the LLM backend changes.

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `401 Unauthorized` | Invalid API key or expired OAuth token | Check key / run `auth login` |
| `429 Rate Limited` | Too many requests | Wait and retry, or switch to a paid model |
| `Empty response` | Free model overloaded | Auto-fallback handles this automatically |
| `timeout` | Provider didn't respond in time | Increase `timeout` in config |
| `model not found` | Invalid model ID | Check `ontofelia provider models` |

## Token Refresh

OAuth tokens expire after ~1 hour. Ontofelia automatically refreshes them using the stored refresh token. If the refresh fails, you'll need to run `ontofelia auth login` again.
