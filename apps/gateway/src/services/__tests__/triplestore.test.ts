import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import type { OntofeliaConfig } from '@ontofelia/config';

// The adapters are replaced by recorders: the test is about which adapter the
// switch picks and with which data directory, so it needs no native binary.
const calls = vi.hoisted(() => ({
  file: [] as unknown[],
  disk: [] as unknown[],
  events: [] as string[],
  importPaths: [] as string[],
  importResult: { imported: false, quads: 0 } as { imported: boolean; quads: number; reason?: string },
  importError: undefined as Error | undefined,
  fileHasImport: false,
}));

vi.mock('@ontofelia/semantic-memory', () => {
  class FileAdapter {
    backend = 'oxigraph';
    async initialize(cfg: unknown) { calls.file.push(cfg); }
    async putGraph() { calls.events.push('putGraph'); }
    constructor() { calls.fileHasImport = 'importFileDataset' in this; }
  }
  class DiskAdapter {
    backend = 'oxigraph';
    async initialize(cfg: unknown) { calls.disk.push(cfg); }
    async importFileDataset(p: string) {
      calls.events.push('import');
      calls.importPaths.push(p);
      if (calls.importError) throw calls.importError;
      return calls.importResult;
    }
    async putGraph() { calls.events.push('putGraph'); }
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
    calls.events.length = 0;
    calls.importPaths.length = 0;
    calls.importResult = { imported: false, quads: 0 };
    calls.importError = undefined;
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

  const fileDataset = path.join(os.homedir(), '.ontofelia', 'triplestore', 'oxigraph', 'dataset.nq');
  const diskConfig = () => config({ backend: 'oxigraph', oxigraphStore: 'disk' });

  it('imports ~/.ontofelia/triplestore/oxigraph/dataset.nq into the on-disk store before the core ontology is put', async () => {
    calls.importResult = { imported: true, quads: 1234 };
    const log = logger();
    // A scratch tree with a core ontology file, so the ontology is found and putGraph runs.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triplestore-test-'));
    try {
      const ontologies = path.join(root, 'packages', 'semantic-memory', 'dist', 'ontologies');
      fs.mkdirSync(ontologies, { recursive: true });
      fs.writeFileSync(path.join(ontologies, 'ontofelia-core.ttl'), '<urn:s> <urn:p> "o" .\n');
      await initTriplestore(diskConfig(), path.join(root, 'apps', 'gateway', 'src'), log as never);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(calls.events).toEqual(['import', 'putGraph']);
    expect(calls.importPaths).toEqual([fileDataset]);
    expect(log.info).toHaveBeenCalledWith(
      `Imported 1234 quads from the file store (${fileDataset}) into the on-disk store; the file is kept.`,
    );
  });

  it('stays silent about the import when nothing was imported', async () => {
    calls.importResult = { imported: false, quads: 5, reason: 'store not empty' };
    const log = logger();
    await initTriplestore(diskConfig(), '/nonexistent/src', log as never);
    expect(calls.importPaths).toEqual([fileDataset]);
    expect(log.info.mock.calls.some(c => String(c[0]).startsWith('Imported'))).toBe(false);
  });

  it('logs an error and rethrows when the import fails, without writing to the store', async () => {
    calls.importError = new Error('Could not import dataset.nq');
    const log = logger();
    await expect(initTriplestore(diskConfig(), '/nonexistent/src', log as never)).rejects.toThrow('Could not import dataset.nq');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('Could not import dataset.nq'));
    expect(calls.events).toEqual(['import']);
  });

  it('does not call importFileDataset on the file adapter', async () => {
    await initTriplestore(config({ backend: 'oxigraph', oxigraphStore: 'file' }), '/nonexistent/src', logger() as never);
    expect(calls.fileHasImport).toBe(false);
    expect(calls.importPaths).toHaveLength(0);
  });
});
