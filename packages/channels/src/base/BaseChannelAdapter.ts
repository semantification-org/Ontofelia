import { ChannelAdapter, ChannelType, ChannelStatus, ChannelConfig, MessageEnvelope, SendOptions, SendResult, Attachment, ChannelCapabilities, ChatType, HealthResult } from '@ontofelia/core';

export abstract class BaseChannelAdapter implements ChannelAdapter {
  abstract readonly type: ChannelType;
  status: ChannelStatus = 'disconnected';
  protected messageHandler?: (envelope: MessageEnvelope) => Promise<void>;
  protected config!: ChannelConfig;

  async initialize(config: ChannelConfig): Promise<void> {
    this.config = config;
  }

  onMessage(handler: (envelope: MessageEnvelope) => Promise<void>): void {
    this.messageHandler = handler;
  }

  protected chunkText(text: string, maxLength: number): string[] {
    if (text.length <= maxLength) return [text];
    
    const chunks: string[] = [];
    const lines = text.split('\n');
    let currentChunk = '';

    for (const line of lines) {
      if ((currentChunk + line + '\n').length > maxLength) {
        if (currentChunk) chunks.push(currentChunk.trimEnd());
        currentChunk = line + '\n';
        
        // If a single line is longer than maxLength, chunk it hard
        while (currentChunk.length > maxLength) {
          chunks.push(currentChunk.slice(0, maxLength));
          currentChunk = currentChunk.slice(maxLength);
        }
      } else {
        currentChunk += line + '\n';
      }
    }
    
    if (currentChunk) chunks.push(currentChunk.trimEnd());
    return chunks;
  }

  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract healthCheck(): Promise<HealthResult>;
  abstract sendText(target: string, text: string, options?: SendOptions): Promise<SendResult>;
  abstract sendMedia(target: string, attachment: Attachment, caption?: string): Promise<SendResult>;
  abstract getCapabilities(chatType: ChatType): ChannelCapabilities;
}
