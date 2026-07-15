import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Self-protection: hard blocks that keep the agent from modifying the
 * installation it is running from (source clobbering, git state destruction,
 * secret-leaking pushes) and from widening its own autonomy budget.
 *
 * Enforced at the security boundary (ToolPolicyEngine → ToolExecutor), NOT the
 * Guardian regex layer: a Guardian "approve all" can never override these.
 * Individual tools may keep their own checks as defense-in-depth.
 */
export interface SelfProtectionConfig {
  /**
   * Directories the agent must never mutate — the "protected installation
   * roots". Default: the directory the gateway process runs from
   * (`process.cwd()` at startup). Injectable for tests and edge deployments.
   */
  protectedRoots?: string[];
  /**
   * The agent's data directory. Always writable, even when nested inside a
   * protected root. Default: `~/.ontofelia`.
   */
  dataDir?: string;
  /**
   * OWNER escape hatch (explicit config file setting): disables the
   * self-source-write and self-git protections (R1/R2). The initiative-cron
   * protection stays active. Default: false. Enabling this must produce a
   * startup warning.
   */
  allowSelfSourceWrites?: boolean;
}

export interface SelfProtectionVerdict {
  blocked: boolean;
  /** Machine-readable rule name, e.g. 'self-source-write'. */
  rule?: string;
  /** Human-readable English explanation naming the rule. */
  message?: string;
}

const ALLOWED_VERDICT: SelfProtectionVerdict = { blocked: false };

/** Commands that mutate the filesystem when given a path argument. */
const MUTATING_COMMANDS = new Set([
  'rm', 'mv', 'cp', 'chmod', 'chown', 'chgrp', 'ln', 'touch', 'truncate',
  'mkdir', 'rmdir', 'unlink', 'shred', 'install', 'rsync',
]);

/** Interactive/in-place editors — opening a protected file with these is a mutation risk. */
const INPLACE_EDITORS = new Set(['vi', 'vim', 'nvim', 'nano', 'ed', 'ex', 'emacs', 'patch']);

/**
 * Copy-like commands whose SOURCE operands are read-only: only the final path
 * operand (the destination) writes. `mv` is deliberately NOT here — it deletes
 * its source, so a source inside a protected root IS a mutation.
 */
const DEST_ONLY_COMMANDS = new Set(['cp', 'rsync', 'install', 'ln']);

/** Wrapper words to skip before the effective command word. */
const COMMAND_WRAPPERS = new Set([
  'sudo', 'doas', 'env', 'nohup', 'nice', 'time', 'command',
  'timeout', 'exec', 'stdbuf', 'setsid', 'ionice',
]);

/**
 * Per-wrapper short/long options that consume the FOLLOWING token as their
 * value (spaced form, e.g. `sudo -u root`, `timeout -s KILL`, `nice -n 5`).
 * Glued forms (`stdbuf -o0`, `--signal=KILL`) are single tokens and need no
 * entry here. Used by {@link SelfProtectionPolicy.stripWrappers} so the real
 * command word is found instead of a stray option value.
 */
const WRAPPER_VALUE_OPTS: Record<string, Set<string>> = {
  sudo: new Set(['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt', '--chdir', '--role', '--type', '--other-user', '--timeout']),
  doas: new Set(['-u', '-C']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  nice: new Set(['-n', '--adjustment']),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  ionice: new Set(['-c', '-n', '-p', '-P', '-u', '--class', '--classdata', '--pid', '--pgid', '--uid']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
  exec: new Set(['-a']),
  time: new Set(['-o', '-f', '--output', '--format']),
};

/** Wrappers that take a leading positional (non-flag) argument of their own. */
const WRAPPER_POSITIONAL = new Set(['timeout']); // `timeout <duration> <cmd>`

/** Shells whose `-c <payload>` we re-analyze recursively. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh']);

/** A single-dash flag cluster that contains the shell `-c` flag (`-c`, `-lc`, `-cx`, `-uec`, `-euxc`, …). */
const SHELL_C_FLAG = /^-[a-zA-Z]*c[a-zA-Z]*$/;
/** Glued equals form of the `-c`/`--command` flag (non-standard, handled defensively). */
const SHELL_C_GLUED = /^(?:--command|-[a-zA-Z]*c[a-zA-Z]*)=([\s\S]*)$/;

/** Git subcommands that destroy or publish state (blocked inside protected roots). */
const GIT_DESTRUCTIVE = new Set([
  'checkout', 'switch', 'restore', 'reset', 'stash', 'clean', 'pull',
  'rebase', 'merge', 'commit', 'push', 'cherry-pick', 'am', 'apply',
  'mv', 'rm', 'filter-branch', 'worktree', 'gc',
]);

/** `git remote <verb>` forms that rewrite publishing targets. */
const GIT_REMOTE_DESTRUCTIVE = new Set(['set-url', 'remove', 'rm', 'rename', 'prune']);

/** Argument field names a file-mutating tool plausibly uses for its target path. */
const PATH_ARG_FIELDS = [
  'path', 'filePath', 'file_path', 'file', 'dest', 'destination',
  'target', 'output', 'outputPath', 'to',
  'dir', 'directory', 'dst', 'savePath', 'location', 'paths',
  'outPath',
];

/** Reserved cron label prefix owned by the runtime's own scheduling. */
export const RESERVED_CRON_PREFIX = 'initiative-';

/**
 * Tokenize a shell command: whitespace-separated words with single/double
 * quotes and backslash escapes honored; `;`, `&&`, `||`, `&`, `|`, `>`, `>>`
 * emitted as standalone operator tokens. This is deliberately NOT a full shell
 * parser — see the limits documented on {@link SelfProtectionPolicy.checkExecCommand}.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  const flush = () => { if (cur.length > 0) { tokens.push(cur); cur = ''; } };

  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '\\' && i + 1 < command.length) { cur += command[++i]; continue; }
    if (/\s/.test(c)) { flush(); continue; }
    if (c === ';') { flush(); tokens.push(';'); continue; }
    if (c === '&') {
      flush();
      if (command[i + 1] === '&') { tokens.push('&&'); i++; } else tokens.push('&');
      continue;
    }
    if (c === '|') {
      flush();
      if (command[i + 1] === '|') { tokens.push('||'); i++; } else tokens.push('|');
      continue;
    }
    if (c === '>') {
      flush();
      if (command[i + 1] === '>') { tokens.push('>>'); i++; } else tokens.push('>');
      continue;
    }
    cur += c;
  }
  flush();
  return tokens;
}

const SEGMENT_SEPARATORS = new Set([';', '&&', '||', '&', '|']);

export class SelfProtectionPolicy {
  private readonly protectedRoots: string[];
  private readonly dataDir: string;
  private readonly allowSelfSourceWrites: boolean;

  constructor(config: SelfProtectionConfig = {}) {
    const roots = config.protectedRoots && config.protectedRoots.length > 0
      ? config.protectedRoots
      : [process.cwd()];
    // Realpath the roots up front so symlinked deployments compare correctly;
    // fall back to the lexical form when the root does not (yet) exist.
    this.protectedRoots = roots.map(r => {
      const abs = path.resolve(r.replace(/^~(?=$|\/)/, os.homedir()));
      try { return fs.realpathSync(abs); } catch { return abs; }
    });
    const dataDir = config.dataDir ?? path.join(os.homedir(), '.ontofelia');
    const absData = path.resolve(dataDir.replace(/^~(?=$|\/)/, os.homedir()));
    let realData: string;
    try { realData = fs.realpathSync(absData); } catch { realData = absData; }
    this.dataDir = realData;
    this.allowSelfSourceWrites = config.allowSelfSourceWrites === true;
  }

  get sourceWritesAllowed(): boolean {
    return this.allowSelfSourceWrites;
  }

  /**
   * Resolve a path (following symlinks and `..`) against `base`. Walks up to
   * the nearest existing ancestor so paths that do not exist yet still resolve.
   * Throws on any resolution failure other than ENOENT — callers fail closed.
   */
  private resolveReal(p: string, base: string): string {
    const abs = path.resolve(base, p);
    let prefix = abs;
    let suffix = '';
    for (;;) {
      try {
        const real = fs.realpathSync(prefix);
        return suffix ? path.join(real, suffix) : real;
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        const parent = path.dirname(prefix);
        if (parent === prefix) return abs; // hit the fs root; keep lexical form
        suffix = suffix ? path.join(path.basename(prefix), suffix) : path.basename(prefix);
        prefix = parent;
      }
    }
  }

  private isInside(candidate: string, dir: string): boolean {
    const rel = path.relative(dir, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  /**
   * True when `p` (resolved against `base`) lands inside a protected root and
   * NOT inside the data directory. On resolution failure (other than the path
   * simply not existing yet) the answer is ambiguous → treated as inside
   * (fail closed).
   */
  private isProtectedPath(p: string, base: string): boolean {
    let resolved: string;
    try {
      resolved = this.resolveReal(p, base);
    } catch {
      return true; // ambiguous resolution — fail closed
    }
    if (this.isInside(resolved, this.dataDir)) return false; // data dir stays writable
    return this.protectedRoots.some(root => this.isInside(resolved, root));
  }

  /**
   * R1 (file tools): deny writes whose target resolves inside a protected root.
   */
  checkWritePath(rawPath: string, baseDir: string): SelfProtectionVerdict {
    if (this.allowSelfSourceWrites) return ALLOWED_VERDICT;
    if (typeof rawPath !== 'string' || rawPath.length === 0) return ALLOWED_VERDICT;
    if (this.isProtectedPath(rawPath, baseDir)) {
      return {
        blocked: true,
        rule: 'self-source-write',
        message:
          `Blocked by self-protection rule 'self-source-write': the target path resolves inside ` +
          `the protected installation root (the checkout this gateway runs from). The running ` +
          `installation's own source tree is never writable from the tool loop; use a separate ` +
          `working directory for code work. The data directory (${this.dataDir}) remains writable.`,
      };
    }
    return ALLOWED_VERDICT;
  }

  /**
   * R1 + R2 (exec): deny shell commands that mutate files or destroy/publish
   * git state inside a protected root.
   *
   * Honest limits — this is token analysis, not a shell interpreter. Caught:
   * plain and quoted arguments, `..` traversal, symlinks, chained commands
   * (`cd <root> && rm x`), pipes into `tee`, redirects (`>`, `>>`), fused
   * shell-flag `-c` payloads in any spelling (`bash -lc`, `sh -cx`,
   * `--command`, nested) re-analyzed recursively, command wrappers
   * (`sudo`/`timeout`/`env`/`stdbuf`/…) with their option values stripped,
   * `git -C`/`--git-dir`/`--work-tree` (both `=` and space forms) and
   * cwd-relative git, and `find … -delete` / `find … -exec rm` scanning a
   * protected root. NOT caught (the exec sandbox and per-tool guards remain the
   * backstop): command substitution (`$( )`, backticks), `eval`, shell
   * variables/globs expanding to protected paths, `xargs`, exotic redirect
   * spellings, paths smuggled through encodings, interpreters that write files
   * without an obvious path token — `node -e "fs.writeFileSync(...)"`,
   * `python -c`, `npx`/`pnpm exec` invoking a mutation, and `gawk -i inplace`.
   */
  checkExecCommand(command: string, cwd: string): SelfProtectionVerdict {
    if (this.allowSelfSourceWrites) return ALLOWED_VERDICT;
    if (typeof command !== 'string' || command.trim().length === 0) return ALLOWED_VERDICT;

    let tokens: string[];
    try {
      tokens = tokenizeCommand(command);
    } catch {
      return this.blockedExec('the command could not be safely analyzed');
    }

    // Split into segments on separators; `cd` in one segment affects later ones.
    const segments: string[][] = [];
    let seg: string[] = [];
    for (const t of tokens) {
      if (SEGMENT_SEPARATORS.has(t)) {
        if (seg.length > 0) segments.push(seg);
        seg = [];
      } else {
        seg.push(t);
      }
    }
    if (seg.length > 0) segments.push(seg);

    let effectiveCwd = cwd;
    for (const segment of segments) {
      const verdict = this.checkSegment(segment, effectiveCwd);
      if (verdict.blocked) return verdict;
      // Track `cd` so relative paths in later segments resolve correctly.
      const words = this.stripWrappers(segment);
      if (words.length >= 2 && words[0] === 'cd') {
        try {
          effectiveCwd = this.resolveReal(words[1], effectiveCwd);
        } catch {
          // Unresolvable cd target: fail closed for the rest of the command
          // only if it lexically points into a protected root.
          effectiveCwd = path.resolve(effectiveCwd, words[1]);
        }
      }
    }
    return ALLOWED_VERDICT;
  }

  /**
   * Drop env assignments and command wrappers (sudo, env, timeout, exec, ...)
   * from the front of a segment so the effective command word is exposed. For
   * each wrapper the wrapper's own option flags AND the value tokens those
   * options consume (`sudo -u <user>`, `timeout -s <sig>`, `nice -n <n>`) are
   * skipped, plus any leading positional a wrapper owns (`timeout <duration>`),
   * so bypasses like `timeout 5 rm <root>/x` or `sudo -u root rm <root>/x`
   * still resolve to the real command instead of stopping at a stray flag.
   */
  private stripWrappers(segment: string[]): string[] {
    let i = 0;
    while (i < segment.length) {
      const t = segment[i];
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) { i++; continue; } // VAR=value prefix (also env's assignments)
      if (!COMMAND_WRAPPERS.has(t)) break;
      i = this.skipWrapperArgs(t, segment, i + 1); // consume the wrapper + its own args
    }
    return segment.slice(i);
  }

  /**
   * Advance past a wrapper's option flags, their consumed values, and any
   * leading positional the wrapper owns. `i` points at the first token AFTER
   * the wrapper word; returns the index of the first token that is not part of
   * the wrapper invocation (the real command word, or the next wrapper).
   */
  private skipWrapperArgs(wrapper: string, segment: string[], i: number): number {
    const valueOpts = WRAPPER_VALUE_OPTS[wrapper];
    while (i < segment.length) {
      const a = segment[i];
      if (a === '-' || !a.startsWith('-')) break; // reached a non-flag (command word or positional)
      // Glued value (`--signal=KILL`, `-o0`) is a single token — consume it alone.
      if (a.includes('=')) { i++; continue; }
      // Spaced value form (`-u root`, `-n 5`): consume the flag and its value.
      if (valueOpts && valueOpts.has(a) && i + 1 < segment.length) { i += 2; continue; }
      i++; // plain flag with no separate value
    }
    // A leading positional the wrapper takes before the command (e.g. timeout's duration).
    if (WRAPPER_POSITIONAL.has(wrapper) && i < segment.length && !segment[i].startsWith('-')) {
      i++;
    }
    return i;
  }

  private blockedExec(detail: string): SelfProtectionVerdict {
    return {
      blocked: true,
      rule: 'self-source-write',
      message:
        `Blocked by self-protection rule 'self-source-write': ${detail}. Commands that mutate ` +
        `files inside the protected installation root (the checkout this gateway runs from) are ` +
        `refused; read-only access (cat/ls/grep/find) is fine, and the data directory ` +
        `(${this.dataDir}) remains writable.`,
    };
  }

  private blockedGit(detail: string): SelfProtectionVerdict {
    return {
      blocked: true,
      rule: 'self-git-protection',
      message:
        `Blocked by self-protection rule 'self-git-protection': ${detail}. Git commands that ` +
        `destroy or publish state (checkout/restore/reset/stash/clean/pull/rebase/merge/commit/` +
        `push/remote set-url/fetch --prune) are refused inside the protected installation root. ` +
        `Read-only git (status/log/diff/show/branch listing) is fine.`,
    };
  }

  private checkSegment(segment: string[], cwd: string): SelfProtectionVerdict {
    // Redirect targets apply to the whole segment regardless of the command word.
    for (let i = 0; i < segment.length - 1; i++) {
      if (segment[i] === '>' || segment[i] === '>>') {
        const target = segment[i + 1];
        if (target && this.isProtectedPath(target, cwd)) {
          return this.blockedExec(`a shell redirect targets '${target}' inside the protected root`);
        }
      }
    }

    // Redirect operators were handled above; drop them (their targets simply
    // become extra "arguments", which only makes the check more conservative).
    const words = this.stripWrappers(segment.filter(t => t !== '>' && t !== '>>'));
    if (words.length === 0) return ALLOWED_VERDICT;
    const cmd = path.basename(words[0]);
    const args = words.slice(1);

    if (cmd === 'git') return this.checkGit(args, cwd);

    if (SHELLS.has(cmd)) {
      // Recurse into the shell's `-c <payload>` in every spelling: bare `-c`,
      // fused single-dash clusters (`-lc`, `-cx`, `-uec`, `-euxc`, `-ic`,
      // `-xc`), the long `--command`, and the non-standard glued `=` form. The
      // payload is a single token after quote-aware tokenization; re-analyzing
      // it recursively also catches nesting (`bash -lc "sh -c 'rm ..'"`).
      for (let j = 0; j < args.length; j++) {
        const a = args[j];
        const glued = SHELL_C_GLUED.exec(a);
        if (glued) return this.checkExecCommand(glued[1], cwd);
        if (SHELL_C_FLAG.test(a) || a === '--command') {
          if (args[j + 1]) return this.checkExecCommand(args[j + 1], cwd);
          return ALLOWED_VERDICT;
        }
      }
      return ALLOWED_VERDICT;
    }

    if (cmd === 'find') return this.checkFind(args, cwd);

    if (cmd === 'dd') {
      for (const a of args) {
        const m = /^of=(.+)$/.exec(a);
        if (m && this.isProtectedPath(m[1], cwd)) {
          return this.blockedExec(`'dd of=${m[1]}' writes inside the protected root`);
        }
      }
      return ALLOWED_VERDICT;
    }

    const isSedPerlInPlace =
      (cmd === 'sed' || cmd === 'perl') && args.some(a => /^-i/.test(a) || a === '--in-place');
    const isMutating = MUTATING_COMMANDS.has(cmd) || cmd === 'tee' || INPLACE_EDITORS.has(cmd);

    if (isMutating || isSedPerlInPlace) {
      if (DEST_ONLY_COMMANDS.has(cmd)) {
        // cp/rsync/install/ln read their SOURCE operands and write only to the
        // destination — checking sources would wrongly block reads OUT of the
        // root (`cp <root>/README.md /tmp/backup`). Guard the destination only.
        for (const target of this.destinationOperands(args)) {
          if (this.isProtectedPath(target, cwd)) {
            return this.blockedExec(`'${cmd}' writes to '${target}' inside the protected root`);
          }
        }
      } else {
        // rm/mv/chmod/touch/tee/editors/… — every path operand is a mutation
        // target (mv deletes its source, so its source counts too).
        for (const a of args) {
          if (a.startsWith('-')) continue; // option flag
          if (this.isProtectedPath(a, cwd)) {
            return this.blockedExec(`'${cmd}' targets '${a}' inside the protected root`);
          }
        }
      }
    }
    return ALLOWED_VERDICT;
  }

  /**
   * Destination path operand(s) of a copy-like command (cp/rsync/install/ln).
   * Honors the destination-first `-t`/`--target-directory` form; otherwise the
   * destination is the final non-flag operand and every earlier operand is a
   * (read-only) source. Value-taking flags such as `install -m 755` leave their
   * value as a non-final operand, so the final-operand heuristic still lands on
   * the real destination.
   */
  private destinationOperands(args: string[]): string[] {
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      const glued = /^--target-directory=(.+)$/.exec(a);
      if (glued) return [glued[1]];
      if ((a === '-t' || a === '--target-directory') && args[k + 1]) return [args[k + 1]];
    }
    const nonFlags = args.filter(a => !a.startsWith('-'));
    return nonFlags.length > 0 ? [nonFlags[nonFlags.length - 1]] : [];
  }

  /**
   * Optional find-guard: block `find <path…> -delete` or `find <path…> -exec
   * rm/mv/… {}` only when a scanned path lands inside a protected root. A
   * read-only find (no `-delete`/mutating `-exec`) is always allowed, so common
   * uses like `find <root> -name '*.ts'` are never over-blocked.
   */
  private checkFind(args: string[], cwd: string): SelfProtectionVerdict {
    const hasDelete = args.includes('-delete');
    let mutatingExec: string | null = null;
    for (let k = 0; k < args.length; k++) {
      if ((args[k] === '-exec' || args[k] === '-execdir') && args[k + 1]) {
        const util = path.basename(args[k + 1]);
        if (MUTATING_COMMANDS.has(util) || SHELLS.has(util)) { mutatingExec = util; break; }
      }
    }
    if (!hasDelete && !mutatingExec) return ALLOWED_VERDICT;
    // Scanned roots are the leading positional args before the first predicate.
    for (const a of args) {
      if (a.startsWith('-')) break;
      if (this.isProtectedPath(a, cwd)) {
        const how = hasDelete ? '-delete' : `-exec ${mutatingExec}`;
        return this.blockedExec(`'find ... ${how}' would mutate paths inside the protected root`);
      }
    }
    return ALLOWED_VERDICT;
  }

  /** R2: git-state protection. `args` are the tokens after the `git` word. */
  private checkGit(args: string[], cwd: string): SelfProtectionVerdict {
    let repoPath = cwd;
    let i = 0;
    // Consume global options; resolve the effective repo path (`git -C <path>`).
    while (i < args.length) {
      const a = args[i];
      if (a === '-C' && args[i + 1]) {
        try { repoPath = this.resolveReal(args[i + 1], repoPath); }
        catch { return this.blockedGit(`the 'git -C ${args[i + 1]}' target could not be resolved`); }
        i += 2;
        continue;
      }
      if (a === '-c' && args[i + 1]) { i += 2; continue; }
      // Space form: `git --git-dir <root>/.git …` / `git --work-tree <root> …`.
      // Mirror the `-C` handling so it can't relocate the effective repo out of
      // a protected root the way the `=`-form already can't.
      if ((a === '--git-dir' || a === '--work-tree') && args[i + 1]) {
        try { repoPath = this.resolveReal(args[i + 1], repoPath); }
        catch { return this.blockedGit(`the '${a} ${args[i + 1]}' target could not be resolved`); }
        i += 2;
        continue;
      }
      // `=` form: `git --git-dir=<root>/.git …` / `git --work-tree=<root> …`.
      const wt = /^--work-tree=(.+)$/.exec(a) ?? /^--git-dir=(.+)$/.exec(a);
      if (wt) {
        try { repoPath = this.resolveReal(wt[1], repoPath); }
        catch { return this.blockedGit(`the '${a}' target could not be resolved`); }
        i++;
        continue;
      }
      if (a.startsWith('-')) { i++; continue; }
      break; // subcommand reached
    }
    if (i >= args.length) return ALLOWED_VERDICT;

    // Only guard repos inside a protected root (data-dir clones stay usable).
    let inRoot: boolean;
    try {
      const resolved = this.resolveReal('.', repoPath);
      inRoot = !this.isInside(resolved, this.dataDir)
        && this.protectedRoots.some(root => this.isInside(resolved, root));
    } catch {
      inRoot = true; // ambiguous — fail closed
    }
    if (!inRoot) return ALLOWED_VERDICT;

    const sub = args[i];
    const rest = args.slice(i + 1);

    if (GIT_DESTRUCTIVE.has(sub)) {
      return this.blockedGit(`'git ${sub}' would rewrite or publish the running installation's git state`);
    }
    if (sub === 'remote') {
      const verb = rest.find(a => !a.startsWith('-'));
      if (verb && GIT_REMOTE_DESTRUCTIVE.has(verb)) {
        return this.blockedGit(`'git remote ${verb}' would rewrite the running installation's remotes`);
      }
      return ALLOWED_VERDICT;
    }
    if (sub === 'fetch' && rest.some(a => a === '--prune' || a === '-p' || a === '--prune-tags')) {
      return this.blockedGit(`'git fetch --prune' would delete refs in the running installation`);
    }
    if (sub === 'branch') {
      const destructiveFlag = rest.some(a =>
        /^-(d|D|m|M|f|c|C)$/.test(a) || /^--(delete|move|force|copy|set-upstream-to|unset-upstream)/.test(a));
      const positional = rest.some(a => !a.startsWith('-'));
      if (destructiveFlag || positional) {
        return this.blockedGit(`'git branch' beyond listing would modify the running installation's refs`);
      }
    }
    return ALLOWED_VERDICT; // status/log/diff/show/branch(list)/fetch/... stay allowed
  }

  /**
   * R4: cron_manage self-schedule protection. Jobs whose label carries the
   * reserved `initiative-` prefix belong to the runtime's own scheduling and
   * may not be created, modified, or removed through the tool.
   * NOT disabled by `allowSelfSourceWrites` — it guards autonomy budget, not source.
   */
  checkCronManage(input: { action?: string; label?: string; removeLabel?: string }): SelfProtectionVerdict {
    const label = input.action === 'remove' ? input.removeLabel : input.label;
    if (typeof label === 'string' && label.startsWith(RESERVED_CRON_PREFIX)) {
      return {
        blocked: true,
        rule: 'initiative-cron-protection',
        message:
          `Blocked by self-protection rule 'initiative-cron-protection': cron job labels starting ` +
          `with '${RESERVED_CRON_PREFIX}' are reserved for the runtime's own scheduling and cannot ` +
          `be created, modified, or removed via cron_manage.`,
      };
    }
    return ALLOWED_VERDICT;
  }

  /**
   * Central entry point used by the ToolPolicyEngine: inspect a concrete tool
   * invocation (name + permissions + parsed arguments) and return a verdict.
   * Any tool carrying the `fs:write` permission inherits the write-path guard,
   * so future file-mutating tools are covered without per-tool wiring.
   */
  checkToolCall(
    tool: { name: string; permissions?: readonly string[] },
    input: unknown,
    workspacePath: string,
  ): SelfProtectionVerdict {
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

    if (tool.name === 'cron_manage') {
      return this.checkCronManage(args as { action?: string; label?: string; removeLabel?: string });
    }

    if (tool.name === 'exec') {
      const command = typeof args.command === 'string' ? args.command : '';
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0
        ? args.cwd
        : (workspacePath || process.cwd());
      return this.checkExecCommand(command, cwd);
    }

    const isFileMutating = tool.name === 'fs_write'
      || (tool.permissions ?? []).includes('fs:write')
      || (tool.permissions ?? []).includes('media:write');
    if (isFileMutating) {
      const base = workspacePath || process.cwd();
      for (const field of PATH_ARG_FIELDS) {
        const value = args[field];
        if (typeof value === 'string' && value.length > 0) {
          const verdict = this.checkWritePath(value, base);
          if (verdict.blocked) return verdict;
        } else if (Array.isArray(value)) {
          // Array-valued path fields (e.g. `paths: [<root>/x, ...]`): check each
          // string element; ignore non-string entries safely (fail closed only
          // for values that clearly denote paths, never crash on odd shapes).
          for (const el of value) {
            if (typeof el === 'string' && el.length > 0) {
              const verdict = this.checkWritePath(el, base);
              if (verdict.blocked) return verdict;
            }
          }
        }
      }
    }
    return ALLOWED_VERDICT;
  }
}
