import { ToolDefinition, ToolContext, ToolResult, ToolPermission, ToolCategory } from '@ontofelia/core';
import { TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver } from '@ontofelia/semantic-memory';

export class MemoryReflectTool implements ToolDefinition {
  name = 'memory_reflect';
  description = 'Reflect on stored triples: the agent worldview plus the current user\'s own graph. Inferred triples are not included.';
  category: ToolCategory = 'memory';
  permissions: ToolPermission[] = ['memory:read'];

  inputSchema = {
    type: 'object',
    properties: {
      hoursBack: { type: 'number', default: 24, description: 'Hours to look back' },
      includeInferred: {
        type: 'boolean',
        default: true,
        description: 'Currently has no effect: inferred triples live in one agent-wide graph that mixes all users, so they are never returned until inference is kept per user.'
      }
    }
  };

  constructor(private triplestore: TriplestoreAdapter) {}

   
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const args = input as { hoursBack?: number; includeInferred?: boolean };
    // Readable graphs: the agent worldview and the acting user's own graph.
    // The agent-wide inferred graph mixes every user's inferences and is
    // therefore never read here, whatever `includeInferred` says.
    const graphs = [GraphUriResolver.getWorldviewGraph(context.agentId)];
    if (context.senderId) graphs.push(GraphUriResolver.getUserGraph(context.agentId, context.senderId));

    let data = '';
    const query = `
      SELECT ?s ?p ?o WHERE {
        VALUES ?g { ${graphs.map((g) => `<${g}>`).join(' ')} }
        GRAPH ?g { ?s ?p ?o }
      } LIMIT 100
    `;

    const res = await this.triplestore.query(query);
    if (res && res.type === 'bindings') {
      data += 'Triples:\\n';
      for (const b of res.bindings || []) {
        data += `${b.s?.value} ${b.p?.value} ${b.o?.value}\\n`;
      }
    }

    return {
      success: true,
      output: data || 'No recent triples found',
      auditEntry: {
        toolName: this.name,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        input: args,
        output: data || 'No recent triples found',
        success: true,
        permissions: this.permissions
      }
    };
  }
}
