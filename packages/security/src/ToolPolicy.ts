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

/** Context-free verdict on a tool, for the owner on a trusted channel. */
export type ToolPolicyStatus = 'allowed' | 'needs-approval' | 'denied';

export class ToolPolicyEngine {
  private static DEFAULT_DENY = new Set([
    'exec', 'cron_manage', 'fs_write',
    'memory_query', 'memory_retract', 'ontology_propose'
  ]);

  /**
   * Channels on which a person, not a machine the owner configured, talks to
   * the agent. A non-owner on one of them never gets a host tool.
   */
  private static PERSON_CHANNELS: ReadonlySet<string> = new Set([
    'webchat', 'telegram', 'discord', 'slack', 'whatsapp', 'imessage', 'mattermost',
    'signal', 'teams', 'matrix', 'line', 'googlechat', 'zalo',
  ]);

  private readonly selfProtection: SelfProtectionPolicy;

  /** Tools that act on the owner's machine or files. */
  static isHostTool(tool: Pick<ToolDefinition, 'name' | 'hostOnly'>): boolean {
    return tool.hostOnly === true || ToolPolicyEngine.DEFAULT_DENY.has(tool.name) || tool.name.startsWith('fs_');
  }

  /** The tools that need explicit approval unless the allow-list names them. */
  static defaultDeniedTools(): string[] {
    return [...ToolPolicyEngine.DEFAULT_DENY];
  }

  /**
   * Context-free verdict on one tool, mirroring the order of {@link isAllowed}
   * minus everything that depends on who is asking (non-owner on a chat
   * channel, sandbox presence). `denied`: deny list, or an allow-list that does
   * not name it. `needs-approval`: default-deny or host-only and not allowed.
   */
  describeTool(tool: Pick<ToolDefinition, 'name' | 'hostOnly'>): ToolPolicyStatus {
    if (this.config.deny.includes(tool.name)) return 'denied';
    const allowed = this.config.allow.includes(tool.name);
    if (ToolPolicyEngine.DEFAULT_DENY.has(tool.name) && !allowed) return 'needs-approval';
    if (tool.hostOnly && !allowed) return 'needs-approval';
    if (this.config.allow.length > 0 && !allowed) return 'denied';
    return 'allowed';
  }

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

    // A non-owner person in a chat gets no host tool, not even with approval and
    // not through the allow-list: approving pairing grants a conversation, not
    // the owner's machine. Machine senders (webhook, node) are not covered here.
    if (context.isOwner === false && ToolPolicyEngine.PERSON_CHANNELS.has(String(context.channelType))
        && ToolPolicyEngine.isHostTool(tool)) {
      return { allowed: false, reason: 'Host tools are reserved for the owner' };
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
