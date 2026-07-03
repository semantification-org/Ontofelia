import { describe, it, expect, vi, afterEach } from 'vitest';
import { ProviderFactory } from '../ProviderFactory.js';
import { OllamaProvider } from '../OllamaProvider.js';
import { CustomProvider } from '../CustomProvider.js';

describe('ProviderFactory', () => {
  it('should instantiate MockProvider', () => {
    const provider = ProviderFactory.create('mock');
    expect(provider.name).toBe('mock');
  });

  it('should instantiate OllamaProvider for "ollama"', () => {
    const provider = ProviderFactory.create('ollama');
    expect(provider).toBeInstanceOf(OllamaProvider);
    expect(provider.name).toBe('ollama');
  });

  it('should instantiate CustomProvider for "custom"', () => {
    const provider = ProviderFactory.create('custom');
    expect(provider).toBeInstanceOf(CustomProvider);
    expect(provider.name).toBe('custom');
  });

  it('should throw on unknown provider names', () => {
    expect(() => ProviderFactory.create('does-not-exist')).toThrow('Unknown provider: does-not-exist');
  });
});

describe('OllamaProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const completion = {
    id: 'chatcmpl-1',
    choices: [
      { message: { role: 'assistant', content: 'Hello from llama' }, finish_reason: 'stop' }
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
  };

  it('defaults to http://localhost:11434/v1 and sends no Authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(completion), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaProvider();
    await provider.initialize({ name: 'ollama', defaultModel: 'llama3.2', aliases: {} });

    const response = await provider.chat({
      model: 'llama3.2',
      messages: [{ role: 'user', content: 'Hi' }]
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/v1/chat/completions');
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('llama3.2');
    expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }]);

    expect(response.content).toBe('Hello from llama');
    expect(response.finishReason).toBe('stop');
    expect(response.usage.totalTokens).toBe(15);
  });

  it('respects a configured baseUrl and apiKey', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(completion), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaProvider();
    await provider.initialize({
      name: 'ollama',
      baseUrl: 'http://ollama.lan:11434/v1',
      apiKey: 'proxy-key',
      defaultModel: 'llama3.2',
      aliases: {}
    });

    await provider.chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'Hi' }] });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://ollama.lan:11434/v1/chat/completions');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer proxy-key');
  });

  it('throws a provider API error on non-2xx responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('model "nope" not found', { status: 404 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OllamaProvider();
    await provider.initialize({ name: 'ollama', defaultModel: 'llama3.2', aliases: {} });

    await expect(
      provider.chat({ model: 'nope', messages: [{ role: 'user', content: 'Hi' }] })
    ).rejects.toThrow('Provider API error: 404 - model "nope" not found');
  });
});

describe('CustomProvider', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('requires baseUrl in the config', async () => {
    const provider = new CustomProvider();
    await expect(
      provider.initialize({ name: 'custom', defaultModel: 'default', aliases: {} })
    ).rejects.toThrow("Custom provider requires 'baseUrl'");
  });

  it('sends chat completions to the configured baseUrl', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        id: 'chatcmpl-2',
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
      }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new CustomProvider();
    await provider.initialize({
      name: 'custom',
      baseUrl: 'http://localhost:1234/v1',
      defaultModel: 'default',
      aliases: {}
    });

    const response = await provider.chat({ model: 'default', messages: [{ role: 'user', content: 'Hi' }] });

    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:1234/v1/chat/completions');
    expect(response.content).toBe('ok');
  });
});
