import { ToolDefinition, ToolContext, ToolResult, ToolPermission, ToolCategory } from '@ontofelia/core';
import { TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver, sparqlIri } from '@ontofelia/semantic-memory';

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
        description: 'Currently has no effect: inferred triples are never returned here, because deployments that predate per-user inference may still hold mixed derivations in the shared inferred graph until it is rebuilt.'
      }
    }
  };

  constructor(private triplestore: TriplestoreAdapter) {}

   
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const args = input as { hoursBack?: number; includeInferred?: boolean };
    // Readable graphs: the agent worldview and the acting user's own graph.
    // Inferred graphs are not read here, whatever `includeInferred` says: a
    // deployment that predates per-user inference may still carry mixed
    // derivations in the shared graph until `rebuildInferredGraphs` has run.
    const graphs = [GraphUriResolver.getWorldviewGraph(context.agentId)];
    if (context.senderId) graphs.push(GraphUriResolver.getUserGraph(context.agentId, context.senderId));

    let data = '';
    let graphValues: string;
    try {
      graphValues = `VALUES ?g { ${graphs.map((g) => sparqlIri(g)).join(' ')} }`;
    } catch (e) {
      const error = (e as Error).message;
      return {
        success: false,
        output: null,
        error,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - startTime,
          input: args,
          output: null,
          success: false,
          error,
          permissions: this.permissions
        }
      };
    }
    const query = `
      SELECT ?s ?p ?o WHERE {
        ${graphValues}
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
