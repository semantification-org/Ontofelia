import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import JSON5 from 'json5';
import { updateConfigField } from '../writer.js';
import { setJson5Value } from '../json5Edit.js';

describe('updateConfigField', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-config-test-'));
    configPath = path.join(tmpDir, 'ontofelia.json5');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writes valid update and validates', async () => {
    await fs.writeFile(configPath, JSON5.stringify({ provider: { defaultModel: 'old-model' } }));
    
    await updateConfigField(configPath, 'provider.defaultModel', 'new-model');
    
    const updated = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON5.parse(updated);
    expect(parsed.provider.defaultModel).toBe('new-model');
  });

  it('rejects invalid value', async () => {
    await fs.writeFile(configPath, JSON5.stringify({ gateway: { port: 8080 } }));
    
    // Zod throws when gateway.port is set to a string
    await expect(updateConfigField(configPath, 'gateway.port', 'abc')).rejects.toThrow();
    
    // File remains unchanged
    const unchanged = await fs.readFile(configPath, 'utf-8');
    const parsed = JSON5.parse(unchanged);
    expect(parsed.gateway.port).toBe(8080);
  });

  it('creates backup file', async () => {
    await fs.writeFile(configPath, JSON5.stringify({ memory: { backend: 'memory' } }));
    
    await updateConfigField(configPath, 'memory.backend', 'fuseki');
    
    const backupContent = await fs.readFile(configPath + '.bak', 'utf-8');
    const parsedBackup = JSON5.parse(backupContent);
    expect(parsedBackup.memory.backend).toBe('memory');
  });
});

const FIXTURE = `// Ontofelia config - hand maintained
/* block comment
   spanning lines */
{
  gateway: {
    port: 8080, // listen port
    'host': "127.0.0.1",
  },
  provider: {
    defaultModel: 'old-model', // keep me
    "baseUrl": "https://example.org/v1", // not a comment inside the string
    fallbackModels: ['a', 'b'],
  },
  // trailing section comment
}
`;

describe('updateConfigField preserves text', () => {
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ontofelia-config-test-'));
    configPath = path.join(tmpDir, 'ontofelia.json5');
    await fs.writeFile(configPath, FIXTURE);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const read = () => fs.readFile(configPath, 'utf-8');

  it('changes only the target field and keeps comments', async () => {
    await updateConfigField(configPath, 'provider.defaultModel', 'new-model');
    const after = await read();
    const a = FIXTURE.split('\n');
    const b = after.split('\n');
    expect(b.length).toBe(a.length);
    const diff = a.map((l, i) => (l === b[i] ? -1 : i)).filter((i) => i >= 0);
    expect(diff.length).toBe(1);
    expect(b[diff[0]]).toBe(`    defaultModel: 'new-model', // keep me`);
    for (const c of ['// Ontofelia config - hand maintained', '/* block comment', '// listen port', '// keep me', '// trailing section comment']) {
      expect(after).toContain(c);
    }
    expect(JSON5.parse(after).provider.defaultModel).toBe('new-model');
  });

  it('replaces an array value on one line', async () => {
    await updateConfigField(configPath, 'provider.fallbackModels', ['x', 'y', 'z']);
    const after = await read();
    const a = FIXTURE.split('\n');
    const b = after.split('\n');
    expect(b.length).toBe(a.length);
    expect(a.filter((l, i) => l !== b[i]).length).toBe(1);
    expect(JSON5.parse(after).provider.fallbackModels).toEqual(['x', 'y', 'z']);
  });

  it('inserts a missing key inside its parent', async () => {
    await updateConfigField(configPath, 'provider.autoFallback', true);
    const after = await read();
    const parsed = JSON5.parse(after);
    expect(parsed.provider.autoFallback).toBe(true);
    expect(parsed.provider.defaultModel).toBe('old-model');
    expect(after).toContain('    autoFallback: true,\n  },');
    expect(after).toContain('// keep me');
    expect(after.split('\n').length).toBe(FIXTURE.split('\n').length + 1);
  });

  it('inserts a missing key after a last member without trailing comma', async () => {
    await fs.writeFile(configPath, '{\n  provider: {\n    defaultModel: "m" // c\n  }\n}\n');
    await updateConfigField(configPath, 'provider.autoFallback', false);
    const after = await read();
    expect(after).toBe('{\n  provider: {\n    defaultModel: "m", // c\n    autoFallback: false\n  }\n}\n');
  });

  it('inserts a missing intermediate object at top level', async () => {
    await updateConfigField(configPath, 'newSection.flag', true);
    const after = await read();
    expect(JSON5.parse(after).newSection).toEqual({ flag: true });
    expect(after).toContain('  newSection: { flag: true },\n');
    expect(after).toContain('// trailing section comment');
  });

  it('keeps a .bak with the original content', async () => {
    await updateConfigField(configPath, 'provider.defaultModel', 'new-model');
    expect(await fs.readFile(configPath + '.bak', 'utf-8')).toBe(FIXTURE);
  });

  it('keeps a URL with // inside a string intact', async () => {
    await updateConfigField(configPath, 'gateway.port', 9090);
    const after = await read();
    expect(after).toContain('"baseUrl": "https://example.org/v1", // not a comment inside the string');
    expect(JSON5.parse(after).gateway.port).toBe(9090);
  });

  it('throws on a malformed file and leaves it unchanged', async () => {
    const bad = '{ provider: { defaultModel: "x" ';
    await fs.writeFile(configPath, bad);
    await expect(updateConfigField(configPath, 'provider.defaultModel', 'y')).rejects.toThrow();
    expect(await read()).toBe(bad);
  });

  it('throws when an intermediate segment is not an object', async () => {
    await expect(updateConfigField(configPath, 'gateway.port.x', 1)).rejects.toThrow();
    expect(await read()).toBe(FIXTURE);
  });

  it('creates the file when it is missing (unchanged behaviour)', async () => {
    const missing = path.join(tmpDir, 'new.json5');
    await updateConfigField(missing, 'provider.defaultModel', 'm');
    expect(JSON5.parse(await fs.readFile(missing, 'utf-8'))).toEqual({ provider: { defaultModel: 'm' } });
    await expect(fs.stat(missing + '.bak')).rejects.toThrow();
  });
});

describe('setJson5Value quote style', () => {
  it('keeps the quote style of the existing value', () => {
    const single = setJson5Value("{ provider: { defaultModel: 'gpt-5.5' } }", ['provider', 'defaultModel'], 'gpt-5.6-luna');
    expect(single).toContain("defaultModel: 'gpt-5.6-luna'");
    const double = setJson5Value('{ provider: { defaultModel: "gpt-5.5" } }', ['provider', 'defaultModel'], 'gpt-5.6-luna');
    expect(double).toContain('defaultModel: "gpt-5.6-luna"');
  });

  it('round-trips awkward strings through a single-quoted literal', () => {
    const tricky = `it's "q" \\ back\nline\r\t\u2028\u2029 end`;
    const out = setJson5Value("{ a: 'x' }", ['a'], tricky);
    expect(out.startsWith("{ a: '")).toBe(true);
    expect(JSON5.parse(out).a).toBe(tricky);
    const nested = setJson5Value("{ a: 'x' }", ['a'], { k: [tricky] });
    expect(JSON5.parse(nested).a).toEqual({ k: [tricky] });
  });

  it('uses the dominant style of the file for a non-string old value', () => {
    const out = setJson5Value("{ n: 1, a: 'x', b: 'y', c: \"z\" }", ['n'], 'str');
    expect(out).toContain("n: 'str'");
  });

  it('inserts with the dominant quote style of the file', () => {
    const singles = setJson5Value("{ a: 'x', b: 'y', c: \"z\" }", ['d'], { e: "it's" });
    expect(singles).toContain("d: {'e':'it\\'s'}");
    expect(JSON5.parse(singles).d).toEqual({ e: "it's" });
    const tie = setJson5Value("{ a: 'x', b: \"y\" }", ['d'], 'v');
    expect(tie).toContain('d: "v"');
    const none = setJson5Value('{ a: 1, // \'not a string\'\n}', ['d'], 'v');
    expect(none).toContain('d: "v"');
  });
});
