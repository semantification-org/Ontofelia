import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICodexProvider } from '../OpenAICodexProvider.js';
import type { ProviderConfig } from '@ontofelia/core';

const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models';

function baseConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    name: 'openai-codex',
    defaultModel: 'gpt-5.5',
    aliases: {},
    ...overrides
  };
}

// Build a provider whose stored auth is stubbed, so no test ever depends on an
// auth.json being present (or absent) on the machine running the suite.
async function makeProvider(config: ProviderConfig = baseConfig()): Promise<OpenAICodexProvider> {
  const provider = new OpenAICodexProvider();
  vi.spyOn(provider, 'loadStoredAuth').mockResolvedValue({ accessToken: 'test-token', accountId: 'acct_test' });
  await provider.initialize(config);
  return provider;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('OpenAICodexProvider.listModels', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('discovers the models from the provider instead of a hardcoded list', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      data: [
        { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', context_window: 256000 },
        { id: 'gpt-5.6-sol' }
      ]
    }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = await makeProvider();
    const models = await provider.listModels();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(MODELS_URL);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
    expect((init.headers as Record<string, string>)['chatgpt-account-id']).toBe('acct_test');

    expect(models.map(m => m.id)).toContain('gpt-5.6-terra');
    expect(models.map(m => m.id)).toContain('gpt-5.6-sol');
    expect(models.find(m => m.id === 'gpt-5.6-terra')?.contextWindow).toBe(256000);
    // Unknown context windows get a sane default rather than being dropped.
    expect(models.find(m => m.id === 'gpt-5.6-sol')?.contextWindow).toBe(128000);
  });

  it('accepts a bare array and plain string entries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(['gpt-5.6-terra', { slug: 'gpt-5.6-luna' }]));
    vi.stubGlobal('fetch', fetchMock);

    const provider = await makeProvider();
    const models = await provider.listModels();

    expect(models.map(m => m.id)).toEqual(expect.arrayContaining(['gpt-5.6-terra', 'gpt-5.6-luna']));
  });

  it('serves a cached list instead of fetching again', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-5.6-terra' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = await makeProvider();
    const first = await provider.listModels();
    const second = await provider.listModels();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('falls back to a usable list on a non-2xx response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = await makeProvider(baseConfig({
      defaultModel: 'new-model',
      aliases: { 'new-model': 'gpt-5.6-terra' },
      fallbackModels: ['gpt-5.6-luna', 'gpt-5.5']
    }));
    const models = await provider.listModels();

    expect(models.length).toBeGreaterThan(0);
    expect(models.map(m => m.id)).toEqual(expect.arrayContaining([
      'gpt-5.6-terra', 'new-model', 'gpt-5.6-luna', 'gpt-5.5'
    ]));
  });

  it('falls back to a usable list on a network error and does not throw', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('socket hang up'));
    vi.stubGlobal('fetch', fetchMock);

    const provider = await makeProvider(baseConfig({ models: ['gpt-5.6-terra', 'gpt-5.6-sol'] }));
    const models = await provider.listModels();

    expect(models.map(m => m.id)).toEqual(expect.arrayContaining(['gpt-5.6-terra', 'gpt-5.6-sol']));
  });

  it('never returns an empty list, even without a token or configured models', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICodexProvider();
    vi.spyOn(provider, 'loadStoredAuth').mockResolvedValue(null);
    await provider.initialize(baseConfig({ defaultModel: '' }));

    const models = await provider.listModels();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(models.length).toBeGreaterThan(0);
  });

  it('always includes the model the instance is configured to run on', async () => {
    // Discovery succeeds but does not mention the running model — the previous
    // bug. The configured model must still be offered.
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: [{ id: 'gpt-5.5' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = await makeProvider(baseConfig({
      defaultModel: 'new-model',
      aliases: { 'new-model': 'gpt-5.6-terra' },
      fallbackModels: ['gpt-5.6-luna']
    }));
    const ids = (await provider.listModels()).map(m => m.id);

    expect(ids).toContain('gpt-5.5');
    expect(ids).toContain('gpt-5.6-terra');
    expect(ids).toContain('new-model');
    expect(ids).toContain('gpt-5.6-luna');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('aborts a hanging request via the configured timeout', async () => {
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted')));
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = await makeProvider(baseConfig({ timeout: 5 }));
    const models = await provider.listModels();

    expect(models.length).toBeGreaterThan(0);
  });
});
