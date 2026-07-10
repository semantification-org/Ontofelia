import { ToolDefinition, ToolPermission, ToolContext, ToolResult } from '@ontofelia/core';
import { SandboxAdapter } from '@ontofelia/sandbox';

export class ExecTool implements ToolDefinition {
  name = 'exec';
  description = 'Run a shell command (in the sandbox when active)';
  category = 'shell' as const;
  permissions: ToolPermission[] = ['shell:exec'];
  sandboxOnly = false;
  hostOnly = true;

  // Default per-command timeout when the caller does not pass one.
  static readonly DEFAULT_TIMEOUT_MS = 30_000;
  // Hard ceiling a single command may run before its process tree is torn down.
  // The per-call `timeout` is clamped to this.
  static readonly MAX_TIMEOUT_MS = 15 * 60 * 1000; // 15 min

  // Executor-level safety net. ToolExecutor times a tool out at `tool.timeoutMs
  // || 30000`; leaving this unset made it cap EVERY exec at 30s and silently
  // ignore the per-call `timeout` — so long-runners (installs/builds) could
  // never finish and the agent looped on the "timed out" failure. Set it just
  // above MAX_TIMEOUT_MS so exec's own timeout always fires first and returns a
  // clean timedOut result; the executor only intervenes if the tool truly hangs.
  timeoutMs = ExecTool.MAX_TIMEOUT_MS + 10_000;

  // Commands that would let the agent restart or kill its OWN gateway/runtime.
  // A self-restart from inside the tool loop terminates the in-flight reply (the
  // user never gets an answer) and has been observed to leave the Telegram
  // channel detached. The gateway lifecycle is owned externally (Docker restart
  // policy / the operator), never by the agent — so we refuse these outright.
  private static readonly FORBIDDEN_PATTERNS: RegExp[] = [
    /\bgateway\s+(re)?start\b/i,                       // "... gateway restart" / "gateway start"
    /\bgateway\s+stop\b/i,                             // "... gateway stop"
    /run-gateway\.sh/i,                                // the launch wrapper
    /ontofelia-docker\/run\.sh/i,                      // the container (re)create script
    /\bdocker\s+(restart|stop|kill|rm|down)\b[\s\S]{0,40}ontofelia/i,
    /\b(pkill|killall)\b[\s\S]{0,30}\bnode\b/i,        // kill the node runtime
    /\bkill\b\s+(-?\w+\s+)?1\b/i,                      // kill PID 1 (the gateway in-container)
    /\bsystemctl\b[\s\S]{0,40}\b(stop|restart)\b[\s\S]{0,40}ontofelia/i,
  ];

  /** Returns the matched pattern source if the command is self-destructive, else null. */
  static forbiddenReason(command: string): string | null {
    for (const re of ExecTool.FORBIDDEN_PATTERNS) {
      if (re.test(command)) return re.source;
    }
    return null;
  }

  inputSchema = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run' },
      cwd: { type: 'string', description: 'Working directory (optional)' },
      timeout: { type: 'number', description: `Timeout in ms (default: ${ExecTool.DEFAULT_TIMEOUT_MS}, max: ${ExecTool.MAX_TIMEOUT_MS}). Pass a larger value for long-running commands such as installs or builds; on timeout the whole process tree is terminated.` }
    },
    required: ['command']
  };

  constructor(private sandbox: SandboxAdapter) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const data = input as { command: string; cwd?: string; timeout?: number };

    // Guardrail: never let the agent restart/kill its own runtime (see above).
    const forbidden = ExecTool.forbiddenReason(data.command ?? '');
    if (forbidden) {
      const message =
        'Refused: this command would restart or kill Ontofelia\'s own gateway/runtime. ' +
        'That terminates the in-flight reply and can detach the messaging channels. ' +
        'The gateway lifecycle is managed externally (Docker restart policy / the operator), ' +
        'not from the agent\'s tool loop.';
      return {
        success: false,
        output: { exitCode: 126, stdout: '', stderr: message, timedOut: false, durationMs: 0 },
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: 0,
          input,
          output: { exitCode: 126, blocked: true, pattern: forbidden },
          success: false,
          permissions: this.permissions,
        },
      };
    }

    const sandboxConfig = context.sandboxConfig || { scope: 'off' as const, workspaceAccess: 'rw' as const };
    const instance = await this.sandbox.getOrCreate(
      context.agentId,
      context.sessionId,
      sandboxConfig,
      context.workspacePath
    );
    
    // Honor the caller's timeout end-to-end, clamped to a sane ceiling. (The
    // executor no longer preempts this at a flat 30s — see `timeoutMs` above.)
    const requestedTimeout =
      typeof data.timeout === 'number' && Number.isFinite(data.timeout)
        ? data.timeout
        : ExecTool.DEFAULT_TIMEOUT_MS;
    const effectiveTimeout = Math.min(
      Math.max(1, requestedTimeout),
      ExecTool.MAX_TIMEOUT_MS,
    );

    const startTime = Date.now();
    const result = await this.sandbox.exec(instance, data.command, {
      // Default to the agent's real workspace (which exists); fall back to the
      // process cwd. The previous hard-coded '/workspace' does not exist outside
      // a Docker-sandbox mount and caused `spawn /bin/sh ENOENT`.
      cwd: data.cwd || context.workspacePath || process.cwd(),
      timeoutMs: effectiveTimeout,
      // Forward the executor's cancellation signal so a tool-timeout actually
      // kills the child process (whole tree) instead of leaving it running.
      signal: context.signal
    });

    // On timeout, tell the agent what happened and how to succeed, so it raises
    // the timeout instead of blindly re-running the same command in a loop.
    const timeoutNote = result.timedOut
      ? `Command timed out after ${effectiveTimeout}ms and its process tree was terminated. `
        + `For long-running commands (e.g. installs or builds) pass a larger \`timeout\` in ms `
        + `(up to ${ExecTool.MAX_TIMEOUT_MS}).`
      : '';

    return {
      success: result.exitCode === 0,
      output: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: timeoutNote ? `${timeoutNote}\n${result.stderr}` : result.stderr,
        timedOut: result.timedOut,
        durationMs: result.durationMs
      },
      auditEntry: {
        toolName: this.name,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        input,
        output: { exitCode: result.exitCode },
        success: result.exitCode === 0,
        permissions: this.permissions
      }
    };
  }
}
