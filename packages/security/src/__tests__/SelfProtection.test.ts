import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SelfProtectionPolicy, RESERVED_CRON_PREFIX, tokenizeCommand } from '../SelfProtection.js';
import { ToolPolicyEngine } from '../ToolPolicy.js';
import { ToolContext } from '@ontofelia/core';

// Real directories so realpath/symlink resolution is exercised for real.
let base: string;       // tmp base
let root: string;       // the protected installation root
let workspace: string;  // the agent workspace (outside the root)
let dataDir: string;    // the agent data dir (always writable)

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ontofelia-selfprot-'));
  root = path.join(base, 'install', 'Ontofelia');
  workspace = path.join(base, 'workspace');
  dataDir = path.join(base, 'data', '.ontofelia');
  fs.mkdirSync(path.join(root, 'packages', 'security'), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), 'x');
  // Symlink INSIDE the workspace that escapes INTO the protected root.
  fs.symlinkSync(root, path.join(workspace, 'sneaky-link'));
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const mkPolicy = (overrides: Partial<ConstructorParameters<typeof SelfProtectionPolicy>[0] & object> = {}) =>
  new SelfProtectionPolicy({ protectedRoots: [root], dataDir, ...overrides });

describe('SelfProtectionPolicy — fs write protection (R1)', () => {
  it('denies an absolute path inside the protected root', () => {
    const v = mkPolicy().checkWritePath(path.join(root, 'packages/security/evil.ts'), workspace);
    expect(v.blocked).toBe(true);
    expect(v.rule).toBe('self-source-write');
    expect(v.message).toMatch(/protected installation root/);
  });

  it('denies ../ traversal from the workspace into the root', () => {
    const rel = path.relative(workspace, path.join(root, 'README.md'));
    expect(rel.startsWith('..')).toBe(true); // sanity: it really is a traversal
    const v = mkPolicy().checkWritePath(rel, workspace);
    expect(v.blocked).toBe(true);
  });

  it('denies a symlinked escape INTO the root (relative, looks workspace-local)', () => {
    const v = mkPolicy().checkWritePath('sneaky-link/README.md', workspace);
    expect(v.blocked).toBe(true);
  });

  it('denies a not-yet-existing path under the root (nearest-ancestor resolution)', () => {
    const v = mkPolicy().checkWritePath(path.join(root, 'brand/new/dir/file.txt'), workspace);
    expect(v.blocked).toBe(true);
  });

  it('allows relative writes inside the workspace', () => {
    const v = mkPolicy().checkWritePath('notes/todo.md', workspace);
    expect(v.blocked).toBe(false);
  });

  it('allows writes to the data dir', () => {
    const v = mkPolicy().checkWritePath(path.join(dataDir, 'memory/state.json'), workspace);
    expect(v.blocked).toBe(false);
  });

  it('keeps the data dir writable even when nested inside a protected root', () => {
    const nestedData = path.join(root, '.ontofelia-data');
    fs.mkdirSync(nestedData, { recursive: true });
    const p = new SelfProtectionPolicy({ protectedRoots: [root], dataDir: nestedData });
    expect(p.checkWritePath(path.join(nestedData, 'x.json'), workspace).blocked).toBe(false);
    expect(p.checkWritePath(path.join(root, 'src.ts'), workspace).blocked).toBe(true);
  });

  it('fails closed when path resolution is ambiguous (unresolvable path)', () => {
    // NUL bytes make realpath/lstat throw a non-ENOENT error → deny.
    const v = mkPolicy().checkWritePath('weird\u0000name', workspace);
    expect(v.blocked).toBe(true);
  });

  it('honors the owner override allowSelfSourceWrites', () => {
    const p = mkPolicy({ allowSelfSourceWrites: true });
    expect(p.checkWritePath(path.join(root, 'x.ts'), workspace).blocked).toBe(false);
    expect(p.sourceWritesAllowed).toBe(true);
  });
});

describe('SelfProtectionPolicy — exec command protection (R1)', () => {
  const p = () => mkPolicy();

  it.each([
    [`rm -rf ${''}ROOT/packages`, 'rm'],
    ['mv ROOT/README.md /tmp/x', 'mv'],
    ['cp /tmp/evil.ts ROOT/packages/security/evil.ts', 'cp'],
    ['chmod 777 ROOT/README.md', 'chmod'],
    ['touch ROOT/marker', 'touch'],
    ['ln -s /tmp/x ROOT/link', 'ln'],
    ['truncate -s 0 ROOT/README.md', 'truncate'],
    ['sed -i s/a/b/ ROOT/README.md', 'sed -i'],
    ['dd if=/dev/zero of=ROOT/README.md', 'dd of='],
    ['echo pwned > ROOT/README.md', 'redirect >'],
    ['echo pwned >> ROOT/README.md', 'redirect >>'],
    ['cat /tmp/x | tee ROOT/README.md', 'tee'],
    ['vim ROOT/README.md', 'in-place editor'],
  ])('denies %s (%s)', (cmd) => {
    const v = p().checkExecCommand(cmd.replaceAll('ROOT', root), workspace);
    expect(v.blocked).toBe(true);
    expect(v.rule).toBe('self-source-write');
  });

  it('denies quoted paths (common LLM output form)', () => {
    const v = p().checkExecCommand(`rm -rf "${root}/packages"`, workspace);
    expect(v.blocked).toBe(true);
  });

  it('denies chained commands: cd into the root, then relative mutation', () => {
    const v = p().checkExecCommand(`cd ${root} && rm README.md`, workspace);
    expect(v.blocked).toBe(true);
  });

  it('denies one level of sh -c nesting', () => {
    const v = p().checkExecCommand(`sh -c "rm ${root}/README.md"`, workspace);
    expect(v.blocked).toBe(true);
    const v2 = p().checkExecCommand(`bash -c 'echo x > ${root}/f'`, workspace);
    expect(v2.blocked).toBe(true);
  });

  it('denies relative mutation when the exec cwd is inside the root', () => {
    const v = p().checkExecCommand('rm README.md', root);
    expect(v.blocked).toBe(true);
  });

  it('denies traversal from the workspace into the root', () => {
    const rel = path.relative(workspace, path.join(root, 'README.md'));
    const v = p().checkExecCommand(`rm ${rel}`, workspace);
    expect(v.blocked).toBe(true);
  });

  it('denies mutation through the workspace symlink into the root', () => {
    const v = p().checkExecCommand('rm sneaky-link/README.md', workspace);
    expect(v.blocked).toBe(true);
  });

  it.each([
    ['cat ROOT/README.md'],
    ['ls -la ROOT/packages'],
    ['grep -rn "policy" ROOT/packages'],
    ['find ROOT -name "*.ts"'],
    ['head -5 ROOT/README.md'],
  ])('allows read-only access: %s', (cmd) => {
    const v = p().checkExecCommand(cmd.replaceAll('ROOT', root), workspace);
    expect(v.blocked).toBe(false);
  });

  it('allows mutations in the workspace and data dir', () => {
    expect(p().checkExecCommand('rm -rf build/', workspace).blocked).toBe(false);
    expect(p().checkExecCommand(`touch ${dataDir}/notes.md`, workspace).blocked).toBe(false);
    expect(p().checkExecCommand(`echo hi > ${workspace}/out.txt`, workspace).blocked).toBe(false);
  });

  it('honors the owner override for exec too', () => {
    const v = mkPolicy({ allowSelfSourceWrites: true })
      .checkExecCommand(`rm -rf ${root}`, workspace);
    expect(v.blocked).toBe(false);
  });
});

describe('SelfProtectionPolicy — git-state protection (R2)', () => {
  const p = () => mkPolicy();

  it.each(['checkout .', 'restore .', 'reset --hard HEAD~1', 'stash', 'clean -fd',
    'pull', 'rebase main', 'merge main', 'commit -m x', 'push origin main',
    'switch main', 'cherry-pick abc123'])(
    'denies git %s via git -C <root>', (sub) => {
      const v = p().checkExecCommand(`git -C ${root} ${sub}`, workspace);
      expect(v.blocked).toBe(true);
      expect(v.rule).toBe('self-git-protection');
    });

  it('denies cwd-relative git invocations inside the root', () => {
    expect(p().checkExecCommand('git push --force origin main', root).blocked).toBe(true);
    expect(p().checkExecCommand('git reset --hard', path.join(root, 'packages')).blocked).toBe(true);
  });

  it('denies git remote set-url and fetch --prune inside the root', () => {
    expect(p().checkExecCommand(`git -C ${root} remote set-url origin https://evil.example/x.git`, workspace).blocked).toBe(true);
    expect(p().checkExecCommand(`git -C ${root} fetch --prune`, workspace).blocked).toBe(true);
    expect(p().checkExecCommand('git remote set-url origin x', root).blocked).toBe(true);
  });

  it('denies git chained after cd into the root', () => {
    const v = p().checkExecCommand(`cd ${root} && git checkout -- .`, workspace);
    expect(v.blocked).toBe(true);
  });

  it.each(['status', 'log --oneline -5', 'diff', 'show HEAD', 'branch', 'branch -a',
    'fetch', 'remote -v', 'remote show origin'])(
    'allows read-only git %s inside the root', (sub) => {
      expect(p().checkExecCommand(`git -C ${root} ${sub}`, workspace).blocked).toBe(false);
      expect(p().checkExecCommand(`git ${sub}`, root).blocked).toBe(false);
    });

  it('denies git branch beyond listing (delete/move/create)', () => {
    expect(p().checkExecCommand(`git -C ${root} branch -D main`, workspace).blocked).toBe(true);
    expect(p().checkExecCommand(`git -C ${root} branch new-branch`, workspace).blocked).toBe(true);
  });

  it('allows destructive git in repos OUTSIDE protected roots (workspace, data dir)', () => {
    expect(p().checkExecCommand('git reset --hard', workspace).blocked).toBe(false);
    expect(p().checkExecCommand(`git -C ${workspace} push`, root).blocked).toBe(false);
    expect(p().checkExecCommand(`git -C ${dataDir}/clone commit -m x`, workspace).blocked).toBe(false);
  });
});

describe('SelfProtectionPolicy — cron self-schedule protection (R4)', () => {
  it('refuses add/remove of initiative-prefixed labels', () => {
    const p = mkPolicy();
    const add = p.checkCronManage({ action: 'add', label: `${RESERVED_CRON_PREFIX}goal-wake` });
    expect(add.blocked).toBe(true);
    expect(add.rule).toBe('initiative-cron-protection');
    const rm = p.checkCronManage({ action: 'remove', removeLabel: `${RESERVED_CRON_PREFIX}goal-wake` });
    expect(rm.blocked).toBe(true);
  });

  it('allows ordinary labels and stays active under allowSelfSourceWrites', () => {
    expect(mkPolicy().checkCronManage({ action: 'add', label: 'daily-summary' }).blocked).toBe(false);
    const p = mkPolicy({ allowSelfSourceWrites: true });
    expect(p.checkCronManage({ action: 'add', label: `${RESERVED_CRON_PREFIX}x` }).blocked).toBe(true);
  });
});

describe('ToolPolicyEngine.checkInvocation — central enforcement (R5)', () => {
  const context: ToolContext = {
    agentId: 'a1', sessionId: 's1', workspacePath: '', channelType: 'cli',
    senderId: 'u1', isOwner: true,
  };
  const engine = () => new ToolPolicyEngine({
    allow: [], deny: [], selfProtection: { protectedRoots: [root], dataDir },
  });

  beforeAll(() => { context.workspacePath = workspace; });

  it('hard-denies fs_write into a protected root with the rule name', () => {
    const res = engine().checkInvocation(
      { name: 'fs_write', permissions: ['fs:write'] },
      { path: path.join(root, 'evil.ts'), content: 'x' },
      context,
    );
    expect(res.allowed).toBe(false);
    expect(res.rule).toBe('self-source-write');
    expect(res.reason).toMatch(/self-source-write/);
  });

  it('covers future file-mutating tools via the fs:write permission', () => {
    const res = engine().checkInvocation(
      { name: 'future_patch_tool', permissions: ['fs:write'] },
      { target: path.join(root, 'README.md'), patch: '---' },
      context,
    );
    expect(res.allowed).toBe(false);
  });

  it('denies exec self-mutation and honors the exec cwd argument', () => {
    const e = engine();
    expect(e.checkInvocation({ name: 'exec', permissions: ['shell:exec'] },
      { command: `rm -rf ${root}` }, context).allowed).toBe(false);
    expect(e.checkInvocation({ name: 'exec', permissions: ['shell:exec'] },
      { command: 'rm README.md', cwd: root }, context).allowed).toBe(false);
    expect(e.checkInvocation({ name: 'exec', permissions: ['shell:exec'] },
      { command: 'ls -la' }, context).allowed).toBe(true);
  });

  it('denies cron_manage on initiative-reserved labels', () => {
    const res = engine().checkInvocation(
      { name: 'cron_manage', permissions: ['shell:exec'] },
      { action: 'remove', removeLabel: 'initiative-nightly' },
      context,
    );
    expect(res.allowed).toBe(false);
    expect(res.rule).toBe('initiative-cron-protection');
  });

  it('defaults the protected root to process.cwd() when unconfigured', () => {
    const e = new ToolPolicyEngine({ allow: [], deny: [] });
    const res = e.checkInvocation(
      { name: 'fs_write', permissions: ['fs:write'] },
      { path: path.join(process.cwd(), 'src/index.ts'), content: 'x' },
      context,
    );
    expect(res.allowed).toBe(false);
  });

  it('config override allowSelfSourceWrites disables R1/R2 but not R4', () => {
    const e = new ToolPolicyEngine({
      allow: [], deny: [],
      selfProtection: { protectedRoots: [root], dataDir, allowSelfSourceWrites: true },
    });
    expect(e.checkInvocation({ name: 'fs_write', permissions: ['fs:write'] },
      { path: path.join(root, 'x.ts'), content: 'x' }, context).allowed).toBe(true);
    expect(e.checkInvocation({ name: 'exec', permissions: ['shell:exec'] },
      { command: `git -C ${root} push` }, context).allowed).toBe(true);
    expect(e.checkInvocation({ name: 'cron_manage', permissions: ['shell:exec'] },
      { action: 'add', label: 'initiative-x', schedule: '0 9 * * *' }, context).allowed).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Adversarial surface — verbatim attack strings from the security review.
// Each covers a specific bypass the review found; ROOT is substituted with the
// real protected root so realpath resolution is exercised end-to-end.
// --------------------------------------------------------------------------
describe('SelfProtectionPolicy — adversarial: fused shell-flag payloads (B1)', () => {
  const p = () => mkPolicy();
  const sub = (cmd: string) => cmd.replaceAll('ROOT', root);

  it.each([
    ['bash -lc "rm -rf ROOT"', 'self-source-write'],
    ['bash -uec "git -C ROOT push"', 'self-git-protection'],
    ['sh -cx "rm ROOT/x"', 'self-source-write'],
    ['bash --command "rm ROOT/x"', 'self-source-write'],
    ['bash -ic "rm ROOT/x"', 'self-source-write'],
    ['sh -xc "rm ROOT/x"', 'self-source-write'],
    ['bash -euxc "rm ROOT/x"', 'self-source-write'],
  ])('denies %s', (cmd, rule) => {
    const v = p().checkExecCommand(sub(cmd), workspace);
    expect(v.blocked).toBe(true);
    expect(v.rule).toBe(rule);
  });

  it('denies nested fused-flag shells: bash -lc "sh -c \'rm ..\'"', () => {
    const v = p().checkExecCommand(sub(`bash -lc "sh -c 'rm ROOT/x'"`), workspace);
    expect(v.blocked).toBe(true);
    expect(v.rule).toBe('self-source-write');
  });

  it('still allows a benign fused-flag payload', () => {
    expect(p().checkExecCommand('bash -lc "ls -la /tmp"', workspace).blocked).toBe(false);
  });
});

describe('SelfProtectionPolicy — adversarial: git --git-dir/--work-tree space form (H1)', () => {
  const p = () => mkPolicy();
  const sub = (cmd: string) => cmd.replaceAll('ROOT', root);

  it('denies git --git-dir <root>/.git reset --hard', () => {
    const v = p().checkExecCommand(sub('git --git-dir ROOT/.git reset --hard'), workspace);
    expect(v.blocked).toBe(true);
    expect(v.rule).toBe('self-git-protection');
  });

  it('denies git --git-dir <root>/.git --work-tree <root> reset --hard', () => {
    const v = p().checkExecCommand(sub('git --git-dir ROOT/.git --work-tree ROOT reset --hard'), workspace);
    expect(v.blocked).toBe(true);
    expect(v.rule).toBe('self-git-protection');
  });

  it('still allows git --git-dir pointing OUTSIDE the protected root', () => {
    const v = p().checkExecCommand(sub(`git --git-dir ${workspace}/.git status`), root);
    expect(v.blocked).toBe(false);
  });
});

describe('SelfProtectionPolicy — adversarial: command-wrapper allowlist (H2)', () => {
  const p = () => mkPolicy();
  const sub = (cmd: string) => cmd.replaceAll('ROOT', root);

  it.each([
    'timeout 5 rm ROOT/x',
    'exec rm ROOT/x',
    'stdbuf -o0 rm ROOT/x',
    'setsid rm ROOT/x',
    'sudo -u root rm ROOT/x',
    'sudo -n rm ROOT/x',
  ])('denies wrapped mutation: %s', (cmd) => {
    const v = p().checkExecCommand(sub(cmd), workspace);
    expect(v.blocked).toBe(true);
    expect(v.rule).toBe('self-source-write');
  });

  it('does not misparse env VAR=val as the command word', () => {
    expect(p().checkExecCommand(sub('env FOO=bar rm ROOT/x'), workspace).blocked).toBe(true);
    expect(p().checkExecCommand('env FOO=bar ls /tmp', workspace).blocked).toBe(false);
  });

  it('still allows wrapped read-only commands', () => {
    expect(p().checkExecCommand(sub('timeout 5 cat ROOT/README.md'), workspace).blocked).toBe(false);
    expect(p().checkExecCommand(sub('sudo -u root cat ROOT/README.md'), workspace).blocked).toBe(false);
  });
});

describe('SelfProtectionPolicy — adversarial: cp/rsync source-out is not blocked (M1)', () => {
  const p = () => mkPolicy();
  const sub = (cmd: string) => cmd.replaceAll('ROOT', root);

  it('allows reading OUT of the root: cp <root>/README.md /tmp/backup', () => {
    expect(p().checkExecCommand(sub('cp ROOT/README.md /tmp/backup'), workspace).blocked).toBe(false);
  });
  it('blocks writing INTO the root: cp /tmp/b <root>/x', () => {
    expect(p().checkExecCommand(sub('cp /tmp/b ROOT/x'), workspace).blocked).toBe(true);
  });
  it('allows rsync reading OUT of the root: rsync -a <root>/ /tmp/', () => {
    expect(p().checkExecCommand(sub('rsync -a ROOT/ /tmp/'), workspace).blocked).toBe(false);
  });
  it('blocks mv from the root (mv deletes its source): mv <root>/x /tmp/', () => {
    expect(p().checkExecCommand(sub('mv ROOT/x /tmp/'), workspace).blocked).toBe(true);
  });
  it('blocks the destination-first cp -t <root> form', () => {
    expect(p().checkExecCommand(sub('cp -t ROOT /tmp/b'), workspace).blocked).toBe(true);
  });
});

describe('SelfProtectionPolicy — adversarial: find-guard (M2 optional)', () => {
  const p = () => mkPolicy();
  const sub = (cmd: string) => cmd.replaceAll('ROOT', root);

  it('blocks find <root> -delete', () => {
    expect(p().checkExecCommand(sub('find ROOT -name "*.ts" -delete'), workspace).blocked).toBe(true);
  });
  it('blocks find <root> -exec rm {} ;', () => {
    expect(p().checkExecCommand(sub('find ROOT -type f -exec rm {} ;'), workspace).blocked).toBe(true);
  });
  it('still allows a read-only find <root> -name "*.ts"', () => {
    expect(p().checkExecCommand(sub('find ROOT -name "*.ts"'), workspace).blocked).toBe(false);
  });
  it('allows find with a mutating -exec but scanning OUTSIDE the root', () => {
    expect(p().checkExecCommand('find /tmp -delete', workspace).blocked).toBe(false);
  });
});

describe('SelfProtectionPolicy — adversarial: fs-write field/type gaps (M4)', () => {
  const context: ToolContext = {
    agentId: 'a1', sessionId: 's1', workspacePath: '', channelType: 'cli',
    senderId: 'u1', isOwner: true,
  };
  const engine = () => new ToolPolicyEngine({
    allow: [], deny: [], selfProtection: { protectedRoots: [root], dataDir },
  });
  beforeAll(() => { context.workspacePath = workspace; });

  it('blocks fs_write via the {dir} field', () => {
    const res = engine().checkInvocation({ name: 'fs_write', permissions: ['fs:write'] },
      { dir: path.join(root, 'newdir') }, context);
    expect(res.allowed).toBe(false);
    expect(res.rule).toBe('self-source-write');
  });
  it('blocks fs_write via the {savePath} field', () => {
    const res = engine().checkInvocation({ name: 'fs_write', permissions: ['fs:write'] },
      { savePath: path.join(root, 'blob.bin') }, context);
    expect(res.allowed).toBe(false);
  });
  it('blocks fs_write via a {paths:[...]} array element', () => {
    const res = engine().checkInvocation({ name: 'fs_write', permissions: ['fs:write'] },
      { paths: ['/tmp/ok.txt', path.join(root, 'x.ts')] }, context);
    expect(res.allowed).toBe(false);
  });
  it('does not crash on non-string array elements and allows out-of-root arrays', () => {
    const res = engine().checkInvocation({ name: 'fs_write', permissions: ['fs:write'] },
      { paths: ['/tmp/a', 42, null, { nested: 'x' }, '/tmp/b'] }, context);
    expect(res.allowed).toBe(true);
  });
});

describe('tokenizeCommand', () => {
  it('splits operators and honors quotes', () => {
    expect(tokenizeCommand('echo "a b" > out && rm -rf x; y | tee z'))
      .toEqual(['echo', 'a b', '>', 'out', '&&', 'rm', '-rf', 'x', ';', 'y', '|', 'tee', 'z']);
  });
  it('keeps sh -c payloads as one token', () => {
    expect(tokenizeCommand(`sh -c "rm /a/b"`)).toEqual(['sh', '-c', 'rm /a/b']);
  });
});
