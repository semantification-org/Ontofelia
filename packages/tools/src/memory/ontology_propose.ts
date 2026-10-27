import { ToolDefinition, ToolContext, ToolResult, ToolPermission, ToolCategory } from '@ontofelia/core';
import { OntologyManager } from '@ontofelia/semantic-memory';

export class OntologyProposeTool implements ToolDefinition {
  name = 'ontology_propose';
  description = 'Create an ontology change proposal as a Turtle patch';
  category: ToolCategory = 'ontology';
  permissions: ToolPermission[] = ['ontology:write'];

  inputSchema = {
    type: 'object',
    properties: {
      description: { type: 'string', description: 'Description of the change' },
      turtlePatch: { type: 'string', description: 'New Turtle content for the agent ontology' },
      autoApprove: { type: 'boolean', description: 'Apply the proposal immediately. Only the owner, present in a live conversation, can do this; for anyone else the proposal stays pending.', default: false }
    },
    required: ['description', 'turtlePatch']
  };

  constructor(private ontologyManager: OntologyManager) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const args = input as { description: string; turtlePatch: string; autoApprove?: boolean };

    const proposalId = `p-${Date.now()}`;

    await this.ontologyManager.saveProposal({
      id: proposalId,
      agentId: context.agentId,
      description: args.description,
      turtlePatch: args.turtlePatch,
      createdAt: new Date().toISOString(),
      status: 'pending'
    });

    // Approving changes the ontology the agent reads, so it takes the verified
    // owner in a live conversation (the same gate as the owner-only goal
    // tools). Any other caller leaves the proposal pending for the owner.
    const mayAutoApprove =
      context.isOwner === true && context.ownerPresent === true && context.unattended !== true;

    if (args.autoApprove && mayAutoApprove) {
      await this.ontologyManager.approveProposal(proposalId);
      const msg = `Proposal ${proposalId} created and automatically approved.`;
      return {
        success: true,
        output: msg,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          input: args,
          output: msg,
          success: true,
          permissions: this.permissions
        }
      };
    }

    const msg = args.autoApprove
      ? `Proposal ${proposalId} created and is pending approval: automatic approval is reserved for the owner in a live conversation.`
      : `Proposal ${proposalId} created and is pending approval.`;
    return {
      success: true,
      output: msg,
      auditEntry: {
        toolName: this.name,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        input: args,
        output: msg,
        success: true,
        permissions: this.permissions
      }
    };
  }
}
