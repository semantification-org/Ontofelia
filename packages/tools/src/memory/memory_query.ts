import { ToolDefinition, ToolContext, ToolResult, TriplestoreAdapter, ToolPermission } from '@ontofelia/core';
import { checkSparqlScope, getQueryableGraphScope } from '@ontofelia/semantic-memory';

export class MemoryQueryTool implements ToolDefinition {
  name = 'memory_query';
  description = 'Runs a SPARQL query (SELECT or CONSTRUCT) against the triplestore. Triple patterns must sit inside explicit GRAPH <iri> blocks naming a graph the current user may read: the worldview, the agent schema, the shared inferred graph, the shared ontology, meta, shapes and world graphs, the user\'s own graph, own inferred graph and current session graph; the owner may also read the agent\'s internal state graphs. Claims, evidence, conflicts, episodic memory, GRAPH ?var, SERVICE and other users\' graphs are refused.';
  category = 'memory' as const;
  permissions: ToolPermission[] = ['memory:read'];
  hostOnly = true;

  inputSchema = {
    type: 'object',
    properties: {
      sparql: { type: 'string', description: 'The SPARQL query to run (SELECT or CONSTRUCT), with every pattern inside GRAPH <iri> { ... }' }
    },
    required: ['sparql']
  };

  private triplestore: TriplestoreAdapter;

  constructor(triplestore: TriplestoreAdapter) {
    this.triplestore = triplestore;
  }

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const data = input as { sparql: string };
    const start = Date.now();
    
    const scope = getQueryableGraphScope(context.agentId, {
      userId: context.senderId,
      sessionId: context.sessionId,
      isOwner: context.isOwner
    });
    const verdict = checkSparqlScope(data.sparql, { ...scope, agentId: context.agentId });
    if (!verdict.ok) {
      const error = `Query blocked. ${verdict.message}`;
      return {
        success: false,
        output: null,
        error,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input: { sparql: '[BLOCKED]' },
          output: null,
          success: false,
          error,
          permissions: [...this.permissions]
        }
      };
    }

    try {
      const result = await this.triplestore.query(data.sparql);
      
      return {
        success: true,
        output: result,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input: data,
          output: { type: result.type },
          success: true,
          permissions: [...this.permissions]
        }
      };
    } catch (e: unknown) {
      return {
        success: false,
        output: null,
        error: (e as Error).message,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input: data,
          output: null,
          success: false,
          error: (e as Error).message,
          permissions: [...this.permissions]
        }
      };
    }
  }
}
