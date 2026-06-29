import { ToolDefinition, ToolPermission, ToolContext, ToolResult } from '@ontofelia/core';
import { SandboxAdapter } from '@ontofelia/sandbox';

export class ExecTool implements ToolDefinition {
  name = 'exec';
  description = 'Run a shell command (in the sandbox when active)';
  category = 'shell' as const;
  permissions: ToolPermission[] = ['shell:exec'];
  sandboxOnly = false;
  hostOnly = true;

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
      timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' }
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
    
    const startTime = Date.now();
    const result = await this.sandbox.exec(instance, data.command, {
      // Default to the agent's real workspace (which exists); fall back to the
      // process cwd. The previous hard-coded '/workspace' does not exist outside
      // a Docker-sandbox mount and caused `spawn /bin/sh ENOENT`.
      cwd: data.cwd || context.workspacePath || process.cwd(),
      timeoutMs: data.timeout || 30000
    });
    
    return {
      success: result.exitCode === 0,
      output: {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
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
