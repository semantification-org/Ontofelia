import { ChannelType, ChannelCapabilities, ChatType, SendOptions, SendResult, Attachment, MessageEnvelope, HealthResult } from '@ontofelia/core';
import { BaseChannelAdapter } from '../base/BaseChannelAdapter.js';
import { PairingStore } from '../pairing/PairingStore.js';
import { AllowlistStore } from '../pairing/AllowlistStore.js';
import TelegramBot from 'node-telegram-bot-api';

export class TelegramAdapter extends BaseChannelAdapter {
  readonly type = 'telegram' as ChannelType;
  private bot: TelegramBot | undefined;

  constructor(
    private pairingStore: PairingStore,
    private allowlistStore: AllowlistStore
  ) {
    super();
  }

  async connect(): Promise<void> {
     
    const token = (this.config as { token?: string }).token || (this.config.accounts?.default as { token?: string })?.token;
    if (!token) {
      throw new Error('Telegram token is missing in config.');
    }

     
    this.bot = new TelegramBot(token, { polling: true });
    if (this.callbackQueryHandler) {
      this.bot.on('callback_query', this.callbackQueryHandler);
    }

    this.bot?.on('message', async (msg) => {
      console.log('Incoming Telegram msg:', JSON.stringify(msg, null, 2));
      if (!msg.from) return;
      
      // Extract text: prefer msg.text, fall back to msg.caption for photos/documents
      const textContent = msg.text || msg.caption || '';
      
      // If there's no text AND no photo/document, skip (e.g. service messages)
      if (!textContent && !msg.photo && !msg.document && !msg.voice && !msg.video) return;

      const senderId = msg.from.id.toString();
      const chatId = msg.chat.id.toString();
      const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
      
      const isAllowed = await this.allowlistStore.isAllowed(this.type, senderId);

      if (isAllowed) {
        if (isGroup && textContent) {
          // If group, check mention
          const botInfo = await this.bot?.getMe();
          const botUsername = botInfo?.username;
          if (botUsername && !textContent.includes(`@${botUsername}`)) {
            return; // Not mentioning bot
          }
        }
        
        // Build attachments from photos (download and encode as base64)
        const attachments: MessageEnvelope['attachments'] = [];
        if (msg.photo && msg.photo.length > 0 && this.bot) {
          // Telegram sends multiple sizes; pick the largest
          const largest = msg.photo[msg.photo.length - 1];
          try {
            const fileUrl = await this.bot.getFileLink(largest.file_id);
            const response = await fetch(fileUrl);
            const buffer = Buffer.from(await response.arrayBuffer());
            const base64 = buffer.toString('base64');
            attachments.push({
              id: largest.file_id,
              type: 'image',
              url: `data:image/jpeg;base64,${base64}`,
              mimeType: 'image/jpeg',
              sizeBytes: largest.file_size || buffer.length,
            });
          } catch {
            // If download fails, still pass metadata
            attachments.push({
              id: largest.file_id,
              type: 'image',
              url: `telegram:file:${largest.file_id}`,
              mimeType: 'image/jpeg',
              sizeBytes: largest.file_size || 0,
            });
          }
        }
        
        // Build attachments from documents
        if (msg.document && this.bot) {
          try {
            const fileUrl = await this.bot.getFileLink(msg.document.file_id);
            attachments.push({
              id: msg.document.file_id,
              type: 'document',
              url: fileUrl,
              mimeType: msg.document.mime_type || 'application/octet-stream',
              filename: msg.document.file_name,
              sizeBytes: msg.document.file_size || 0,
            });
          } catch {
            attachments.push({
              id: msg.document.file_id,
              type: 'document',
              url: `telegram:file:${msg.document.file_id}`,
              mimeType: msg.document.mime_type || 'application/octet-stream',
              filename: msg.document.file_name,
              sizeBytes: msg.document.file_size || 0,
            });
          }
        }

        // Determine the text to send to the agent
        let resolvedText = textContent;
        if (!resolvedText && attachments.length > 0) {
          const hasDoc = attachments.some(a => a.type === 'document');
          if (hasDoc) {
            resolvedText = '[Document sent without text]';
          } else {
            resolvedText = '[Image sent without text]';
          }
        }
        
        // Allowed and relevant: forward to MessageHandler
        if (this.messageHandler) {
          const envelope: MessageEnvelope = {
            id: msg.message_id.toString(),
            channel: this.type,
            accountId: 'default',
            chatType: isGroup ? 'group' : 'dm',
            sender: {
              id: 'owner',
              channelPrefix: 'telegram',
              displayName: msg.from.username || msg.from.first_name,
              isOwner: true
            },
            target: chatId,
            timestamp: new Date(msg.date * 1000).toISOString(),
            text: resolvedText,
            mentions: [],
            attachments,
            raw: msg
          };
          
          await this.messageHandler(envelope);
        }
      } else {
        // Not allowed, check for pairing commands
        if (msg.text === '/start' || msg.text === '/pair') {
          const req = await this.pairingStore.createRequest(this.type, senderId, msg.from.username || msg.from.first_name);
          await this.sendText(chatId, `Your pairing code is: ${req.code}. Please give it to the admin.`);
        } else {
          // Not paired, not pairing command
          if (!isGroup) {
            await this.sendText(chatId, "You are not approved yet. Send /pair to request a pairing code.");
          }
        }
      }
    });

    // Register slash commands so Telegram shows them in the "/" menu
    try {
      await this.bot?.setMyCommands([
        { command: 'new', description: 'Start a new session' },
        { command: 'reset', description: 'Reset the session' },
        { command: 'status', description: 'Show system status' },
        { command: 'help', description: 'Show available commands' },
        { command: 'tools', description: 'List available tools' },
        { command: 'model', description: 'Show the current AI model' },
        { command: 'skills', description: 'Show available skills' },
        { command: 'plugins', description: 'Show installed plugins' },
        { command: 'stop', description: 'Stop the running generation' },
      ]);
    } catch { /* non-critical */ }

    this.status = 'connected';
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling();
      this.bot = undefined;
    }
    this.status = 'disconnected';
  }

  async healthCheck(): Promise<HealthResult> {
    try {
      if (this.bot) {
        await this.bot.getMe();
        return { healthy: true, component: 'telegram', checkedAt: new Date().toISOString() };
      }
      return { healthy: false, component: 'telegram', message: 'Bot not initialized', checkedAt: new Date().toISOString() };
    } catch (e: unknown) {
      return { healthy: false, component: 'telegram', message: (e as Error).message, checkedAt: new Date().toISOString() };
    }
  }

  async sendText(target: string, text: string, options?: SendOptions): Promise<SendResult> {
    if (!this.bot) throw new Error('Telegram bot is not connected');

    const chunks = this.chunkText(text, 4096);
    const messageIds: string[] = [];

    for (const chunk of chunks) {
      try {
        const msg = await this.bot.sendMessage(target, chunk, {
          parse_mode: options?.parseMode === 'markdown' ? 'Markdown' : undefined,
          reply_to_message_id: options?.replyTo ? parseInt(options.replyTo, 10) : undefined
        });
        messageIds.push(msg.message_id.toString());
      } catch (e: unknown) {
        return { success: false, messageIds, error: (e as Error).message };
      }
    }

    return { success: true, messageIds };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sendMedia(target: string, attachment: Attachment, caption?: string): Promise<SendResult> {
    return { success: false, error: 'Media not yet implemented', messageIds: [] };
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getCapabilities(chatType: ChatType): ChannelCapabilities {
    return {
      supportsEdit: true,
      supportsReaction: true,
      supportsThread: false,
      supportsMedia: true,
      maxTextLength: 4096,
      maxMediaBytes: 50 * 1024 * 1024
    };
  }

  /** Expose the raw TelegramBot instance for advanced features like inline keyboards */
  private callbackQueryHandler?: (query: TelegramBot.CallbackQuery) => void;

  /**
   * Register a callback_query handler. The Telegram bot is created lazily in
   * connect(), so we store the handler and attach it either now (if the bot
   * already exists) or when connect() runs. This fixes a setup-ordering bug
   * where callbacks were never handled because getBot() was undefined at setup.
   */
  onCallbackQuery(handler: (query: TelegramBot.CallbackQuery) => void): void {
    this.callbackQueryHandler = handler;
    if (this.bot) {
      this.bot.on('callback_query', handler);
    }
  }

  getBot(): TelegramBot | undefined {
    return this.bot;
  }
}
