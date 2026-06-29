import { ToolDefinition, ToolContext, ToolResult, ToolPermission } from '@ontofelia/core';
import { KnowledgeEngine } from '@ontofelia/semantic-memory';

export class MemoryStoreTool implements ToolDefinition {
  name = 'memory_store';
  description = 'Store a fact as real RDF triples in the knowledge graph. Entities become OWL individuals, properties are added to the ontology automatically. The OWL-DL reasoner will check consistency after storage.';
  category = 'memory' as const;
  permissions: ToolPermission[] = ['memory:write'];

  inputSchema = {
    type: 'object',
    properties: {
      subject: { type: 'string', description: 'The subject entity name (e.g. "Alex", "Google", "Berlin")' },
      subjectType: {
        type: 'string',
        enum: ['Person', 'Organization', 'Place', 'Concept', 'Event'],
        description: 'OWL class of the subject'
      },
      predicate: { type: 'string', description: 'The relation/property name (e.g. "worksAt", "livesIn", "knows")' },
      object: { type: 'string', description: 'The object entity name or literal value' },
      objectType: {
        type: 'string',
        enum: ['Person', 'Organization', 'Place', 'Concept', 'Event', 'literal'],
        description: 'OWL class of the object, or "literal" for plain string/number values'
      },
      confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      source: { type: 'string', enum: ['user', 'agent', 'tool'] }
    },
    required: ['subject', 'subjectType', 'predicate', 'object', 'objectType']
  };

  constructor(private knowledgeEngine: KnowledgeEngine) {}

  async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
    const data = input as {
      subject: string; subjectType: string; predicate: string;
      object: string; objectType: string;
      confidence?: string; source?: string;
    };
    const start = Date.now();

    try {
      const result = await this.knowledgeEngine.storeFact(
        {
          subject: data.subject,
          subjectType: data.subjectType,
          predicate: data.predicate,
          object: data.object,
          objectType: data.objectType,
          confidenceLabel: (data.confidence as 'high' | 'medium' | 'low') || 'high',
          sourceKind: (data.source as 'user' | 'agent' | 'tool') || 'agent'
        },
        {
          agentId: context.agentId,
          sessionId: context.sessionId,
          isOwner: context.isOwner,
          // userId routes Person facts into the per-user graph the agent
          // reads back via getSystemPromptContext(); omitting it sends them
          // to the worldview graph where they are invisible to new sessions.
          userId: context.senderId
        }
      );

      return {
        success: true,
        output: {
          stored: true,
          subjectUri: result.subjectUri,
          predicateUri: result.predicateUri,
          objectUri: result.objectUri,
          newEntities: result.newEntities,
          newProperties: result.newProperties,
          tripleCount: result.tripleCount
        },
        auditEntry: {
          toolName: this.name,
          timestamp: new Date().toISOString(),
          duration: Date.now() - start,
          input: data,
          output: { stored: true },
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
