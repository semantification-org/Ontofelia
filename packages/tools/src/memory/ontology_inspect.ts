import { ToolDefinition, ToolContext, ToolResult, ToolPermission, ToolCategory } from '@ontofelia/core';
import { TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver, SHARED_GRAPHS, sparqlIri } from '@ontofelia/semantic-memory';

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

   
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const args = input as { type?: 'classes' | 'properties' | 'all' };
    const type = args.type || 'all';

    // The ontology lives in named graphs only: the shared TBox plus the agent's
    // own schema graph. The default graph is empty on the embedded store.
    const graphs = [SHARED_GRAPHS.ONTOLOGY, GraphUriResolver.getSchemaGraph(context.agentId)];
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

    let resultText = '';

    if (type === 'classes' || type === 'all') {
      const classesQuery = `
        PREFIX owl: <http://www.w3.org/2002/07/owl#>
        PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
        SELECT DISTINCT ?class ?label WHERE {
          ${graphValues}
          GRAPH ?g {
            ?class a owl:Class .
            OPTIONAL { ?class rdfs:label ?label }
          }
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
        SELECT DISTINCT ?prop ?domain ?range WHERE {
          ${graphValues}
          GRAPH ?g {
            { ?prop a owl:ObjectProperty } UNION { ?prop a owl:DatatypeProperty }
            OPTIONAL { ?prop rdfs:domain ?domain }
            OPTIONAL { ?prop rdfs:range ?range }
          }
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
