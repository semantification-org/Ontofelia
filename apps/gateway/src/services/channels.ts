import * as path from 'path';
import * as os from 'os';
import type { OntofeliaConfig } from '@ontofelia/config';
import type { AgentRuntime } from '@ontofelia/agent-runtime';
import {
  ChannelRegistry, PairingStore, AllowlistStore,
  WebChatAdapter, TelegramAdapter, DiscordAdapter
} from '@ontofelia/channels';
import { setupTelegramChannel } from '../channels/telegram.js';
import { PRIMARY_AGENT_ID } from '@ontofelia/core';

export async function initChannels(
  config: OntofeliaConfig,
  agents: Map<string, AgentRuntime>,
) {
  const pairingDbPath = path.join(os.homedir(), '.ontofelia', 'pairing.db');
  const pairingStore = new PairingStore(pairingDbPath);
  const allowlistStore = new AllowlistStore(pairingDbPath);
  const channelRegistry = new ChannelRegistry();

  // WebChat
  const webChatAdapter = new WebChatAdapter();
  await webChatAdapter.initialize({
    enabled: true, accounts: {}, dmPolicy: 'open', groupPolicy: 'open',
    allowFrom: [], allowGroups: [], mentionGating: false, mentionPatterns: [],
    mediaMaxMb: 0, textChunkLimit: 100000, lineChunkLimit: 1000, historyLimit: 100,
    configWrites: false, debounceMs: 0
  });
  channelRegistry.register(webChatAdapter);

  // Telegram
  const telegramConfig = config.channels.telegram;
  if (telegramConfig?.enabled) {
    const telegramAdapter = new TelegramAdapter(pairingStore, allowlistStore);
    await telegramAdapter.initialize(telegramConfig as unknown as Parameters<typeof telegramAdapter.initialize>[0]);
    await setupTelegramChannel(config, telegramAdapter, allowlistStore, agents);
    channelRegistry.register(telegramAdapter);
  }

  // Discord
  const discordConfig = config.channels.discord;
  if (discordConfig?.enabled) {
    const discordAdapter = new DiscordAdapter(pairingStore, allowlistStore);
    await discordAdapter.initialize(discordConfig as unknown as Parameters<typeof discordAdapter.initialize>[0]);
    discordAdapter.onMessage(async (envelope) => {
      const agent = agents.get(envelope.routingHints?.agentId || PRIMARY_AGENT_ID);
      if (agent) {
        const response = await agent.handleMessage(envelope);
        const replyTarget = envelope.chatType === 'dm' ? envelope.sender.id : (envelope.target || envelope.sender.id);
        await discordAdapter.sendText(replyTarget, response.text, { replyTo: envelope.id });
      }
    });
    channelRegistry.register(discordAdapter);
  }

  await channelRegistry.connectAll();

  return { channelRegistry, pairingStore, allowlistStore };
}
