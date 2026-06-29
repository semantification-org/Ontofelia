import { ToolDefinition, ToolContext, ToolResult, TriplestoreAdapter, ToolPermission } from '@ontofelia/core';
import { Parser } from 'sparqljs';

export class MemorySparqlTool implements ToolDefinition {
  name = 'memory_sparql';
  description = 'Execute a custom SPARQL SELECT or ASK query against the knowledge graph. Use this for complex queries that the predefined templates in memory_ask cannot handle. Knowledge is partitioned into fixed Named Graphs per the Ontofelia knowledge-graph concept — query the appropriate graph, do not invent graph names.';
  category = 'memory' as const;
  permissions: ToolPermission[] = ['memory:read'];

  inputSchema = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'A SPARQL SELECT or ASK query. Available prefixes: onto: <urn:ontofelia:core#>, ' +
          'rdfs: <http://www.w3.org/2000/01/rdf-schema#>. ' +
          'Knowledge lives in fixed Named Graphs (agent identifier "ontofelia"): ' +
          '<urn:shared:ontology> = TBox classes/properties; ' +
          '<urn:ontofelia:self> = agent identity; ' +
          '<urn:ontofelia:user:owner> = facts about the user; ' +
          '<urn:ontofelia:worldview> = validated world knowledge; ' +
          '<urn:ontofelia:claims> = claim provenance; ' +
          '<urn:ontofelia:evidence> = source evidence; ' +
          '<urn:ontofelia:inferred> = reasoner-materialized triples. ' +
          'Entity URIs follow the pattern <urn:ontofelia:entity:Name>. ' +
          'Only query these registered graphs — do not invent new graph URIs.'
      }
    },
    required: ['query']
  };

  constructor(private triplestore: TriplestoreAdapter) {}

   
  async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
    const data = input as { query: string };
    const start = Date.now();

    let isSafe = false;
    let hasAsk = false;
    let errorMsg = '';

    try {
      const parser = new Parser();
      const parsedQuery = parser.parse(data.query);

      if (parsedQuery.type !== 'query') {
        errorMsg = 'Query blocked. Only SELECT and ASK queries are allowed.';
      } else if (parsedQuery.queryType !== 'SELECT' && parsedQuery.queryType !== 'ASK') {
        errorMsg = `Query blocked. ${parsedQuery.queryType} is not allowed. Only SELECT and ASK queries are allowed.`;
      } else {
        // Recursive check for SERVICE clauses
        let hasService = false;
        
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const checkService = (node: any) => {
          if (!node || typeof node !== 'object') return;
          if (node.type === 'service') hasService = true;
          for (const key in node) {
            checkService(node[key]);
          }
        };
        
        checkService(parsedQuery);
        
        if (hasService) {
          errorMsg = 'Query blocked. SERVICE clauses are not allowed.';
        } else {
          isSafe = true;
          hasAsk = parsedQuery.queryType === 'ASK';
        }
      }
    } catch {
      // Fallback: Regex validation
      const strippedQuery = data.query
        .replace(/#.*$/gm, '') // Remove comments
        .replace(/(["'])(?:(?=(\\?))\2.)*?\1/g, "''"); // Remove string literals

      const normalized = strippedQuery.toUpperCase();
      
      const blockedKeywords = ['INSERT', 'DELETE', 'DROP', 'CLEAR', 'LOAD', 'SERVICE', 'CONSTRUCT', 'DESCRIBE', 'CREATE', 'MOVE', 'COPY', 'ADD'];
      const hasModify = blockedKeywords.some(keyword => new RegExp(`\\b${keyword}\\b`).test(normalized));
      
      const hasSelect = /\bSELECT\b/.test(normalized);
      hasAsk = /\bASK\b/.test(normalized);

      if (hasModify) {
        errorMsg = `Query blocked. Modifying keywords (${blockedKeywords.join(', ')}) are forbidden.`;
      } else if (!hasSelect && !hasAsk) {
        errorMsg = 'Query must be a SELECT or ASK query.';
      } else {
        isSafe = true;
      }
    }

    if (!isSafe) {
      return {
        success: false,
        output: null,
        error: errorMsg,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input: { query: '[BLOCKED]' },
          output: null,
          success: false,
          error: errorMsg,
          permissions: [...this.permissions]
        }
      };
    }

    try {
      const result = hasAsk
        ? { type: 'boolean' as const, value: await this.triplestore.ask(data.query) }
        : await this.triplestore.query(data.query);

      return {
        success: true,
        output: result,
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input: data,
          output: { success: true },
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
