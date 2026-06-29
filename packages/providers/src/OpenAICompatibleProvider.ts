import { ProviderAdapter, ProviderConfig, ChatRequest, ChatResponse, StreamEvent, HealthResult, ModelInfo, ToolDefinition, ChatMessage, ToolCall, ContentPart } from '@ontofelia/core';

export interface OpenAIMessage {
  role: string;
  content: string | ContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

export interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: unknown };
}

export interface OpenAIChatCompletion {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export abstract class OpenAICompatibleProvider implements ProviderAdapter {
  abstract readonly name: string;
  protected config!: ProviderConfig;
  protected baseUrl!: string;

  async initialize(config: ProviderConfig): Promise<void> {
    this.config = config;
  }

  protected abstract getHeaders(): Record<string, string>;

  async healthCheck(): Promise<HealthResult> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.timeout || 10000);
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.getHeaders(),
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (res.ok) {
        return { healthy: true, component: this.name, checkedAt: new Date().toISOString() };
      }
      return { healthy: false, component: this.name, checkedAt: new Date().toISOString(), message: `HTTP ${res.status}` };
    } catch (e: unknown) {
      return { healthy: false, component: this.name, checkedAt: new Date().toISOString(), message: (e as Error).message };
    }
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const body = {
      model: request.model,
      messages: this.convertMessages(request.messages),
      tools: request.tools && request.tools.length > 0 ? this.convertTools(request.tools) : undefined,
      max_tokens: request.maxTokens || this.config.maxTokens || 4096,
      temperature: request.temperature ?? this.config.temperature ?? 0.7,
      stop: request.stop
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout || 30000);
    
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`Provider API error: ${res.status} - ${errorText}`);
      }

      const data = await res.json() as OpenAIChatCompletion;
      return this.parseResponse(data);
    } catch (e: unknown) {
      clearTimeout(timeout);
      throw e;
    }
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const body = {
      model: request.model,
      messages: this.convertMessages(request.messages),
      tools: request.tools && request.tools.length > 0 ? this.convertTools(request.tools) : undefined,
      max_tokens: request.maxTokens || this.config.maxTokens || 4096,
      temperature: request.temperature ?? this.config.temperature ?? 0.7,
      stop: request.stop,
      stream: true
    };

    const controller = new AbortController();
    
    try {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.getHeaders(),
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

      // Accumulate data across chunks
      let accumulatedContent = '';
      let finishReason = 'stop';
       
      const toolCallsMap = new Map<number, { id: string; name: string; arguments: string }>();
      let usageData: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
      let streamId = 'stream';

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
          if (dataStr === '[DONE]') {
            // Will yield done event after the loop
            continue;
          }

          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const data = JSON.parse(dataStr) as Record<string, any>;
            if (data.id) streamId = data.id;
            
            // Capture usage if present (some providers send it on the last chunk)
            if (data.usage) {
              usageData = {
                promptTokens: data.usage.prompt_tokens || 0,
                completionTokens: data.usage.completion_tokens || 0,
                totalTokens: data.usage.total_tokens || 0
              };
            }
            
            const choice = data.choices?.[0];
            if (!choice) continue;

            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }

            if (choice.delta?.content) {
              accumulatedContent += choice.delta.content;
              yield { type: 'text_delta', content: choice.delta.content };
            }
            
            // Accumulate tool calls across chunks
            if (choice.delta?.tool_calls) {
              for (const tc of choice.delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (!toolCallsMap.has(idx)) {
                  toolCallsMap.set(idx, { id: tc.id || `call_${idx}`, name: '', arguments: '' });
                }
                const existing = toolCallsMap.get(idx)!;
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name += tc.function.name;
                if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              }
            }
          } catch {
            // Ignore parse errors for partial chunks
          }
        }
      }
      
      // Build accumulated tool calls array
      const toolCalls = toolCallsMap.size > 0 
        ? Array.from(toolCallsMap.values()).filter(tc => tc.name) 
        : undefined;

      // Yield the final done event with all accumulated data
      yield { 
        type: 'done', 
        response: {
          id: streamId,
          content: accumulatedContent,
          toolCalls: toolCalls || [],
          finishReason: (finishReason === 'tool_calls' ? 'tool_calls' : finishReason === 'length' ? 'length' : finishReason === 'error' ? 'error' : 'stop') as 'stop' | 'tool_calls' | 'length' | 'error',
          usage: usageData || { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
        }
      };
    } catch (e: unknown) {
      yield { type: 'error', error: (e as Error).message };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeout || 10000);
    
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: this.getHeaders(),
        signal: controller.signal
      });
      clearTimeout(timeout);
      
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
       
      const data = await res.json() as { data?: { id: string }[] };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (data.data || []).map((m: any) => ({
        id: m.id,
        name: m.name || m.id,
        contextWindow: m.context_length
      }));
    } catch {
      return [];
    }
  }

  protected convertMessages(messages: ChatMessage[]): OpenAIMessage[] {
    return messages.map(msg => {
      const converted: OpenAIMessage = {
        role: msg.role,
        content: msg.content
      };
      
      if (msg.toolCallId) converted.tool_call_id = msg.toolCallId;
      if (msg.name) converted.name = msg.name;
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        converted.tool_calls = msg.toolCalls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: tc.arguments
          }
        }));
      }
      
      return converted;
    });
  }

  protected convertTools(tools: ToolDefinition[]): OpenAITool[] {
    return tools.map(tool => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema || { type: 'object', properties: {} }
      }
    }));
  }

  protected parseResponse(data: OpenAIChatCompletion): ChatResponse {
    const choice = data.choices[0];
    const toolCalls: ToolCall[] = (choice.message.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments
    }));

    return {
      id: data.id,
      content: choice.message.content || '',
      toolCalls,
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' :
                    choice.finish_reason === 'length' ? 'length' : 'stop',
      usage: {
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
        totalTokens: data.usage?.total_tokens || 0
      }
    };
  }
}
