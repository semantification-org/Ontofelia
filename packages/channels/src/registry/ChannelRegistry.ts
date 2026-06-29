import { ChannelAdapter, ChannelType, HealthResult } from '@ontofelia/core';

export class ChannelRegistry {
  private channels = new Map<ChannelType, ChannelAdapter>();

  register(adapter: ChannelAdapter): void {
    if (this.channels.has(adapter.type)) {
      throw new Error(`Channel already registered: ${adapter.type}`);
    }
    this.channels.set(adapter.type, adapter);
  }

  get(type: ChannelType): ChannelAdapter | undefined {
    return this.channels.get(type);
  }

  list(): ChannelAdapter[] {
    return Array.from(this.channels.values());
  }

  getConnected(): ChannelAdapter[] {
    return this.list().filter(c => c.status === 'connected');
  }

  async connectAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      try {
        await channel.connect();
      } catch (e: unknown) {
        console.error(`Failed to connect channel ${channel.type}:`, e);
      }
    }
  }

  async disconnectAll(): Promise<void> {
    for (const channel of this.channels.values()) {
      try {
        await channel.disconnect();
      } catch (e: unknown) {
        console.error(`Failed to disconnect channel ${channel.type}:`, e);
      }
    }
  }

  async healthCheckAll(): Promise<HealthResult[]> {
    const results: HealthResult[] = [];
    for (const channel of this.channels.values()) {
      try {
        results.push(await channel.healthCheck());
      } catch (e: unknown) {
        results.push({
          healthy: false,
          component: channel.type,
          message: (e as Error).message,
          checkedAt: new Date().toISOString()
        });
      }
    }
    return results;
  }
}
