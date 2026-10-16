/**
 * Derivation of the self-model's capabilities and constraints from the real
 * sources: the tool registry, the tool policy, the guardian policy (and, inside
 * `SelfModel.reseedDerived`, the behavior directives of the self graph). No
 * prose is migrated by hand: when a tool is registered, denied or gated, the
 * self-model follows at the next (re)seed.
 */

import type { TriplestoreAdapter } from '@ontofelia/core';
import {
  SelfModel,
  type DerivedPolicyStatus,
  type DerivedSeedReport,
  type DerivedSelfSources,
} from '@ontofelia/semantic-memory';
import type { ToolRegistry } from '@ontofelia/tools';
import type { ToolPolicyEngine } from '@ontofelia/security';
import { GuardianPolicy } from '../GuardianPolicy.js';
import { neutraliseLine } from './untrustedText.js';

const MAX_TOOL_NAME = 80;
const MAX_TOOL_DESCRIPTION = 160;

/**
 * Snapshot of the registered tools with their verdicts. The tool's name and
 * description come from tool/plugin code and may be hostile, so both are
 * collapsed to one inert line here, before they reach the store.
 */
export function collectSelfModelSources(
  registry: Pick<ToolRegistry, 'list'>,
  policy: Pick<ToolPolicyEngine, 'describeTool'>,
): DerivedSelfSources {
  const guarded = new Set(GuardianPolicy.guardedTools());
  const tools: DerivedSelfSources['tools'] = [];
  for (const tool of registry.list()) {
    const policyBeforeGuardian: DerivedPolicyStatus = policy.describeTool(tool);
    // A guardian-gated tool that the policy allows still stops at the owner
    // for risky inputs, so it is shown as needing approval, never as free.
    const effective: DerivedPolicyStatus =
      policyBeforeGuardian === 'allowed' && guarded.has(tool.name) ? 'needs-approval' : policyBeforeGuardian;
    tools.push({
      name: neutraliseLine(tool.name, MAX_TOOL_NAME),
      category: tool.category,
      description: neutraliseLine(tool.description ?? '', MAX_TOOL_DESCRIPTION) || undefined,
      policy: effective,
      policyBeforeGuardian,
    });
  }
  return { tools, guardedTools: [...guarded] };
}

/** Derive and (re)write the derived self-model for `agentId`. Idempotent. */
export async function seedDerivedSelfModel(
  triplestore: TriplestoreAdapter,
  agentId: string,
  registry: Pick<ToolRegistry, 'list'>,
  policy: Pick<ToolPolicyEngine, 'describeTool'>,
): Promise<DerivedSeedReport> {
  return new SelfModel(triplestore, agentId).reseedDerived(collectSelfModelSources(registry, policy));
}
