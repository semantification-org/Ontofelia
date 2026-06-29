import { ChannelType, Attachment, ChannelCapabilities, ChatType, HealthResult, SendOptions, SendResult } from '@ontofelia/core';
import { BaseChannelAdapter } from '../base/BaseChannelAdapter.js';

export class WebChatAdapter extends BaseChannelAdapter {
  readonly type = 'webchat' as ChannelType;

  async connect(): Promise<void> {
    this.status = 'connected';
  }

  async disconnect(): Promise<void> {
    this.status = 'disconnected';
  }

  async healthCheck(): Promise<HealthResult> {
    return {
      healthy: this.status === 'connected',
      component: 'webchat',
      checkedAt: new Date().toISOString()
    };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sendText(target: string, text: string, options?: SendOptions): Promise<SendResult> {
    // In WebChat, the server doesn't actively push plain text directly via a global sendText 
    // unless iterating connected sockets. The current WebChat gateway implementation returns 
    // the text as an HTTP response or WS reply synchronously.
    // For now, this is a no-op as the Gateway handles sending replies back to the WS client.
    return { success: true, messageIds: ['webchat-reply'] };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sendMedia(target: string, attachment: Attachment, caption?: string): Promise<SendResult> {
    return { success: false, error: 'Media not yet supported in webchat adapter', messageIds: [] };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getCapabilities(chatType: ChatType): ChannelCapabilities {
    return {
      supportsEdit: false,
      supportsReaction: false,
      supportsThread: false,
      supportsMedia: false,
      maxTextLength: 100000,
      maxMediaBytes: 0
    };
  }
}
