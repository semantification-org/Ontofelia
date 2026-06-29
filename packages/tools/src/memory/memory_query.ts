/* eslint-disable @typescript-eslint/no-unused-vars */
import { ToolDefinition, ToolContext, ToolResult, TriplestoreAdapter, ToolPermission } from '@ontofelia/core';

export class MemoryQueryTool implements ToolDefinition {
  name = 'memory_query';
  description = 'Runs a SPARQL query (SELECT or CONSTRUCT) directly against the triplestore.';
  category = 'memory' as const;
  permissions: ToolPermission[] = ['memory:read'];
  hostOnly = true;

  inputSchema = {
    type: 'object',
    properties: {
      sparql: { type: 'string', description: 'The SPARQL query to run (SELECT or CONSTRUCT)' }
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
