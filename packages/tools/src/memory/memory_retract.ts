import { ToolDefinition, ToolContext, ToolResult, ToolPermission, ToolCategory } from '@ontofelia/core';
import { TriplestoreAdapter } from '@ontofelia/core';
import { GraphUriResolver, GraphRegistry, GraphPolicyError, KnowledgeEngine, sparqlIri, sparqlStringLiteral } from '@ontofelia/semantic-memory';

/** Claim/Evidence vocabulary namespace (see knowledge-graph-concept.md §4). */
const CLAIM_NS = 'urn:shared:ontology#';

/**
 * memory_retract — hard delete of a fact and all its provenance.
 *
 * Per knowledge-graph-concept.md §7, a privacy/retention-driven retraction
 * removes the base triple AND the associated core:Claim and core:Evidence
 * objects, traceless. This is distinct from normal belief revision, which
 * keeps the claim with status "retracted".
 *
 * Every graph the tool touches is validated against the GraphRegistry, so a
 * hallucinated `graph` argument can never reach the triplestore.
 */
export class MemoryRetractTool implements ToolDefinition {
  name = 'memory_retract';
  description =
    'Hard-delete a fact and its provenance (claim + evidence) from the knowledge graph. ' +
    'Traceless removal for privacy/retention — not normal belief revision.';
  category: ToolCategory = 'memory';
  permissions: ToolPermission[] = ['memory:delete'];
  hostOnly = true;

  inputSchema = {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'Subject URI of the fact to delete' },
      predicate: { type: 'string', description: 'Predicate URI of the fact to delete' },
      object: { type: 'string', description: 'Object URI or literal (optional — omit to delete all matching predicates)' },
      graph: {
        type: 'string',
        description:
          'Named Graph holding the base triple, e.g. urn:ontofelia:user:owner or urn:ontofelia:worldview. ' +
          'Must be a registered graph; defaults to the agent worldview graph.'
      }
    },
    required: ['subject', 'predicate']
  };

  private readonly registry: GraphRegistry;

  constructor(private triplestore: TriplestoreAdapter, registry?: GraphRegistry) {
    this.registry = registry ?? GraphRegistry.create(['ontofelia']);
  }

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();
    const args = input as { subject: string; predicate: string; object?: string; graph?: string };

    // Resolve and validate the target graph. An invented graph URI is
    // rejected before any write — the error message tells the LLM why.
    const targetGraph = args.graph || GraphUriResolver.getWorldviewGraph(context.agentId);
    try {
      this.registry.assertWritable(targetGraph);
    } catch (e) {
      if (e instanceof GraphPolicyError) {
        return this.fail(args, startTime, e.message);
      }
      throw e;
    }

    // A caller may only retract from the agent worldview or its own user graph.
    // Another user's graph is refused before anything is touched.
    const allowedGraphs = [GraphUriResolver.getWorldviewGraph(context.agentId)];
    if (context.senderId) allowedGraphs.push(GraphUriResolver.getUserGraph(context.agentId, context.senderId));
    if (!allowedGraphs.includes(targetGraph)) {
      return this.fail(
        args,
        startTime,
        `Refused: <${targetGraph}> is not a graph you may retract from. ` +
          `Allowed graphs: ${allowedGraphs.map((g) => `<${g}>`).join(', ')}. Nothing was changed.`,
      );
    }

    // Every value that reaches the query text is validated (IRIs) or escaped
    // (literals). These arguments come from the model, so an invalid value is
    // a normal tool failure, never a query.
    let targetGraphIri: string;
    let claimsGraphIri: string;
    let evidenceGraphIri: string;
    let subjectIri: string;
    let predicateIri: string;
    let objectPart = '?o';
    try {
      targetGraphIri = sparqlIri(targetGraph);
      claimsGraphIri = sparqlIri(GraphUriResolver.getClaimsGraph(context.agentId));
      evidenceGraphIri = sparqlIri(GraphUriResolver.getEvidenceGraph(context.agentId));
      subjectIri = sparqlIri(args.subject);
      predicateIri = sparqlIri(args.predicate);
      if (args.object) {
        if (args.object.startsWith('http://') || args.object.startsWith('https://') || args.object.startsWith('urn:')) {
          objectPart = sparqlIri(args.object);
        } else {
          objectPart = sparqlStringLiteral(args.object);
        }
      }
    } catch (e) {
      return this.fail(args, startTime, (e as Error).message);
    }

    // The retracting user's own copy made by the episodic consolidation
    // (`sourceKind "consolidation-episodic"`) goes too: in exactly the graph the
    // ingestion writes this sender's own facts to (`urn:<agent>:user:<senderId>`,
    // the same graph this tool allows), and nowhere else. Another user's graph is
    // never in this list; the target graph itself is handled by the full delete.
    const cascadeGraphs: string[] = [];
    try {
      const own = GraphUriResolver.getUserGraph(context.agentId, context.senderId ?? '');
      if (context.senderId && own !== targetGraph) {
        this.registry.assertWritable(own);
        const ownIri = sparqlIri(own);
        // Only a graph that really holds such a copy is touched (and rebuilt).
        const copy = await this.triplestore.ask(`
          PREFIX claim: <${CLAIM_NS}>
          ASK { GRAPH ${claimsGraphIri} {
            ?claim a claim:Claim ;
                   claim:claimSubject ${subjectIri} ;
                   claim:claimPredicate ${predicateIri} ;
                   claim:assertedInGraph ${ownIri} ;
                   claim:sourceKind "consolidation-episodic" ;
                   ${args.object ? `claim:claimObject ${objectPart} ;` : ''}
                   claim:status "accepted" .
          } }`);
        if (copy) cascadeGraphs.push(own);
      }
    } catch {
      // No usable own graph: nothing to cascade into.
    }

    try {
      await this.hardDelete(targetGraphIri, claimsGraphIri, evidenceGraphIri, subjectIri, predicateIri, objectPart, args.object ? `claim:claimObject ${objectPart} ;` : '', false);
      for (const g of cascadeGraphs) {
        await this.hardDelete(sparqlIri(g), claimsGraphIri, evidenceGraphIri, subjectIri, predicateIri, objectPart, args.object ? `claim:claimObject ${objectPart} ;` : '', true);
      }
    } catch (e) {
      return this.fail(args, startTime, (e as Error).message);
    }

    // Derivations of the removed fact must not outlive it: recompute the
    // inferred graph that belongs to the target graph. If the recompute
    // cannot run, drop that inferred graph instead — a missing derivation is
    // acceptable, a stale one (possibly of private data) is not.
    for (const graph of [targetGraph, ...cascadeGraphs]) {
      try {
        await new KnowledgeEngine(this.triplestore, undefined, this.registry)
          .rebuildInferredGraphFor(context.agentId, graph);
      } catch {
        try {
          const { inferredGraph } = GraphUriResolver.getInferenceScope(context.agentId, graph);
          await this.triplestore.update(`CLEAR SILENT GRAPH ${sparqlIri(inferredGraph)}`);
        } catch {
          // Best effort: the fact itself is already gone.
        }
      }
    }

    return {
      success: true,
      output: `Hard-deleted fact <${args.subject}> <${args.predicate}> and its provenance from <${targetGraph}>.`,
      auditEntry: {
        toolName: this.name,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        input: args,
        output: 'Fact and provenance hard-deleted',
        success: true,
        permissions: this.permissions
      }
    };
  }

  /**
   * The hard delete of one graph: the base triple, then the matching claims and
   * their Evidence (concept §7). With `onlyConsolidation` it removes only what
   * the episodic consolidation made: the triple only while a claim with
   * `sourceKind "consolidation-episodic"` stands behind it in that graph, and
   * only those claims.
   */
  private async hardDelete(
    graphIri: string, claimsGraphIri: string, evidenceGraphIri: string,
    subjectIri: string, predicateIri: string, objectPart: string, objectFilter: string,
    onlyConsolidation: boolean,
  ): Promise<void> {
    const consolidated = onlyConsolidation ? 'claim:sourceKind "consolidation-episodic" ;' : '';
    // 1. Delete the base triple from the graph.
    const deleteTriple = onlyConsolidation
      ? `
      PREFIX claim: <${CLAIM_NS}>
      DELETE {
        GRAPH ${graphIri} { ${subjectIri} ${predicateIri} ?o . }
      } WHERE {
        GRAPH ${graphIri} { ${subjectIri} ${predicateIri} ?o . }
        ${objectPart === '?o' ? '' : `FILTER (?o = ${objectPart})`}
        FILTER EXISTS { GRAPH ${claimsGraphIri} {
          ?claim a claim:Claim ;
                 claim:claimSubject   ${subjectIri} ;
                 claim:claimPredicate ${predicateIri} ;
                 claim:claimObject    ?o ;
                 claim:assertedInGraph ${graphIri} ;
                 claim:sourceKind "consolidation-episodic" .
        } }
      }`
      : `
      DELETE {
        GRAPH ${graphIri} { ${subjectIri} ${predicateIri} ${objectPart} . }
      } WHERE {
        GRAPH ${graphIri} { ${subjectIri} ${predicateIri} ${objectPart} . }
      }`;

    // 2. Hard-delete the matching core:Claim objects AND their core:Evidence,
    //    so no provenance for the removed fact survives (concept §7).
    const deleteProvenance = `
      PREFIX claim: <${CLAIM_NS}>
      DELETE {
        GRAPH ${claimsGraphIri}   { ?claim ?cp ?co . }
        GRAPH ${evidenceGraphIri} { ?evidence ?ep ?eo . }
      } WHERE {
        GRAPH ${claimsGraphIri} {
          ?claim a claim:Claim ;
                 claim:claimSubject   ${subjectIri} ;
                 claim:claimPredicate ${predicateIri} ;
                 (claim:assertedInGraph|claim:targetGraph) ${graphIri} ;
                 ${consolidated}
                 ${objectFilter}
                 ?cp ?co .
          OPTIONAL { ?claim claim:hasEvidence ?evidence . }
        }
        OPTIONAL { GRAPH ${evidenceGraphIri} { ?evidence ?ep ?eo . } }
      }`;

    await this.triplestore.update(deleteTriple);
    await this.triplestore.update(deleteProvenance);
  }

  private fail(input: unknown, startTime: number, error: string): ToolResult {
    return {
      success: false,
      output: null,
      error,
      auditEntry: {
        toolName: this.name,
        timestamp: new Date().toISOString(),
        duration: Date.now() - startTime,
        input,
        output: null,
        success: false,
        error,
        permissions: this.permissions
      }
    };
  }
}
