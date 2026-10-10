import { describe, it, expect } from 'vitest';
import { TRIPLE_COUNT_QUERY } from '../commands/reset.js';

describe('reset verification count', () => {
  it('counts triples across named graphs, not the default graph', () => {
    expect(TRIPLE_COUNT_QUERY).toMatch(/GRAPH\s+\?g\s*\{\s*\?s\s+\?p\s+\?o\s*\}/);
  });
});
