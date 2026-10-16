import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// `globalWorkspace(theta)` must have a production caller. The projection is one
// piece of code (`projectGlobalWorkspace`) used by the stored working memory
// (`WorkingMemory.globalWorkspace`) and by the prompt assembler on the cycle's
// in-memory view. These tests fail if either call is removed.

// Calls through the module boundary (the assembler's import) are recorded.
const calls: Array<{ n: number; theta: number | undefined }> = [];

vi.mock('../cognitive/WorkingMemory.js', async (orig) => {
  const real = await orig<typeof import('../cognitive/WorkingMemory.js')>();
  return {
    ...real,
    projectGlobalWorkspace: (entries: Array<{ buffer: never; salience: number }>, theta?: number) => {
      calls.push({ n: entries.length, theta });
      return real.projectGlobalWorkspace(entries, theta);
    },
  };
});

import { assemblePrompt } from '../cognitive/PromptAssembler.js';
import { WorkingMemory, projectGlobalWorkspace } from '../cognitive/WorkingMemory.js';
import { GraphRegistry, OxigraphAdapter } from '@ontofelia/semantic-memory';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('global workspace projection has production callers', () => {
  beforeEach(() => { calls.length = 0; });

  it('assemblePrompt runs the projection with the given theta', () => {
    assemblePrompt({
      userKey: 'alice', recallEnabled: false, theta: 0.8,
      entries: [{ buffer: 'goalBuffer', entryKind: 'goal-active', text: '- g', salience: 1, forUser: 'alice' }],
    });
    expect(calls).toEqual([{ n: 1, theta: 0.8 }]);
  });

  it('WorkingMemory.globalWorkspace gives what the shared projection gives on the stored entries', async () => {
    const store = new OxigraphAdapter();
    await store.initialize({ backend: 'oxigraph', type: 'embedded', dataDir: `/tmp/gw-test-${Math.random().toString(16).slice(2)}`, port: 0, endpoint: '' });
    const wm = new WorkingMemory(store, GraphRegistry.create(['ontofelia']), 'ontofelia', 'sGW', 'cGW', 'alice');
    await wm.write({ buffer: 'perceptionBuffer', entryKind: 'message-text', payload: 'hi', salience: 1 }, 'urn:phase');
    await wm.write({ buffer: 'selfBuffer', entryKind: 'constraint', payload: 'c', salience: 0.9 }, 'urn:phase');
    await wm.write({ buffer: 'retrievalBuffer', entryKind: 'fact', payload: 'low', salience: 0.2 }, 'urn:phase');
    const ws = await wm.globalWorkspace(0.5);
    expect(ws.map((e) => e.buffer)).toEqual(['selfBuffer', 'perceptionBuffer']);
    // The same projection function over the whole stored set gives the same list.
    expect(ws).toEqual(projectGlobalWorkspace(await wm.read(), 0.5));
  });

  it('both call the one projection function: the source says so (guards against a silent copy)', async () => {
    const wmSrc = await fs.readFile(path.join(here, '../cognitive/WorkingMemory.ts'), 'utf8');
    const asmSrc = await fs.readFile(path.join(here, '../cognitive/PromptAssembler.ts'), 'utf8');
    const method = wmSrc.slice(wmSrc.indexOf('async globalWorkspace('), wmSrc.indexOf('async adjustSalience('));
    expect(method).toContain('projectGlobalWorkspace(');
    expect(asmSrc).toMatch(/projectGlobalWorkspace\(permitted, theta\)/);
    expect(typeof projectGlobalWorkspace).toBe('function');
  });
});
