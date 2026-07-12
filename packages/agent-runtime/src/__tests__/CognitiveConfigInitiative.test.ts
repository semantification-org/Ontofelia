import { describe, it, expect, beforeEach } from 'vitest';
import { OxigraphAdapter } from '@ontofelia/semantic-memory';
import type { TriplestoreAdapter } from '@ontofelia/core';
import { CognitiveConfig } from '../cognitive/CognitiveConfig.js';

const AGENT = 'ontofelia';

async function makeStore(): Promise<TriplestoreAdapter> {
  const store = new OxigraphAdapter();
  await store.initialize({
    backend: 'oxigraph',
    type: 'embedded',
    dataDir: `/tmp/coginit-test-${process.pid}-${Math.random().toString(16).slice(2)}`,
    port: 0,
    endpoint: '',
  });
  return store;
}

describe('CognitiveConfig.flagInitiative', () => {
  let store: TriplestoreAdapter;
  let cfg: CognitiveConfig;

  beforeEach(async () => {
    store = await makeStore();
    cfg = new CognitiveConfig(store, AGENT);
  });

  it('defaults OFF on an unseeded agent', async () => {
    expect(await cfg.isInitiativeEnabled()).toBe(false);
  });

  it('toggles on and off (hot, no restart)', async () => {
    await cfg.setInitiativeEnabled(true);
    expect(await cfg.isInitiativeEnabled()).toBe(true);
    await cfg.setInitiativeEnabled(false);
    expect(await cfg.isInitiativeEnabled()).toBe(false);
  });
});
