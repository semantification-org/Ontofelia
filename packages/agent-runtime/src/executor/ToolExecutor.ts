import { ToolCall, ToolContext, ToolResult, ToolAuditEntry } from '@ontofelia/core';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';

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
      
      const executePromise = tool.execute(input, context);
      
      let timeoutId: NodeJS.Timeout;
      const timeoutPromise = new Promise<ToolResult>((_, reject) => {
        timeoutId = setTimeout(() => {
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
