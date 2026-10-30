import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TRIPLE_COUNT_QUERY, deleteDataDirs } from '../commands/reset.js';

describe('reset verification count', () => {
  it('counts triples across named graphs, not the default graph', () => {
    expect(TRIPLE_COUNT_QUERY).toMatch(/GRAPH\s+\?g\s*\{\s*\?s\s+\?p\s+\?o\s*\}/);
  });
});

describe('reset data deletion', () => {
  let home: string | undefined;
  afterEach(() => {
    if (home) fs.rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  const seed = (rel: string) => {
    const dir = path.join(home!, ...rel.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'data'), 'x');
    return dir;
  };

  it('removes the knowledge graph of both Oxigraph backends and keeps the config', async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-dirs-'));
    const file = seed('triplestore/oxigraph');
    const disk = seed('triplestore/oxigraph-disk');
    const agents = seed('agents');
    fs.writeFileSync(path.join(home, 'ontofelia.json5'), '{}');

    await deleteDataDirs(home);

    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(disk)).toBe(false);
    expect(fs.existsSync(agents)).toBe(false);
    expect(fs.existsSync(path.join(home, 'ontofelia.json5'))).toBe(true);
  });
});
