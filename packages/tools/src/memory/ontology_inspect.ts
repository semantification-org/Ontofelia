import { ToolDefinition, ToolContext, ToolResult, ToolPermission, ToolCategory } from '@ontofelia/core';
import { TriplestoreAdapter } from '@ontofelia/core';

export class OntologyInspectTool implements ToolDefinition {
  name = 'ontology_inspect';
  description = 'Shows classes, properties, and restrictions of the active ontology';
  category: ToolCategory = 'ontology';
  permissions: ToolPermission[] = ['ontology:read'];
  
  inputSchema = {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['classes', 'properties', 'all'], default: 'all' }
    }
  };

  constructor(private triplestore: TriplestoreAdapter) {}

   
  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const args = input as { type?: 'classes' | 'properties' | 'all' };
    const type = args.type || 'all';

    let resultText = '';

    if (type === 'classes' || type === 'all') {
      const classesQuery = `
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        SELECT ?class ?label WHERE {
          ?class a owl:Class .
          OPTIONAL { ?class rdfs:label ?label }
        }
      `;
      const res = await this.triplestore.query(classesQuery);
      if (res && res.type === 'bindings') {
        resultText += 'Classes:\\n';
        for (const b of res.bindings || []) {
          resultText += `- ${b.class?.value} (${b.label?.value || 'no label'})\\n`;
        }
      }
    }

    if (type === 'properties' || type === 'all') {
      const propsQuery = `
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        SELECT ?prop ?domain ?range WHERE {
          { ?prop a owl:ObjectProperty } UNION { ?prop a owl:DatatypeProperty }
          OPTIONAL { ?prop rdfs:domain ?domain }
          OPTIONAL { ?prop rdfs:range ?range }
        }
      `;
      const res = await this.triplestore.query(propsQuery);
      if (res && res.type === 'bindings') {
        resultText += '\\nProperties:\\n';
        for (const b of res.bindings || []) {
          resultText += `- ${b.prop?.value} (Domain: ${b.domain?.value || 'any'}, Range: ${b.range?.value || 'any'})\\n`;
        }
      }
    }

    return {
      success: true,
      output: resultText || 'No ontology data found',
      auditEntry: {
        toolName: this.name,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        input: args,
        output: resultText || 'No ontology data found',
        success: true,
        permissions: this.permissions
      }
    };
  }
}
