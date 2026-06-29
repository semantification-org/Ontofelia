import * as path from 'path';
import * as os from 'os';
import type { OntofeliaConfig } from '@ontofelia/config';
import type { AgentConfig, TriplestoreAdapter } from '@ontofelia/core';
import type { Logger } from 'pino';
import type { KnowledgeEngine, OntologyManager } from '@ontofelia/semantic-memory';
import type { SandboxAdapter } from '@ontofelia/sandbox';
import {
  ToolRegistry, AuditLog,
  datetimeTool, calculatorTool,
  MemoryStoreTool, MemoryQueryTool, MemoryAskTool, MemorySparqlTool, MemoryExplainTool,
  OntologyInspectTool, OntologyProposeTool, MemoryReflectTool, MemoryRetractTool,
  ExecTool, FsReadTool, FsWriteTool, FsListTool,
  SelfInspectTool, WebFetchTool, CronManageTool, PdfReadTool
} from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';

export async function initToolRegistry(
  config: OntofeliaConfig,
  knowledgeEngine: KnowledgeEngine,
  triplestore: TriplestoreAdapter,
  sandboxAdapter: SandboxAdapter,
  ontologyManager: OntologyManager,
  defaultSandboxConfig: AgentConfig['sandbox'],
  _logger: Logger,
) {
  const toolRegistry = new ToolRegistry();

  // Core tools
  toolRegistry.register(datetimeTool);
  toolRegistry.register(calculatorTool);

  // Memory tools
  toolRegistry.register(new MemoryStoreTool(knowledgeEngine));
  toolRegistry.register(new MemoryQueryTool(triplestore));
  toolRegistry.register(new MemoryAskTool(triplestore));
  toolRegistry.register(new MemorySparqlTool(triplestore));
  toolRegistry.register(new MemoryExplainTool(triplestore));

  // Sandbox tools
  toolRegistry.register(new ExecTool(sandboxAdapter));
  toolRegistry.register(new FsReadTool());
  toolRegistry.register(new FsWriteTool());
  toolRegistry.register(new FsListTool());

  // Autonomy tools
  toolRegistry.register(new SelfInspectTool());
  toolRegistry.register(new WebFetchTool());
  toolRegistry.register(new PdfReadTool());
  toolRegistry.register(new CronManageTool(config.gateway.port));

  // Ontology tools
  toolRegistry.register(new OntologyInspectTool(triplestore));
  toolRegistry.register(new OntologyProposeTool(ontologyManager));
  toolRegistry.register(new MemoryReflectTool(triplestore));
  toolRegistry.register(new MemoryRetractTool(triplestore, knowledgeEngine.registry));

  // Tool Policy
  const toolPolicyConfig = (config.tools as { allow?: string[]; deny?: string[] }) || { allow: [], deny: [] };
  // NOTE: memory_retract is intentionally NOT hard-denied. Hard-denying it made
  // "forget" impossible for the deployed agent — it could never delete a fact,
  // which silently broke the core truth-maintenance promise ("forgets when told
  // to"). It stays governed: ToolPolicy's DEFAULT_DENY marks it approval-required
  // (Guardian), so deletion is auditable and owner-gated, but actually executable.
  const defaultDeny: string[] = ['fs_write', 'fs_delete', 'memory_query'];
  if (defaultSandboxConfig.workspaceAccess === 'ro') {
    defaultDeny.push('fs_write');
  }

  const toolPolicy = new ToolPolicyEngine({
    allow: toolPolicyConfig.allow || [],
    deny: [...(toolPolicyConfig.deny || []), ...defaultDeny]
  });

  // Audit Log
  const auditLogPath = path.join(config.agents.defaults.workspace.replace(/^~/, os.homedir()), '..', 'agents', 'default');
  const auditLog = new AuditLog(auditLogPath);

  return { toolRegistry, toolPolicy, auditLog };
}
