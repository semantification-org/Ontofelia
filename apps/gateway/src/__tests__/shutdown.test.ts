import { describe, it, expect, vi } from 'vitest';
import { startGateway } from '../index.js';
import { getDefaultConfig } from '@ontofelia/config';
import { InMemoryAdapter } from '@ontofelia/semantic-memory';
import { ChannelRegistry } from '@ontofelia/channels';

// startGateway allows one instance per process, so this file starts exactly one.
describe('Gateway shutdown', () => {
  it('stops the triplestore on close, and a failing stop does not skip the channel disconnect', async () => {
    const config = getDefaultConfig();
    config.gateway.token = 'test-secret';
    config.gateway.port = 0;
    config.memory.backend = 'memory';

    const stop = vi.spyOn(InMemoryAdapter.prototype, 'stop').mockRejectedValue(new Error('disk gone'));
    const disconnect = vi.spyOn(ChannelRegistry.prototype, 'disconnectAll');

    const app = await startGateway(config);
    expect(stop).not.toHaveBeenCalled();
    await expect(app.close()).resolves.toBeUndefined();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});
