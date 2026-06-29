import { ChannelType, ChannelCapabilities, ChatType, SendOptions, SendResult, Attachment, MessageEnvelope, HealthResult } from '@ontofelia/core';
import { BaseChannelAdapter } from '../base/BaseChannelAdapter.js';
import { PairingStore } from '../pairing/PairingStore.js';
import { AllowlistStore } from '../pairing/AllowlistStore.js';
import { Client, GatewayIntentBits, Message } from 'discord.js';

export class DiscordAdapter extends BaseChannelAdapter {
  readonly type = 'discord' as ChannelType;
  private client: Client | undefined;

  constructor(
    private pairingStore: PairingStore,
    private allowlistStore: AllowlistStore
  ) {
    super();
  }

  async connect(): Promise<void> {
     
    const token = (this.config.accounts?.default as { token?: string })?.token;
    if (!token) {
      throw new Error('Discord token is missing in config.');
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on('messageCreate', async (msg: Message) => {
      if (msg.author.bot) return;

      const senderId = msg.author.id;
      const chatId = msg.channel.id;
      const isDM = !msg.guild;
      
      const isAllowed = await this.allowlistStore.isAllowed(this.type, senderId);

      if (isAllowed) {
        if (!isDM) {
          // If group, check mention
          const botId = this.client?.user?.id;
          if (botId && !msg.mentions.has(botId)) {
            return; // Not mentioning bot
          }
        }
        
        // Allowed and relevant: forward to MessageHandler
        if (this.messageHandler) {
          const envelope: MessageEnvelope = {
            id: msg.id,
            channel: this.type,
            accountId: 'default',
            chatType: isDM ? 'dm' : 'group',
            sender: {
              id: senderId,
              channelPrefix: 'discord',
              displayName: msg.author.username,
              isOwner: false
            },
            target: chatId,
            timestamp: new Date(msg.createdTimestamp).toISOString(),
            text: msg.content,
            mentions: [],
            attachments: [],
            raw: msg
          };
          
          await this.messageHandler(envelope);
        }
      } else {
        // Not allowed, check for pairing commands
        const text = msg.content.trim();
        if (text === '/start' || text === '/pair') {
          const req = await this.pairingStore.createRequest(this.type, senderId, msg.author.username);
          await this.sendText(chatId, `Your pairing code is: ${req.code}. Please give it to the admin.`);
        } else {
          // Not paired, not pairing command
          if (isDM) {
            await this.sendText(chatId, "You are not approved yet. Send /pair to request a pairing code.");
          }
        }
      }
    });

    await this.client.login(token);
    this.status = 'connected';
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = undefined;
    }
    this.status = 'disconnected';
  }

  async healthCheck(): Promise<HealthResult> {
    try {
      if (this.client && this.client.isReady()) {
        return { healthy: true, component: 'discord', checkedAt: new Date().toISOString() };
      }
      return { healthy: false, component: 'discord', message: 'Client not ready', checkedAt: new Date().toISOString() };
    } catch (e: unknown) {
      return { healthy: false, component: 'discord', message: (e as Error).message, checkedAt: new Date().toISOString() };
    }
  }

  async sendText(target: string, text: string, options?: SendOptions): Promise<SendResult> {
    if (!this.client) throw new Error('Discord client is not connected');

    const channel = await this.client.channels.fetch(target);
    if (!channel || !('send' in channel)) {
      return { success: false, messageIds: [], error: 'Target channel not found or cannot send messages' };
    }

    const chunks = this.chunkText(text, 2000);
    const messageIds: string[] = [];

    for (const chunk of chunks) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const payload: any = { content: chunk };
        if (options?.replyTo) {
          payload.reply = { messageReference: options.replyTo };
        }
        const msg = await channel.send(payload);
        messageIds.push(msg.id);
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
      supportsThread: true,
      supportsMedia: true,
      maxTextLength: 2000,
      maxMediaBytes: 25 * 1024 * 1024
    };
  }
}
