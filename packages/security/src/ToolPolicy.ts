import { ToolContext, ToolDefinition } from '@ontofelia/core';
import { SelfProtectionConfig, SelfProtectionPolicy } from './SelfProtection.js';

export interface ToolPolicyConfig {
  allow: string[];
  deny: string[];
  /**
   * Self-protection settings (protected installation roots, data dir, owner
   * override). Always on by default — omitting this protects `process.cwd()`.
   */
  selfProtection?: SelfProtectionConfig;
}

export class ToolPolicyEngine {
  private static DEFAULT_DENY = new Set([
    'exec', 'cron_manage', 'fs_write',
    'memory_query', 'memory_retract', 'ontology_propose'
  ]);

  private readonly selfProtection: SelfProtectionPolicy;

  constructor(private config: ToolPolicyConfig) {
    this.selfProtection = new SelfProtectionPolicy(config.selfProtection);
  }

  /**
   * Argument-aware hard check for a concrete tool invocation. Unlike
   * `isAllowed`, a deny here is NOT approvable: it is enforced after Guardian
   * approval (in the ToolExecutor), so an approve-all session cannot override
   * it. Covers self-source writes (R1), git-state destruction in protected
   * roots (R2), and initiative-reserved cron labels (R4).
   */
  checkInvocation(
    tool: Pick<ToolDefinition, 'name' | 'permissions'>,
    input: unknown,
    context: ToolContext,
  ): { allowed: boolean; reason?: string; rule?: string } {
    const verdict = this.selfProtection.checkToolCall(tool, input, context.workspacePath);
    if (verdict.blocked) {
      return { allowed: false, reason: verdict.message, rule: verdict.rule };
    }
    return { allowed: true };
  }

  isAllowed(tool: ToolDefinition, context: ToolContext): { allowed: boolean; reason?: string; requiresApproval?: boolean } {
    if (this.config.deny.includes(tool.name)) {
      return { allowed: false, reason: 'Tool is in deny list' };
    }

    if (ToolPolicyEngine.DEFAULT_DENY.has(tool.name) && !this.config.allow.includes(tool.name)) {
      return { allowed: false, requiresApproval: true, reason: 'Tool is dangerous and requires explicit approval' };
    }

    if (tool.hostOnly && !this.config.allow.includes(tool.name)) {
      return { allowed: false, requiresApproval: true, reason: 'Tool requires explicit approval (hostOnly)' };
    }

    if (tool.sandboxOnly && (!context.sandboxPath || context.sandboxPath === '')) {
      return { allowed: false, reason: 'Tool requires an active sandbox' };
    }

    if (this.config.allow.length > 0 && !this.config.allow.includes(tool.name)) {
      return { allowed: false, reason: 'Tool is not in allow list' };
    }

    return { allowed: true };
  }

  filterAllowed(tools: ToolDefinition[], context: ToolContext): ToolDefinition[] {
    return tools.filter(tool => {
      const check = this.isAllowed(tool, context);
      return check.allowed || check.requiresApproval;
    });
  }
}
