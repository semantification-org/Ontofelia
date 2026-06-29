import { ProviderAdapter, ProviderConfig, ChatRequest, ChatResponse, StreamEvent, HealthResult, ModelInfo, ToolCall } from '@ontofelia/core';
import { TokenStore } from './auth/TokenStore.js';
import { OAuthPKCE } from './auth/OAuthPKCE.js';

export class OpenAICodexProvider implements ProviderAdapter {
  readonly name = 'openai-codex';
  protected config!: ProviderConfig;
  private tokenStore = new TokenStore();
  private oauthPKCE = new OAuthPKCE();

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  // Try to load the saved OAuth token automatically.
  async loadStoredToken(): Promise<string | null> {
    const tokens = await this.tokenStore.load();
    if (!tokens) return null;
    
    if (this.tokenStore.isExpired(tokens)) {
      if (tokens.refreshToken) {
        try {
          const refreshed = await this.oauthPKCE.refreshToken(tokens.refreshToken);
          await this.tokenStore.save(refreshed);
          return refreshed.accessToken;
        } catch {
          return null;
        }
      }
      return null;
    }
    
    return tokens.accessToken;
  }

  async healthCheck(): Promise<HealthResult> {
    const token = await this.loadStoredToken();
    if (!token) return { healthy: false, component: this.name, checkedAt: new Date().toISOString(), message: 'No valid OAuth token' };
    return { healthy: true, component: this.name, checkedAt: new Date().toISOString() };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'gpt-5.5', name: 'GPT-5.5', contextWindow: 128000 },
      { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 128000 },
      { id: 'gpt-5.4-mini', name: 'GPT-5.4 Mini', contextWindow: 128000 }
    ];
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
    if (!token) {
      token = await this.loadStoredToken();
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
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
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
