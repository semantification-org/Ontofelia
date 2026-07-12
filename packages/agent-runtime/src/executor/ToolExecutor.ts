import { ToolCall, ToolContext, ToolResult, ToolAuditEntry } from '@ontofelia/core';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { INITIATIVE_ALLOWED_TOOLS } from '../initiativeTools.js';

export class ToolExecutor {
  constructor(
    private registry: ToolRegistry,
    private policy: ToolPolicyEngine,
    public auditLog: AuditLog
  ) {}

  private enrichAuditEntry(entry: ToolAuditEntry, context: ToolContext, policyDecision?: ToolAuditEntry['policyDecision']): ToolAuditEntry {
    return {
      ...entry,
      agentId: context.agentId,
      sessionId: context.sessionId,
      channelType: context.channelType,
      senderId: context.senderId,
      isOwner: context.isOwner,
      policyDecision: policyDecision,
      sandboxBackend: context.sandboxConfig?.scope
    };
  }

  async logGuardianDecision(toolCall: ToolCall, approved: boolean, context: ToolContext, duration: number) {
    let input: unknown;
    try { input = JSON.parse(toolCall.arguments || '{}'); } catch { input = toolCall.arguments; }
    
    const entry = {
      toolName: toolCall.name,
      timestamp: new Date().toISOString(),
      duration,
      input,
      output: { guardianApproved: approved },
      success: approved,
      error: approved ? undefined : 'GUARDIAN_DENIED',
      permissions: []
    };
    
    await this.auditLog.log(this.enrichAuditEntry(entry, context, approved ? 'ALLOW' : 'DENY'));
  }

  async execute(toolCall: ToolCall, context: ToolContext): Promise<ToolResult> {
    const sandboxConfig = context.sandboxConfig || { scope: 'off', workspaceAccess: 'rw' };
    const start = Date.now();
    const tool = this.registry.get(toolCall.name);
    
    let input: unknown;
    try {
      input = JSON.parse(toolCall.arguments || '{}');
    } catch {
      input = toolCall.arguments;
    }

    if (!tool) {
      const errorStr = `Tool not found: ${toolCall.name}`;
      const result: ToolResult = {
        success: false,
        error: errorStr,
        output: { error: errorStr },
        auditEntry: {
          toolName: toolCall.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input,
          output: { error: errorStr },
          success: false,
          error: errorStr,
          permissions: []
        }
      };
      await this.auditLog.log(this.enrichAuditEntry(result.auditEntry, context, 'DENY'));
      return result;
    }

    // Initiative execution gate (docs/initiative-architecture.md §5–§6, §8 —
    // THE security boundary, not advertisement filtering). In an unattended
    // cycle (ctx.unattended) any tool NOT in the shared INITIATIVE_ALLOWED_TOOLS
    // allowlist is hard-denied HERE, at the single dispatch chokepoint, so an
    // LLM that NAMES an unadvertised tool (e.g. memory_store — not host-only,
    // not default-deny) cannot run it with nobody watching. This deny is NOT
    // approvable/overridable: there is no owner present to approve, and the
    // approval-queue substrate that would change that is a later task (§8).
    if (context.unattended === true && !INITIATIVE_ALLOWED_TOOLS.has(tool.name)) {
      const rule = 'initiative-restricted-tool';
      const errorStr =
        `Tool '${tool.name}' is not permitted in an unattended initiative cycle ` +
        `(blocked by rule '${rule}'). Initiative cycles may only use notify_owner ` +
        `and read-only tools; destructive/host tools require an attended session.`;
      const result: ToolResult = {
        success: false,
        error: errorStr,
        output: { error: errorStr, blockedBy: rule },
        auditEntry: {
          toolName: tool.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input,
          output: { error: errorStr, blockedBy: rule },
          success: false,
          error: errorStr,
          permissions: tool.permissions,
        },
      };
      await this.auditLog.log(this.enrichAuditEntry(result.auditEntry, context, 'DENY'));
      return result;
    }

    // Self-protection hard block (argument-aware). Runs AFTER Guardian
    // approval by design: a Guardian approve-all can never override it. This is
    // the single chokepoint every tool dispatch passes through, so all tools —
    // including future ones — inherit the guard without per-tool wiring.
    const invocationCheck = this.policy.checkInvocation(tool, input, context);
    if (!invocationCheck.allowed) {
      const errorStr = invocationCheck.reason
        || `Tool invocation denied by self-protection rule '${invocationCheck.rule}'.`;
      const result: ToolResult = {
        success: false,
        error: errorStr,
        output: { error: errorStr, blockedBy: invocationCheck.rule },
        auditEntry: {
          toolName: tool.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input,
          output: { error: errorStr, blockedBy: invocationCheck.rule },
          success: false,
          error: errorStr,
          permissions: tool.permissions
        }
      };
      await this.auditLog.log(this.enrichAuditEntry(result.auditEntry, context, 'DENY'));
      return result;
    }

    const policyCheck = this.policy.isAllowed(tool, context);
    if (!policyCheck.allowed && !policyCheck.requiresApproval) {
      const errorStr = `Tool execution denied: ${policyCheck.reason}`;
      const result: ToolResult = {
        success: false,
        error: errorStr,
        output: { error: errorStr },
        auditEntry: {
          toolName: tool.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input,
          output: { error: errorStr },
          success: false,
          error: errorStr,
          permissions: tool.permissions
        }
      };
      await this.auditLog.log(this.enrichAuditEntry(result.auditEntry, context, 'DENY'));
      return result;
    }

    if (tool.sandboxOnly && sandboxConfig.scope === 'off') {
      const errorStr = `Tool requires an active sandbox, but sandbox is off.`;
      const result: ToolResult = {
        success: false,
        error: errorStr,
        output: { error: errorStr },
        auditEntry: {
          toolName: tool.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input,
          output: { error: errorStr },
          success: false,
          error: errorStr,
          permissions: tool.permissions
        }
      };
      await this.auditLog.log(this.enrichAuditEntry(result.auditEntry, context, 'DENY'));
      return result;
    }

    let warningStr: string | undefined;
    if (sandboxConfig.scope === 'off' && tool.permissions.includes('shell:exec')) {
      warningStr = `WARNING: Executing shell command on host system without sandbox!`;
    }

    try {
      const timeoutMs = tool.timeoutMs || 30000;

      // The old `Promise.race` rejected the caller on timeout but left the tool
      // running — dangling child processes, fs writes and network calls. Wire a
      // real cancellation signal through the ToolContext so cancellation-aware
      // tools (exec, web_fetch) can actually stop. Honoring it is best-effort:
      // tools that ignore the signal simply keep the previous behaviour.
      const abortController = new AbortController();
      const execContext: ToolContext = { ...context, signal: abortController.signal };
      const executePromise = tool.execute(input, execContext);

      let timeoutId: NodeJS.Timeout;
      const timeoutPromise = new Promise<ToolResult>((_, reject) => {
        timeoutId = setTimeout(() => {
          abortController.abort();
          reject(new Error(`Tool execution timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      const result = await Promise.race([executePromise, timeoutPromise]);
      clearTimeout(timeoutId!);
      
      if (warningStr) {
        result.auditEntry.error = result.auditEntry.error ? `${warningStr} | ${result.auditEntry.error}` : warningStr;
      }
      
      await this.auditLog.log(this.enrichAuditEntry(result.auditEntry, context, 'ALLOW'));
      return result;
    } catch (e: unknown) {
      const errorStr = (e as Error).message || 'Unknown tool execution error';
      const result: ToolResult = {
        success: false,
        error: errorStr,
        output: { error: errorStr },
        auditEntry: {
          toolName: tool.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input,
          output: { error: errorStr },
          success: false,
          error: warningStr ? `${warningStr} | ${errorStr}` : errorStr,
          permissions: tool.permissions
        }
      };
      await this.auditLog.log(this.enrichAuditEntry(result.auditEntry, context, 'ALLOW'));
      return result;
    }
  }
}
