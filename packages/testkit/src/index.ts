import { ProviderAdapter, ProviderConfig, ChatRequest, ChatResponse, StreamEvent } from '@ontofelia/core';
import * as crypto from 'crypto';

export class MockProvider implements ProviderAdapter {
  readonly name = 'mock';

   
  async initialize(_config: ProviderConfig): Promise<void> {}

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const lastMessage = request.messages[request.messages.length - 1];
    const textContent = typeof lastMessage.content === 'string' 
      ? lastMessage.content 
      : lastMessage.content.filter(p => p.type === 'text').map(p => (p as { text: string }).text).join(' ');
    
    // Support tool loop testing
    if (lastMessage.role === 'user' && textContent.includes('use tool')) {
      return {
        id: crypto.randomUUID(),
        content: '',
        toolCalls: [{
          id: 'mock-call-1',
          name: 'datetime',
          arguments: '{}'
        }],
        finishReason: 'tool_calls',
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 }
      };
    }
    
    // Normal response
    return {
      id: crypto.randomUUID(),
      content: lastMessage.role === 'tool' ? `[Mock] Tool result received.` : `[Mock] I received your message: "${textContent}"`,
      toolCalls: [],
      finishReason: 'stop',
      usage: {
        promptTokens: textContent.length,
        completionTokens: 50,
        totalTokens: textContent.length + 50,
      },
    };
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const response = await this.chat(request);
    yield { type: 'text_delta', content: response.content };
    yield { type: 'done', response };
  }

  async healthCheck() {
    return { healthy: true, component: 'mock-provider', checkedAt: new Date().toISOString() };
  }
}
