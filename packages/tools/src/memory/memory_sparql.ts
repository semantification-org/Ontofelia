import { ToolDefinition, ToolContext, ToolResult, TriplestoreAdapter, ToolPermission } from '@ontofelia/core';
import { Parser } from 'sparqljs';
import { checkSparqlScope, getQueryableGraphScope } from '@ontofelia/semantic-memory';

export class MemorySparqlTool implements ToolDefinition {
  name = 'memory_sparql';
  description = 'Execute a custom SPARQL SELECT or ASK query against the knowledge graph. Use this for complex queries that the predefined templates in memory_ask cannot handle. Every triple pattern must sit inside an explicit GRAPH <iri> block naming one of the graphs you may read (see the query parameter); GRAPH ?var, SERVICE, FROM graphs outside that list and other users\' graphs are refused.';
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
          'Write every triple pattern inside GRAPH <iri> { ... } with an explicit IRI; ' +
          'GRAPH ?g, SERVICE and graph-less patterns are refused. ' +
          'Graphs you may read (agent identifier "ontofelia"): ' +
          '<urn:shared:ontology> = TBox classes/properties; ' +
          '<urn:shared:meta>, <urn:shared:shapes>, <urn:shared:world> = shared vocabulary and registry; ' +
          '<urn:ontofelia:schema> = agent-local schema extension; ' +
          '<urn:ontofelia:worldview> = validated world knowledge; ' +
          '<urn:ontofelia:user:USERID> = facts about the current user only (USERID is the current sender); ' +
          '<urn:ontofelia:session:SESSIONID> = the current session only; ' +
          '<urn:ontofelia:inferred> = reasoner-materialized triples derived from the worldview; ' +
          '<urn:ontofelia:inferred:user:USERID> = triples derived from the current user\'s own graph. ' +
          'Owner only: <urn:ontofelia:self>, <urn:ontofelia:skills>, <urn:ontofelia:setup> and the cog: state graphs. ' +
          'Claims, evidence, conflicts and episodic memory are not queryable here (use memory_ask / memory_explain). ' +
          'Other users\' graphs are refused. ' +
          'Entity URIs follow the pattern <urn:ontofelia:entity:Name>. ' +
          'Only query these registered graphs — do not invent new graph URIs.'
      }
    },
    required: ['query']
  };

  constructor(private triplestore: TriplestoreAdapter) {}

   
  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const data = input as { query: string };
    const start = Date.now();

    let isSafe = false;
    let hasAsk = false;
    let errorMsg = '';

    try {
      const parsedQuery = new Parser().parse(data.query);

      if (parsedQuery.type !== 'query') {
        errorMsg = 'Query blocked. Only SELECT and ASK queries are allowed.';
      } else if (parsedQuery.queryType !== 'SELECT' && parsedQuery.queryType !== 'ASK') {
        errorMsg = `Query blocked. ${parsedQuery.queryType} is not allowed. Only SELECT and ASK queries are allowed.`;
      } else {
        // SERVICE, GRAPH ?var, graphs the sender may not read, graph-less patterns.
        const scope = getQueryableGraphScope(context.agentId, {
          userId: context.senderId,
          sessionId: context.sessionId,
          isOwner: context.isOwner
        });
        const verdict = checkSparqlScope(data.query, { ...scope, agentId: context.agentId });
        if (!verdict.ok) {
          errorMsg = `Query blocked. ${verdict.message}`;
        } else {
          isSafe = true;
          hasAsk = parsedQuery.queryType === 'ASK';
        }
      }
    } catch {
      // Fail closed: a query this parser cannot read cannot be checked for the
      // graphs it touches, so it is not run.
      errorMsg = 'Query blocked. The query could not be parsed as SPARQL.';
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
