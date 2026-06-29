import { ToolContext, ToolDefinition } from '@ontofelia/core';

export interface ToolPolicyConfig {
  allow: string[];
  deny: string[];
}

export class ToolPolicyEngine {
  private static DEFAULT_DENY = new Set([
    'exec', 'cron_manage', 'fs_write',
    'memory_query', 'memory_retract', 'ontology_propose'
  ]);

  constructor(private config: ToolPolicyConfig) {}

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
