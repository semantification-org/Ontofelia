import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import JSON5 from 'json5';

// Hooks let single tests make one step of the write path fail or observe it; by default every
// call goes to the real module.
const hooks = vi.hoisted(() => ({
  rename: undefined as undefined | ((from: string, to: string) => Promise<void>),
  open: undefined as undefined | ((...args: unknown[]) => Promise<unknown>),
  writeFile: undefined as undefined | ((...args: unknown[]) => Promise<void>),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const rename = async (from: string, to: string): Promise<void> =>
    hooks.rename ? hooks.rename(from, to) : actual.rename(from, to);
  const open = async (...args: unknown[]): Promise<unknown> =>
    hooks.open
      ? hooks.open(...args)
      : (actual.open as (...a: unknown[]) => Promise<unknown>)(...args);
  const writeFile = async (...args: unknown[]): Promise<void> =>
    hooks.writeFile
      ? hooks.writeFile(...args)
      : (actual.writeFile as (...a: unknown[]) => Promise<void>)(...args);
  return {
    ...actual,
    rename,
    open,
    writeFile,
    default: { ...actual, rename, open, writeFile },
  };
});

import { updateConfigField } from '../writer.js';

const realFs = await vi.importActual<typeof import('fs/promises')>('fs/promises');

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

const modeOf = async (p: string): Promise<number> => (await fs.stat(p)).mode & 0o7777;

const seed = (model: string): string =>
  `{\n  // keep this comment\n  provider: { defaultModel: '${model}' },\n}\n`;

describeUnix('updateConfigField keeps file mode and symbolic links', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    hooks.rename = undefined;
    hooks.open = undefined;
    hooks.writeFile = undefined;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-config-identity-'));
    configPath = path.join(tmpDir, 'ontofelia.json5');
  });

  afterEach(async () => {
    hooks.rename = undefined;
    hooks.open = undefined;
    hooks.writeFile = undefined;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const leftovers = async (dir: string): Promise<string[]> =>
    (await fs.readdir(dir)).filter((n) => n.endsWith('.tmp'));

  describe('mode', () => {
    it('keeps mode 0600', async () => {
      await fs.writeFile(configPath, seed('old'));
      await fs.chmod(configPath, 0o600);
      await updateConfigField(configPath, 'provider.defaultModel', 'new');
      expect(await modeOf(configPath)).toBe(0o600);
    });

    it('keeps mode 0640 (the mode is copied, not hard-coded)', async () => {
      await fs.writeFile(configPath, seed('old'));
      await fs.chmod(configPath, 0o640);
      await updateConfigField(configPath, 'provider.defaultModel', 'new');
      expect(await modeOf(configPath)).toBe(0o640);
    });

    it('keeps mode 0600 independent of the umask', async () => {
      await fs.writeFile(configPath, seed('old'));
      await fs.chmod(configPath, 0o600);
      const previous = process.umask(0o022);
      try {
        await updateConfigField(configPath, 'provider.defaultModel', 'new');
      } finally {
        process.umask(previous);
      }
      expect(await modeOf(configPath)).toBe(0o600);
    });
  });

  describe('symbolic links', () => {
    it('keeps a symlink in the same directory a link and writes the target', async () => {
      const real = path.join(tmpDir, 'real.json5');
      await fs.writeFile(real, seed('old'));
      await fs.chmod(real, 0o600);
      await fs.symlink('real.json5', configPath);

      await updateConfigField(configPath, 'provider.defaultModel', 'new');

      expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(configPath)).toBe('real.json5');
      expect(JSON5.parse(await fs.readFile(real, 'utf-8')).provider.defaultModel).toBe('new');
      expect((await fs.lstat(real)).isSymbolicLink()).toBe(false);
      expect(await modeOf(real)).toBe(0o600);
      expect(await leftovers(tmpDir)).toEqual([]);
    });

    it('keeps a relative symlink into another directory a link', async () => {
      const otherDir = path.join(tmpDir, 'elsewhere', 'deep');
      await fs.mkdir(otherDir, { recursive: true });
      const real = path.join(otherDir, 'real.json5');
      await fs.writeFile(real, seed('old'));
      await fs.chmod(real, 0o600);
      await fs.symlink(path.join('elsewhere', 'deep', 'real.json5'), configPath);

      await updateConfigField(configPath, 'provider.defaultModel', 'new');

      expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(configPath)).toBe(path.join('elsewhere', 'deep', 'real.json5'));
      expect(JSON5.parse(await fs.readFile(real, 'utf-8')).provider.defaultModel).toBe('new');
      expect(await modeOf(real)).toBe(0o600);
      expect(await leftovers(tmpDir)).toEqual([]);
      expect(await leftovers(otherDir)).toEqual([]);
    });

    it('keeps a chain of two links, links in different directories, a link', async () => {
      const dirA = path.join(tmpDir, 'a');
      const dirB = path.join(tmpDir, 'b');
      await fs.mkdir(dirA);
      await fs.mkdir(dirB);
      const real = path.join(dirB, 'real.json5');
      const middle = path.join(dirA, 'middle.json5');
      await fs.writeFile(real, seed('old'));
      await fs.chmod(real, 0o600);
      await fs.symlink(path.join('..', 'b', 'real.json5'), middle);
      await fs.symlink(path.join('a', 'middle.json5'), configPath);

      await updateConfigField(configPath, 'provider.defaultModel', 'new');

      expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(configPath)).toBe(path.join('a', 'middle.json5'));
      expect((await fs.lstat(middle)).isSymbolicLink()).toBe(true);
      expect(await fs.readlink(middle)).toBe(path.join('..', 'b', 'real.json5'));
      expect(JSON5.parse(await fs.readFile(real, 'utf-8')).provider.defaultModel).toBe('new');
      expect((await fs.lstat(real)).isSymbolicLink()).toBe(false);
      expect(await modeOf(real)).toBe(0o600);
      for (const dir of [tmpDir, dirA, dirB]) {
        expect(await leftovers(dir)).toEqual([]);
      }
    });

    it('creates the target of a dangling link and keeps the link', async () => {
      const real = path.join(tmpDir, 'not-yet.json5');
      await fs.symlink('not-yet.json5', configPath);

      await updateConfigField(configPath, 'provider.defaultModel', 'new');

      expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true);
      expect(JSON5.parse(await fs.readFile(real, 'utf-8')).provider.defaultModel).toBe('new');
    });

    it('refuses a symlink loop without writing anything', async () => {
      const other = path.join(tmpDir, 'other.json5');
      await fs.symlink('other.json5', configPath);
      await fs.symlink('ontofelia.json5', other);

      await expect(updateConfigField(configPath, 'provider.defaultModel', 'new')).rejects.toThrow(
        'too many symbolic links'
      );
      expect((await fs.lstat(configPath)).isSymbolicLink()).toBe(true);
      expect(await leftovers(tmpDir)).toEqual([]);
    });
  });

  describe('atomic write', () => {
    it('leaves the config byte-identical and no temp file when the rename fails', async () => {
      await fs.writeFile(configPath, seed('old'));
      await fs.chmod(configPath, 0o600);
      const before = await fs.readFile(configPath);
      hooks.rename = async () => {
        throw new Error('injected rename failure');
      };

      await expect(updateConfigField(configPath, 'provider.defaultModel', 'new')).rejects.toThrow(
        'injected rename failure'
      );

      expect(Buffer.compare(await fs.readFile(configPath), before)).toBe(0);
      expect(await modeOf(configPath)).toBe(0o600);
      expect(await leftovers(tmpDir)).toEqual([]);
    });

    it('leaves the config byte-identical and no temp file when writing the temp file fails', async () => {
      await fs.writeFile(configPath, seed('old'));
      await fs.chmod(configPath, 0o600);
      const before = await fs.readFile(configPath);
      // The write fails half way: part of the text reaches the temp file, then the call rejects.
      // The hook covers both write paths (file handle and path based) of the module.
      const failHalfWay = async (write: (chunk: string) => Promise<unknown>): Promise<never> => {
        await write('{ partial');
        throw new Error('injected write failure');
      };
      hooks.writeFile = async (target, data) => {
        void data;
        return failHalfWay((chunk) => realFs.writeFile(target as string, chunk));
      };
      hooks.open = async (...args: unknown[]) => {
        const handle = await (realFs.open as (...a: unknown[]) => Promise<import('fs/promises').FileHandle>)(
          ...args
        );
        return new Proxy(handle, {
          get(target, prop) {
            if (prop === 'writeFile') {
              return () => failHalfWay((chunk) => target.writeFile(chunk));
            }
            const member = Reflect.get(target, prop, target) as unknown;
            return typeof member === 'function' ? member.bind(target) : member;
          },
        });
      };

      await expect(updateConfigField(configPath, 'provider.defaultModel', 'new')).rejects.toThrow(
        'injected write failure'
      );

      expect(Buffer.compare(await fs.readFile(configPath), before)).toBe(0);
      expect(await leftovers(tmpDir)).toEqual([]);
    });

    it('never holds the new text in a temp file more permissive than the original', async () => {
      await fs.writeFile(configPath, seed('old'));
      await fs.chmod(configPath, 0o600);
      let groupOtherBits: number | undefined;
      hooks.rename = async (from, to) => {
        groupOtherBits = (await realFs.stat(from)).mode & 0o077;
        await realFs.rename(from, to);
      };

      await updateConfigField(configPath, 'provider.defaultModel', 'new');

      expect(groupOtherBits).toBe(0);
    });
  });

  describe('backup', () => {
    it('gives the .bak the mode of the original', async () => {
      await fs.writeFile(configPath, seed('old'));
      await fs.chmod(configPath, 0o600);
      await updateConfigField(configPath, 'provider.defaultModel', 'new');
      expect(await modeOf(configPath + '.bak')).toBe(0o600);
    });

    it('narrows an existing more permissive .bak to the mode of the original', async () => {
      await fs.writeFile(configPath, seed('old'));
      await fs.chmod(configPath, 0o600);
      await fs.writeFile(configPath + '.bak', 'stale');
      await fs.chmod(configPath + '.bak', 0o644);
      await updateConfigField(configPath, 'provider.defaultModel', 'new');
      expect(await modeOf(configPath + '.bak')).toBe(0o600);
      expect(await fs.readFile(configPath + '.bak', 'utf-8')).toBe(seed('old'));
    });
  });

  describe('existing behaviour', () => {
    it('keeps comments of the JSON5 file', async () => {
      await fs.writeFile(configPath, seed('old'));
      await updateConfigField(configPath, 'provider.defaultModel', 'new');
      const text = await fs.readFile(configPath, 'utf-8');
      expect(text).toContain('// keep this comment');
      expect(JSON5.parse(text).provider.defaultModel).toBe('new');
    });

    it('still creates a missing config', async () => {
      // A new config gets the mode a plain write would: 0o666 under the umask.
      const um = process.umask(0o022);
      try {
        await updateConfigField(configPath, 'provider.defaultModel', 'fresh');
        expect(JSON5.parse(await fs.readFile(configPath, 'utf-8')).provider.defaultModel).toBe('fresh');
        expect((await fs.stat(configPath)).mode & 0o777).toBe(0o666 & ~0o022);
        expect((await fs.stat(configPath)).mode & 0o777).toBe(0o644);
        expect(await leftovers(tmpDir)).toEqual([]);
      } finally {
        process.umask(um);
      }
    });
  });
});
