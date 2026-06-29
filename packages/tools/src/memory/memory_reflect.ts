import { ToolDefinition, ToolContext, ToolResult, ToolPermission, ToolCategory } from '@ontofelia/core';
import { TriplestoreAdapter } from '@ontofelia/core';

export class MemoryReflectTool implements ToolDefinition {
  name = 'memory_reflect';
  description = 'Reflect on recently stored triples and inferences';
  category: ToolCategory = 'memory';
  permissions: ToolPermission[] = ['memory:read'];

  inputSchema = {
    type: 'object',
    properties: {
      hoursBack: { type: 'number', default: 24, description: 'Hours to look back' },
      includeInferred: { type: 'boolean', default: true }
    }
  };

  constructor(private triplestore: TriplestoreAdapter) {}

   
  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const args = input as { hoursBack?: number; includeInferred?: boolean };
    const includeInferred = args.includeInferred ?? true;

    let data = '';
    const query = `
      SELECT ?s ?p ?o WHERE {
        ?s ?p ?o .
        ${!includeInferred ? 'FILTER EXISTS { GRAPH ?g { ?s ?p ?o } }' : ''}
      } LIMIT 100
    `;

    const res = await this.triplestore.query(query);
    if (res && res.type === 'bindings') {
      data += 'Recent Triples:\\n';
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
