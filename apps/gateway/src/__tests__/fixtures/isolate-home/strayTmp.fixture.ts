import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// Creates a scratch directory in the temp directory and never removes it,
// like a test that forgets its own cleanup.
it('leaves a scratch directory behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stray-scratch-'));
  expect(existsSync(dir)).toBe(true);
});
