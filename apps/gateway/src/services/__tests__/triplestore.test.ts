import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import type { OntofeliaConfig } from '@ontofelia/config';

// The adapters are replaced by recorders: the test is about which adapter the
// switch picks and with which data directory, so it needs no native binary.
const calls = vi.hoisted(() => ({ file: [] as unknown[], disk: [] as unknown[] }));

vi.mock('@ontofelia/semantic-memory', () => {
  class FileAdapter {
    backend = 'oxigraph';
    async initialize(cfg: unknown) { calls.file.push(cfg); }
    async putGraph() {}
  }
  class DiskAdapter {
    backend = 'oxigraph';
    async initialize(cfg: unknown) { calls.disk.push(cfg); }
    async putGraph() {}
  }
  class Plain {
    async initialize() {}
  }
  return {
    FusekiManager: Plain,
    FusekiAdapter: Plain,
    InMemoryAdapter: Plain,
    OxigraphAdapter: FileAdapter,
    OxigraphDiskAdapter: DiskAdapter,
    OntologyManager: class { async initialize() {} },
    ConflictDetector: class {},
    ReflectionRunner: class {},
    FusekiWatchdog: Plain,
    GraphRegistry: { create: () => ({}) },
    GraphUriResolver: { getSelfGraph: (id: string) => `urn:self:${id}` },
    KnowledgeEngine: class {
      setLogger() {}
      async seedCoreGraphs() { return { seeded: [] as string[] }; }
    },
  };
});

vi.mock('@ontofelia/agent-runtime', () => ({
  seedDefaultsForFreshInstall: async () => ({ seeded: false, flags: [] }),
}));

import { initTriplestore } from '../triplestore.js';

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

function config(memory: Record<string, unknown>): OntofeliaConfig {
  return { memory } as unknown as OntofeliaConfig;
}

describe('initTriplestore: oxigraph store switch', () => {
  beforeEach(() => {
    calls.file.length = 0;
    calls.disk.length = 0;
  });

  it('uses the file adapter in ~/.ontofelia/triplestore/oxigraph when the switch is "file"', async () => {
    const log = logger();
    await initTriplestore(config({ backend: 'oxigraph', oxigraphStore: 'file' }), '/nonexistent/src', log as never);
    expect(calls.disk).toHaveLength(0);
    expect(calls.file).toEqual([
      { backend: 'oxigraph', type: 'embedded', dataDir: path.join(os.homedir(), '.ontofelia', 'triplestore', 'oxigraph'), port: 0, endpoint: '' },
    ]);
    expect(log.info).toHaveBeenCalledWith('Started Oxigraph Triplestore in embedded mode.');
  });

  it('uses the file adapter when the switch is absent (older parsed configs)', async () => {
    await initTriplestore(config({ backend: 'oxigraph' }), '/nonexistent/src', logger() as never);
    expect(calls.disk).toHaveLength(0);
    expect(calls.file).toHaveLength(1);
  });

  it('uses the on-disk adapter in a separate directory when the switch is "disk"', async () => {
    const log = logger();
    await initTriplestore(config({ backend: 'oxigraph', oxigraphStore: 'disk' }), '/nonexistent/src', log as never);
    expect(calls.file).toHaveLength(0);
    expect(calls.disk).toEqual([
      { backend: 'oxigraph', type: 'embedded', dataDir: path.join(os.homedir(), '.ontofelia', 'triplestore', 'oxigraph-disk'), port: 0, endpoint: '' },
    ]);
    expect(log.info).toHaveBeenCalledWith('Started Oxigraph Triplestore in embedded mode (on-disk store).');
  });
});
