import { describe, it, expect } from 'vitest';
import { configSchema } from '../schema.js';

describe('Config Schema', () => {
  it('allows empty config with defaults', () => {
    const parsed = configSchema.parse({});
    expect(parsed.version).toBe(1);
    expect(parsed.gateway.bind).toBe('loopback');
  });

  it('validates missing token (defaults to empty string)', () => {
    const parsed = configSchema.parse({ gateway: { port: 8080 } });
    expect(parsed.gateway.token).toBe('');
    expect(parsed.gateway.port).toBe(8080);
  });

  it('rejects invalid sandbox scope', () => {
    expect(() => {
      configSchema.parse({ agents: { defaults: { sandbox: { scope: 'invalid' } } } });
    }).toThrow(/Invalid option/);
  });

  it('ignores unknown keys by default', () => {
    const parsed = configSchema.parse({ unknown_key: 'value' });
    expect((parsed as Record<string, unknown>).unknown_key).toBeUndefined();
  });

  it('validates telegram config correctly', () => {
    const parsed = configSchema.parse({
      channels: {
        telegram: { enabled: true, token: '123', allowedChats: ['456'] }
      }
    });
    expect(parsed.channels.telegram?.enabled).toBe(true);
    expect(parsed.channels.telegram?.token).toBe('123');
  });

  it('strips unknown channel types', () => {
    const parsed = configSchema.parse({
      channels: {
        unknown_app: { enabled: true }
      }
    });
    expect((parsed.channels as Record<string, unknown>).unknown_app).toBeUndefined();
  });

  it('rejects invalid session scope', () => {
    expect(() => {
      configSchema.parse({ session: { scope: 'invalid' } });
    }).toThrow(/Invalid option/);
  });
});
