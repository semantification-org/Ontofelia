import { ProviderAdapter, ProviderConfig, ChatRequest, ChatResponse, StreamEvent, HealthResult, ModelInfo, ToolCall } from '@ontofelia/core';
import { TokenStore } from './auth/TokenStore.js';
import { OAuthPKCE } from './auth/OAuthPKCE.js';

// Endpoint the Codex backend exposes for the models available to the signed-in
// account. It is a routed endpoint that accepts GET and answers 401 without
// credentials, while unknown paths under the same prefix are rejected earlier
// with a generic HTML 403 — that difference is how it was identified.
const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';

// The discovered list is cached in memory so sending a chat message never
// triggers a listing request. A failed attempt is cached far more briefly so an
// expired token or a short outage recovers on its own.
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;
const MODEL_CACHE_ERROR_TTL_MS = 5 * 60 * 1000;

const DEFAULT_CONTEXT_WINDOW = 128000;

// Last resort, used only when discovery fails and nothing is configured. This is
// deliberately not the place to maintain the model list: set `provider.models`
// in the configuration instead, which needs no code release.
const BUILT_IN_MODELS: ModelInfo[] = [
  { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: DEFAULT_CONTEXT_WINDOW },
  { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: DEFAULT_CONTEXT_WINDOW }
];

export class OpenAICodexProvider implements ProviderAdapter {
  readonly name = 'openai-codex';
  protected config!: ProviderConfig;
  private tokenStore = new TokenStore();
  private oauthPKCE = new OAuthPKCE();
  private modelCache: { models: ModelInfo[]; expiresAt: number } | null = null;

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  // Try to load the saved OAuth token automatically.
  async loadStoredToken(): Promise<string | null> {
    const auth = await this.loadStoredAuth();
    return auth ? auth.accessToken : null;
  }

  // Load the stored access token together with the ChatGPT account id, handling
  // refresh transparently. Returns null when there is no usable token.
  async loadStoredAuth(): Promise<{ accessToken: string; accountId?: string } | null> {
    const tokens = await this.tokenStore.load();
    if (!tokens) return null;

    if (this.tokenStore.isExpired(tokens)) {
      if (tokens.refreshToken) {
        try {
          const refreshed = await this.oauthPKCE.refreshToken(tokens.refreshToken);
          // A refresh response may omit the id_token, in which case the freshly
          // extracted accountId is undefined. Preserve the previously stored one
          // so we don't lose the header after a silent refresh.
          if (!refreshed.accountId && tokens.accountId) {
            refreshed.accountId = tokens.accountId;
          }
          await this.tokenStore.save(refreshed);
          return { accessToken: refreshed.accessToken, accountId: refreshed.accountId };
        } catch {
          return null;
        }
      }
      return null;
    }

    return { accessToken: tokens.accessToken, accountId: tokens.accountId };
  }

  // Build the request headers for the Codex backend. Extracted so it can be
  // unit-tested without a live fetch. When accountId is missing (e.g. a token
  // saved before this feature existed), a warning is emitted and the header is
  // omitted; the call is still attempted.
  buildCodexHeaders(token: string, accountId?: string): Record<string, string> {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    };
    if (accountId) {
      headers['chatgpt-account-id'] = accountId;
    } else {
      console.warn(
        '[openai-codex] No ChatGPT account id found for this token. The Codex ' +
        'backend requires it and will likely return 401. Re-run "ontofelia auth login" ' +
        'to capture it.'
      );
    }
    return headers;
  }

  async healthCheck(): Promise<HealthResult> {
    const token = await this.loadStoredToken();
    if (!token) return { healthy: false, component: this.name, checkedAt: new Date().toISOString(), message: 'No valid OAuth token' };
    return { healthy: true, component: this.name, checkedAt: new Date().toISOString() };
  }

  // Report the models this account can use. The list is read from the provider
  // and cached, so it is no longer maintained in source. Whatever goes wrong,
  // this returns a usable list and never throws — an empty model dropdown is
  // worse than a slightly stale one.
  async listModels(): Promise<ModelInfo[]> {
    const now = Date.now();
    if (this.modelCache && this.modelCache.expiresAt > now) {
      return this.modelCache.models;
    }

    let discovered: ModelInfo[] = [];
    let discoverySucceeded = true;
    try {
      discovered = await this.fetchAvailableModels();
      if (discovered.length === 0) {
        discoverySucceeded = false;
        console.warn('[openai-codex] The provider returned no models; using the configured list instead.');
      }
    } catch (e) {
      discoverySucceeded = false;
      console.warn(
        `[openai-codex] Could not list models from the provider; using the configured list instead: ${(e as Error).message}`
      );
    }

    const models = this.withConfiguredModels(discovered);
    this.modelCache = {
      models,
      expiresAt: now + (discoverySucceeded ? MODEL_CACHE_TTL_MS : MODEL_CACHE_ERROR_TTL_MS)
    };
    return models;
  }

  // Ask the Codex backend which models are available. Throws on any problem;
  // the caller decides what to fall back to.
  private async fetchAvailableModels(): Promise<ModelInfo[]> {
    const stored = await this.loadStoredAuth();
    const token = this.config?.oauthToken ?? stored?.accessToken;
    if (!token) throw new Error('no valid OAuth token');

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config?.timeout || 10000);
    try {
      const res = await fetch(CODEX_MODELS_URL, {
        method: 'GET',
        headers: this.buildCodexHeaders(token, stored?.accountId),
        signal: controller.signal
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return this.parseModelList(await res.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  // The response shape of the Codex model endpoint is not documented, so accept
  // the shapes the OpenAI APIs use in practice: a bare array, `{ data: [...] }`
  // or `{ models: [...] }`, with entries that are either plain ids or objects.
  private parseModelList(payload: unknown): ModelInfo[] {
    const container = (payload ?? {}) as { data?: unknown; models?: unknown };
    const entries: unknown[] =
      Array.isArray(payload) ? payload :
      Array.isArray(container.data) ? container.data :
      Array.isArray(container.models) ? container.models :
      [];

    const models: ModelInfo[] = [];
    for (const entry of entries) {
      if (typeof entry === 'string' && entry) {
        models.push(this.describeModel(entry));
        continue;
      }
      if (!entry || typeof entry !== 'object') continue;

      const record = entry as Record<string, unknown>;
      const id = [record.id, record.slug, record.model].find(v => typeof v === 'string' && v) as string | undefined;
      if (!id) continue;

      const name = [record.name, record.display_name, record.title].find(v => typeof v === 'string' && v) as string | undefined;
      const contextWindow = [record.context_window, record.context_length, record.max_context_window]
        .find(v => typeof v === 'number') as number | undefined;

      models.push({
        id,
        name: name ?? this.describeModel(id).name,
        contextWindow: contextWindow ?? DEFAULT_CONTEXT_WINDOW
      });
    }
    return models;
  }

  // Combine the discovered models with everything the configuration says this
  // instance can run. Configured entries are appended, never dropped: the model
  // the instance is actually running on must always be selectable, which is
  // exactly what a stale hardcoded list got wrong.
  private withConfiguredModels(discovered: ModelInfo[]): ModelInfo[] {
    const result: ModelInfo[] = [];
    const seen = new Set<string>();
    const add = (model: ModelInfo): void => {
      if (!model.id || seen.has(model.id)) return;
      seen.add(model.id);
      result.push(model);
    };

    const base = discovered.length > 0
      ? discovered
      : (this.config?.models ?? []).map(id => this.describeModel(id));
    for (const model of base) add(model);

    // Alias keys are accepted as model names by the runtime and alias values are
    // the real model ids, so both are selectable and both belong in the list.
    const aliases = this.config?.aliases ?? {};
    for (const [alias, target] of Object.entries(aliases)) {
      add(this.describeModel(target));
      add(this.describeModel(alias));
    }

    for (const id of this.config?.fallbackModels ?? []) add(this.describeModel(id));

    const defaultModel = this.config?.defaultModel;
    if (defaultModel) {
      add(this.describeModel(aliases[defaultModel] ?? defaultModel));
      add(this.describeModel(defaultModel));
    }

    return result.length > 0 ? result : BUILT_IN_MODELS.map(m => ({ ...m }));
  }

  // Turn a bare model id into a ModelInfo, reusing a friendly name when the id
  // is one we happen to know.
  private describeModel(id: string): ModelInfo {
    const known = BUILT_IN_MODELS.find(m => m.id === id);
    return known ? { ...known } : { id, name: id, contextWindow: DEFAULT_CONTEXT_WINDOW };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    // Collect stream
    let content = '';
    let toolCalls: ToolCall[] = [];
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let finishReason: ChatResponse['finishReason'] = 'stop';
    let id = 'codex_req';

    for await (const chunk of this.chatStream(request)) {
      if (chunk.type === 'text_delta') {
        content += chunk.content;
      } else if (chunk.type === 'done') {
        content = chunk.response.content;
        toolCalls = chunk.response.toolCalls || [];
        usage = chunk.response.usage || usage;
        finishReason = chunk.response.finishReason;
        id = chunk.response.id || id;
      } else if (chunk.type === 'error') {
        throw new Error(chunk.error);
      }
    }

    return {
      id,
      content,
      toolCalls,
      finishReason,
      usage
    };
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    let token: string | null | undefined = this.config.oauthToken;
    let accountId: string | undefined;
    if (token) {
      // A token supplied via config carries no id_token, so we still try to load
      // the stored auth to recover the account id for the required header.
      const stored = await this.loadStoredAuth();
      accountId = stored?.accountId;
    } else {
      const stored = await this.loadStoredAuth();
      token = stored?.accessToken ?? null;
      accountId = stored?.accountId;
    }
    if (!token) {
      throw new Error('OAuth token is missing. Run "ontofelia onboard" or "ontofelia auth login".');
    }

    // Extract system instructions
    let instructions = '';
    const input: Array<{ role: string; content: ChatRequest['messages'][number]['content'] }> = [];
    for (const msg of request.messages) {
      if (msg.role === 'system') {
        instructions += msg.content + '\n';
      } else if (msg.role === 'user' || msg.role === 'assistant') {
        input.push({ role: msg.role, content: msg.content });
      }
      // For tool responses, we would need to map it if Codex supports it.
      // But for simplicity, we map it as user messages or ignore.
      else if (msg.role === 'tool') {
         input.push({ role: 'user', content: `[Tool Result: ${msg.name}]: ${msg.content}` });
      }
    }

    const body: Record<string, unknown> = {
      model: request.model,
      instructions: instructions.trim(),
      store: false,
      stream: true,
      input: input.length > 0 ? input : [{role: 'user', content: ' '}]
    };

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema || { type: 'object', properties: {} }
      }));
    }

    const controller = new AbortController();
    
    try {
      const res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
        method: 'POST',
        headers: this.buildCodexHeaders(token, accountId),
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Provider API error: ${res.status} - ${errorText}`);
      }

      if (!res.body) throw new Error('No response body');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      let accumulatedContent = '';
      const toolCallsMap = new Map<string, { id: string; name: string; arguments: string }>();
      let usageData: ChatResponse['usage'] | undefined = undefined;
      let streamId = 'stream';
      let finishReason: "stop" | "tool_calls" | "length" | "error" = 'stop';

      // We need a variable to store the name of the function call when it's added.
      let activeItemId: string | null = null;
      let activeItemName: string | null = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;

          try {
            const data = JSON.parse(dataStr);
            if (data.response?.id) streamId = data.response.id;

            if (data.type === 'response.output_text.delta') {
              accumulatedContent += data.delta;
              yield { type: 'text_delta', content: data.delta };
            }

            if (data.type === 'response.output_item.added') {
               const item = data.item;
               if (item && item.type === 'function_call' && item.id) {
                  activeItemId = item.id as string;
                  activeItemName = item.name as string;
                  toolCallsMap.set(activeItemId, { id: activeItemId, name: activeItemName || '', arguments: '' });
               }
            }

            if (data.type === 'response.function_call_arguments.delta') {
              const itemId = data.item_id || activeItemId;
              if (itemId && toolCallsMap.has(itemId)) {
                toolCallsMap.get(itemId)!.arguments += data.delta;
              }
            }

            if (data.type === 'response.completed') {
              const resp = data.response;
              if (resp.usage) {
                usageData = {
                  promptTokens: resp.usage.input_tokens || 0,
                  completionTokens: resp.usage.output_tokens || 0,
                  totalTokens: resp.usage.total_tokens || 0
                };
              }
              // Check if any tool calls were made in the completed object
              if (resp.output && Array.isArray(resp.output)) {
                 for (const out of resp.output) {
                    if (out.type === 'function_call' && out.id) {
                       if (!toolCallsMap.has(out.id)) {
                          toolCallsMap.set(out.id, { id: out.id, name: out.name, arguments: out.arguments || '' });
                       } else if (!toolCallsMap.get(out.id)!.arguments && out.arguments) {
                          toolCallsMap.get(out.id)!.arguments = out.arguments;
                       }
                    }
                 }
              }
              finishReason = (toolCallsMap.size > 0) ? 'tool_calls' : 'stop';
            }
          } catch {
            // Ignore parse errors for partial chunks
          }
        }
      }
      
      const toolCalls = toolCallsMap.size > 0 
        ? Array.from(toolCallsMap.values())
        : undefined;

      yield { 
        type: 'done', 
        response: {
          id: streamId,
          content: accumulatedContent,
          toolCalls: toolCalls || [],
          finishReason,
          usage: usageData || { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
        }
      };
    } catch (e) {
      yield { type: 'error', error: (e as Error).message };
    }
  }
}
