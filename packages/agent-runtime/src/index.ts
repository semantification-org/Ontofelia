import { AgentConfig, AgentLifecycle, AgentState, ProviderAdapter, MessageEnvelope, ChatMessage, SessionRecord, SessionOrigin, ToolCall, ToolContext, createLogger } from '@ontofelia/core';
import { SessionStore } from '@ontofelia/session-store';
import { ToolRegistry, AuditLog } from '@ontofelia/tools';
import { ToolPolicyEngine } from '@ontofelia/security';
import { ToolExecutor } from './executor/ToolExecutor.js';
import { SkillRegistry, SkillExecutor } from '@ontofelia/skills';
import { PluginRegistry } from '@ontofelia/plugins';
import { EntityMatcher, KnowledgeEngine, SemanticParser, OntologyContextProvider, SemanticIngestionService, GraphCatalog, ProceduralMemory, SelfModel, EpisodicMemory } from '@ontofelia/semantic-memory';
import type { SemanticParseResult, ConsolidationReport, SeedCapability, SeedConstraint, RetentionReport } from '@ontofelia/semantic-memory';
import { GoalStack } from './cognitive/GoalStack.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { GuardianPolicy } from './GuardianPolicy.js';
import { CycleManager, type ToolEpisodeRecorder, type GoalContextProvider } from './cognitive/CycleManager.js';
import { CognitiveConfig } from './cognitive/CognitiveConfig.js';
import { Metacognition, type MetacogReport } from './cognitive/Metacognition.js';
import { CogHealth, type CogHealthReport } from './cognitive/CogHealth.js';
import {
  CogInspector,
  type CycleSummary,
  type CycleDetail,
  type ResponseExplanation,
} from './cognitive/CogInspector.js';
import type { Goal } from './cognitive/GoalStack.js';
import type { EpisodeHit } from '@ontofelia/semantic-memory';

export interface AgentResponse {
  text: string;
  sessionId: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  model?: string;
  provider?: string;
  /** If set, the primary model returned empty and this fallback model was used */
  fallbackModel?: string;
  /** Inline buttons for Telegram keyboard */
  inlineButtons?: Array<{ text: string; callbackData: string }>;
}

export type StreamChunk = 
  | { type: 'stream_start'; sessionId: string }
  | { type: 'text_delta'; content: string }
  | { type: 'tool_start'; name: string; args: string }
  | { type: 'tool_result'; name: string; success: boolean; output: unknown }
  | { type: 'stream_end'; text: string; sessionId: string; model?: string; provider?: string; fallbackModel?: string; usage?: { promptTokens: number; completionTokens: number; totalTokens: number } };


export interface DebugEvent {
  timestamp: string;
  phase: 'ner' | 'kg_context' | 'llm_call' | 'llm_response' | 'tool_call' | 'tool_result' | 'final' | 'error' | 'guardian_confirm' | 'guardian_denied';
  label: string;
  data?: unknown;
}

export type DebugLogger = (event: DebugEvent) => void;

/**
 * Fallback models to try (in order) when the primary model returns an empty response.
 * These should be reliable, free models on OpenRouter.
 */
const DEFAULT_FALLBACK_MODELS = [
  'deepseek/deepseek-chat-v3-0324:free',
  'google/gemma-3-27b-it:free',
  'meta-llama/llama-4-scout:free',
];

const MAX_TOOL_ROUNDS = 100; // autonomy budget (#962); shared by streaming + non-streaming paths

const BOOTSTRAP_FILES: Record<string, string> = {
  'AGENTS.md': `# Agents\n\nThis file describes the available agents.\n`,
  'SOUL.md': `# Soul\n\nThe agent's personality and behavior.\n`,
  'TOOLS.md': `# Tools\n\nAvailable tools and their configuration.\n`,
  'IDENTITY.md': `# Identity\n\nName, role, and context of the agent.\n`,
  'USER.md': `# User\n\nInformation about the user.\n`,
  'BOOTSTRAP.md': `# Bootstrap\n\nStartup configuration and first steps.\n`,
};

export class AgentRuntime {
  public lifecycle: AgentLifecycle = 'created';
  private activeRuns = 0;
  private totalRuns = 0;
  private lastActivity?: string;

  private entityMatcher?: EntityMatcher;
  private semanticParser?: SemanticParser;
  private ontologyContextProvider?: OntologyContextProvider;
  private ingestionService?: SemanticIngestionService;
  private graphCatalog?: GraphCatalog;
  private cycleManager?: CycleManager;
  private cognitiveConfig?: CognitiveConfig;
  private debugLoggers = new Set<DebugLogger>();
  private pendingGuardians = new Map<string, (approved: boolean) => void>();
  private logger = createLogger('agent-runtime');

  constructor(
    public readonly agentId: string,
    public readonly config: AgentConfig,
    private provider: ProviderAdapter,
    private sessionStore: SessionStore,
    private toolRegistry: ToolRegistry,
    private toolPolicy: ToolPolicyEngine,
    private auditLog: AuditLog,
    private skillRegistry: SkillRegistry,
    private skillExecutor: SkillExecutor,
    private pluginRegistry: PluginRegistry,
    private providerConfig?: import('@ontofelia/core').ProviderConfig,
    private knowledgeEngine?: KnowledgeEngine
  ) {
    this.toolExecutor = new ToolExecutor(toolRegistry, toolPolicy, auditLog);
    if (knowledgeEngine) {
      this.entityMatcher = new EntityMatcher(knowledgeEngine);
      // Reads urn:shared:meta to inject the Named Graph registry into the
      // system prompt — the LLM's binding source of truth for graph routing.
      // The whitelist is passed as a fallback for when meta is unseeded.
      this.graphCatalog = new GraphCatalog(
        knowledgeEngine['triplestore'],
        knowledgeEngine.registry,
      );
      // Cognitive-architecture cycle path (Phase B). Gated by the
      // cog.flagCycleManager flag in the setup graph; defaults OFF, so the
      // legacy handleMessage core runs unchanged until the flag is flipped.
      this.cognitiveConfig = new CognitiveConfig(knowledgeEngine['triplestore'], this.agentId);
      this.cycleManager = new CycleManager(
        knowledgeEngine['triplestore'],
        knowledgeEngine.registry,
        this.agentId,
        (err) => this.emitDebug('error', `cognitive write failed: ${(err as Error).message}`),
      );
    }
    // Initialize Semantic Parser (Ontology Learning pipeline)
    if (provider && knowledgeEngine) {
      const parserModel = providerConfig?.defaultModel || 'google/gemma-3-27b-it:free';
      this.semanticParser = new SemanticParser(provider, {
        model: parserModel,
        temperature: 0.1,
        maxTokens: 2048,
      });
      this.ontologyContextProvider = new OntologyContextProvider(
        knowledgeEngine['triplestore'], // Access the triplestore from KnowledgeEngine
        this.agentId, // include this agent's local schema graph in the context
      );
      this.ingestionService = new SemanticIngestionService(knowledgeEngine);
    }
  }

  /** Register a debug logger that receives real-time events during message processing */
  onDebug(logger: DebugLogger): () => void {
    this.debugLoggers.add(logger);
    return () => { this.debugLoggers.delete(logger); };
  }

  private emitDebug(phase: DebugEvent['phase'], label: string, data?: unknown): void {
    console.log(`[AgentDebug] ${phase}: ${label}`, data ? JSON.stringify(data).substring(0, 200) : '');
    if (this.debugLoggers.size === 0) return;
    const event: DebugEvent = { timestamp: new Date().toISOString(), phase, label, data };
    for (const logger of this.debugLoggers) {
      try { logger(event); } catch { /* ignore */ }
    }
  }

  private toolExecutor: ToolExecutor;

  async initialize(): Promise<void> {
    this.lifecycle = 'initializing';
    
    // Ensure workspace exists
    const resolvedWorkspace = this.config.workspace.replace(/^~/, os.homedir());
    try {
      await fs.mkdir(resolvedWorkspace, { recursive: true });
    } catch (e: unknown) {
       
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }

    // Bootstrap files
    for (const [filename, content] of Object.entries(BOOTSTRAP_FILES)) {
      const filePath = path.join(resolvedWorkspace, filename);
      try {
        await fs.access(filePath);
      } catch {
        await fs.writeFile(filePath, content, 'utf-8');
      }
    }

    this.lifecycle = 'running';
  }

  pause(): void {
    if (this.lifecycle === 'running') {
      this.lifecycle = 'paused';
    }
  }

  resume(): void {
    if (this.lifecycle === 'paused') {
      this.lifecycle = 'running';
    }
  }

  async stop(): Promise<void> {
    this.lifecycle = 'stopped';
  }

  // Sessions for which the user pressed "Approve all" — dangerous tools then
  // execute without further per-command prompts until the session resets (/new).
  private autoApproveSessions = new Set<string>();
  // callId -> sessionId, so "Approve all" can enable auto-approve for the
  // session that the pending tool call belongs to.
  private pendingGuardianSessions = new Map<string, string>();

  isSessionAutoApproved(sessionId: string): boolean {
    return this.autoApproveSessions.has(sessionId);
  }

  trackGuardianSession(callId: string, sessionId: string): void {
    this.pendingGuardianSessions.set(callId, sessionId);
  }

  resolveGuardianApproval(callId: string, approved: boolean, approveAll = false): void {
    if (approveAll && approved) {
      const sid = this.pendingGuardianSessions.get(callId);
      if (sid) this.autoApproveSessions.add(sid);
    }
    this.pendingGuardianSessions.delete(callId);
    const resolver = this.pendingGuardians.get(callId);
    if (resolver) {
      resolver(approved);
      this.pendingGuardians.delete(callId);
    }
  }

  private async waitForGuardianApproval(callId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const wrappedResolve = (approved: boolean) => {
        clearTimeout(timeoutId);
        resolve(approved);
      };
      
      this.pendingGuardians.set(callId, wrappedResolve);
      
      const timeoutId = setTimeout(() => {
        this.pendingGuardians.delete(callId);
        resolve(false);
      }, timeoutMs);
    });
  }

  getState(): AgentState {
    return {
      agentId: this.agentId,
      lifecycle: this.lifecycle,
      activeRuns: this.activeRuns,
      totalRuns: this.totalRuns,
      lastActivity: this.lastActivity
    };
  }

  private resolveModel(model: string): string {
    // Check aliases first
    if (this.providerConfig?.aliases?.[model]) {
      return this.providerConfig.aliases[model];
    }
    // Fall back to provider's defaultModel if agent has placeholder or empty model
    if (!model || model === 'provider/model' || model === 'mock') {
      return this.providerConfig?.defaultModel || model;
    }
    
    // Strip provider prefix if present (e.g. 'openrouter/google/gemma...' -> 'google/gemma...')
    const providerName = this.providerConfig?.name || 'openrouter';
    const prefix = `${providerName}/`;
    if (model.startsWith(prefix)) {
      // Don't strip if the remaining part doesn't look like a real model (edge case)
      // Actually, OpenRouter models usually have a slash in them (like google/gemma). 
      // If we strip 'openrouter/', we get 'google/gemma'. This is correct.
      return model.substring(prefix.length);
    }
    
    return model;
  }

  private detectResponseLanguage(text: string): string | undefined {
    const normalized = text.trim().toLowerCase();
    if (!normalized) return undefined;

    const scores: Record<string, number> = {
      German: 0,
      English: 0,
      Turkish: 0,
      French: 0,
      Spanish: 0,
      Italian: 0,
    };

    const addMatches = (language: string, patterns: RegExp[]) => {
      for (const pattern of patterns) {
        if (pattern.test(normalized)) scores[language]++;
      }
    };

    addMatches('German', [
      /[äöüß]/,
      /\b(guten\s+(morgen|tag|abend|nacht)|hallo|moin|servus|danke|bitte)\b/,
      /\b(ich|du|mir|mich|mein|dein|wir|ihr|sie)\b/,
      /\b(wie|was|wer|wo|warum|wann|welche|welcher|welches)\b/,
      /\b(nicht|kein|keine|und|oder|aber|ist|sind|kannst|kann|möchte|wuerde|würde|über|ueber)\b/,
    ]);
    addMatches('English', [
      /\b(hello|hi|hey|good\s+(morning|afternoon|evening|night)|thanks|thank\s+you|please)\b/,
      /\b(i|me|my|you|your|we|they)\b/,
      /\b(how|what|who|where|why|when|which)\b/,
      /\b(not|no|and|or|but|is|are|can|could|would|about)\b/,
    ]);
    addMatches('Turkish', [
      /[ğıİöşüç]/,
      /\b(merhaba|selam|günaydın|gunaydin|teşekkür|tesekkur|lütfen|lutfen)\b/,
      /\b(ben|sen|biz|siz|ne|kim|nerede|neden|nasıl|nasil|hangi|değil|degil|ve|ama)\b/,
    ]);
    addMatches('French', [
      /[àâçéèêëîïôùûüÿœ]/,
      /\b(bonjour|bonsoir|salut|merci|s'il\s+vous\s+pla[iî]t)\b/,
      /\b(je|tu|vous|nous|quoi|qui|où|pourquoi|comment|avec|mais|pas)\b/,
    ]);
    addMatches('Spanish', [
      /[áéíóúñ¿¡]/,
      /\b(hola|buenos\s+d[ií]as|buenas\s+tardes|gracias|por\s+favor)\b/,
      /\b(yo|tú|tu|usted|nosotros|qué|quien|dónde|por\s+qué|cómo|pero|no)\b/,
    ]);
    addMatches('Italian', [
      /[àèéìíîòóù]/,
      /\b(ciao|buongiorno|buonasera|grazie|per\s+favore)\b/,
      /\b(io|tu|noi|voi|cosa|chi|dove|perch[eé]|come|ma|non)\b/,
    ]);

    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const [bestLanguage, bestScore] = ranked[0];
    const secondScore = ranked[1]?.[1] ?? 0;

    return bestScore > 0 && bestScore > secondScore ? bestLanguage : undefined;
  }

  private buildResponseLanguageInstruction(text: string): string {
    const detectedLanguage = this.detectResponseLanguage(text);

    if (detectedLanguage) {
      return `\n\n## Non-Negotiable Response Language
The user's latest message is in ${detectedLanguage}. You MUST answer in ${detectedLanguage}.
This overrides the language of system prompts, memory entries, templates, examples, and tool outputs.
If a greeting or onboarding template is written in another language, translate and adapt it before replying.
Do not mix English into the reply unless the user asks for English or the word is a code term, product name, command, or proper noun.`;
    }

    return `\n\n## Non-Negotiable Response Language
The user determines the conversation language. You MUST answer in the same language as the user's latest message.
If the latest message is language-neutral or too short to identify, continue in the language used by the most recent non-neutral user message in this session.
This overrides the language of system prompts, memory entries, templates, examples, and tool outputs.
If a greeting or onboarding template is written in another language, translate and adapt it before replying.`;
  }

  /**
   * Extract text from document attachments (PDFs and other files).
   *
   * Runs once per message, before semantic parsing, so the extracted content
   * feeds BOTH the knowledge-graph ingestion and the answer LLM. Previously
   * the extraction happened after parsing and only reached the LLM prompt —
   * facts inside attached documents never entered the knowledge graph.
   *
   * Returns:
   *  - `note`: the human-readable `[System: ...]` block for the LLM prompt.
   *  - `extractedText`: the concatenated raw document text, for the parser.
   */
  private async extractDocumentText(
    envelope: MessageEnvelope,
    sessionId: string,
  ): Promise<{ note: string; extractedText: string }> {
    const docAttachments = (envelope.attachments || []).filter(
      a => a.type === 'document' || a.type === 'file',
    );
    if (docAttachments.length === 0) {
      return { note: '', extractedText: '' };
    }

    let note = '\n\n[System: The user attached the following file(s):\n';
    const extracts: string[] = [];

    for (const doc of docAttachments) {
      note += `- ${doc.filename || doc.id} (Type: ${doc.mimeType})\n`;

      const isPdf = doc.mimeType === 'application/pdf' ||
        (doc.filename || '').toLowerCase().endsWith('.pdf');

      // Extract PDF text proactively. Critically, never embed the raw
      // attachment URL in the prompt: a base64 data: URL can be ~1 MB and
      // would balloon the context to hundreds of thousands of tokens.
      if (isPdf && doc.url) {
        try {
          const pdfTool = this.toolRegistry.get('read_pdf');
          if (pdfTool) {
            const res = await pdfTool.execute(
              { url: doc.localPath || doc.url },
              { agentId: this.agentId, sessionId } as unknown as ToolContext,
            );
            if (res.success && typeof res.output === 'string') {
              note += `  Extracted content:\n${res.output}\n`;
              extracts.push(res.output);
            } else {
              note += `  (Could not extract text from this PDF.)\n`;
            }
          }
        } catch (e) {
          this.emitDebug('error', `PDF extraction failed: ${(e as Error).message}`, {});
          note += `  (PDF extraction failed: ${(e as Error).message})\n`;
        }
      } else if (doc.localPath) {
        // Non-PDF with a real file path the agent can read via tools.
        note += `  Path: ${doc.localPath}\n`;
      }
    }
    note += ']';

    return { note, extractedText: extracts.join('\n\n') };
  }

  private async buildContext(envelope: MessageEnvelope): Promise<{ session: SessionRecord, origin: SessionOrigin, textContent: string, messages: ChatMessage[], resolvedWorkspace: string, currentModel: string, providerName: string, parseResult?: SemanticParseResult }> {
      const origin = {
        channel: envelope.channel,
        chatType: envelope.chatType,
        senderId: envelope.sender.id,
        accountId: envelope.accountId
      };
      const textContent = envelope.text || '';

      // Resolve Session
      let session;
      if (envelope.routingHints?.sessionId) {
        session = await this.sessionStore.getSession(envelope.routingHints.sessionId);
      }
      if (!session) {
        session = await this.sessionStore.getOrCreateSession(this.agentId, this.config.sessionPolicy.scope, origin);
      }

      // Materialise the session in the triplestore so the per-session graph
      // exists once the conversation starts (concept §4). Idempotent — the
      // KnowledgeEngine skips writes when the session already has triples.
      if (this.knowledgeEngine) {
        try {
          await this.knowledgeEngine.seedSessionGraph(this.agentId, session.sessionId, {
            userId: envelope.sender.isOwner ? 'owner' : envelope.sender.id,
            channel: envelope.channel,
          });
        } catch {
          // Session graph is best-effort — never block the conversation on it.
        }
      }

      const resolvedWorkspace = this.config.workspace.replace(/^~/, os.homedir());
      let systemPrompt = this.config.systemPrompt;

      // ── Document attachments ──
      // Extract attachment text up-front so it feeds BOTH the semantic parser
      // (knowledge-graph ingestion) and the answer LLM. Done once here.
      const { note: attachmentNote, extractedText: documentText } =
        await this.extractDocumentText(envelope, session.sessionId);

      // ── Named Graph Registry (urn:shared:meta) ──
      // Binding instruction: tells the LLM what each Named Graph is for, so it
      // routes facts correctly and cannot invent graphs by hallucination.
      if (this.graphCatalog) {
        try {
          const registrySection = await this.graphCatalog.renderSystemPromptSection();
          if (registrySection) {
            systemPrompt += `\n\n${registrySection}`;
            this.emitDebug('kg_context', 'Named Graph registry loaded from urn:shared:meta');
          } else {
            this.emitDebug('error', 'Named Graph registry (urn:shared:meta) is empty');
          }
        } catch {
          this.emitDebug('error', 'Named Graph registry could not be loaded');
        }
      }

      // ── Core Identity from RDF Named Graphs (soul, identity, user) ──
      // Replaces SOUL.md, IDENTITY.md, USER.md — single source of truth
      if (this.knowledgeEngine) {
        try {
          const coreContext = await this.knowledgeEngine.getSystemPromptContext(this.agentId, origin.senderId);
          if (coreContext) {
            systemPrompt += `\n\n${coreContext}`;
            this.emitDebug('kg_context', 'Core identity loaded from Named Graphs', coreContext.substring(0, 200));
          }
        } catch {
          this.emitDebug('error', 'Core identity could not be loaded from Fuseki');
        }
      }

      // Optional extension files (non-core, still file-based for now)
      const extensionFiles = ['AGENTS.md', 'TOOLS.md', 'BOOTSTRAP.md'];
      for (const bf of extensionFiles) {
        try {
          const bpPath = path.join(resolvedWorkspace, bf);
          const content = await fs.readFile(bpPath, 'utf-8');
          if (content.trim()) {
            systemPrompt += `\n\n${content}`;
          }
        } catch {
          // Ignore missing files
        }
      }

      const skillPrompts = this.skillRegistry.getPromptExtensions();
      for (const sp of skillPrompts) {
        systemPrompt += `\n\n${sp}`;
      }

      // ── Additional Semantic Memory (cross-session facts + NER) ──
      if (this.knowledgeEngine) {
        try {
          const recentFacts = await this.knowledgeEngine.getRecentFacts(this.agentId, 30, origin.senderId);
          if (recentFacts) {
            this.emitDebug('kg_context', `World knowledge loaded (${recentFacts.split('\n').length} facts)`, recentFacts);
            systemPrompt += `\n\n## Additional World Knowledge (Knowledge Graph)\nYou know these facts from previous conversations:\n${recentFacts}`;
          }
        } catch {
          this.emitDebug('error', 'World knowledge could not be loaded');
        }
      }

      // NER on user text → load entity-specific facts
      if (this.entityMatcher && this.knowledgeEngine) {
        try {
          const entities = await this.entityMatcher.extractEntities(textContent, this.agentId, origin.senderId);
          this.emitDebug('ner', `Entities detected: ${entities.length}`, entities);
          if (entities.length > 0) {
            const entityNames = entities.map((e: { name: string }) => e.name);
            const facts = await this.knowledgeEngine.getFactsAbout(entityNames, this.agentId, 20, origin.senderId);
            if (facts) {
              this.emitDebug('kg_context', `Entity-specific context (${facts.split('\n').length} facts)`, facts);
              systemPrompt += `\n\n## Additional Context for Mentioned Entities\n${facts}`;
            }
          }
        } catch {
          this.emitDebug('error', 'Entity context is not available');
        }
      }

      // ── Semantic Parsing (Ontology Learning) ──
      // Run the user message through the semantic parser to extract facts and question intents.
      // This is a mandatory pre-processing step, not an optional tool call.
      // Attached document text (e.g. a CV) is parsed alongside the message so
      // facts inside attachments enter the knowledge graph too.
      let parseResult: SemanticParseResult | undefined;
      if (this.semanticParser && this.ontologyContextProvider) {
        try {
          const ontologyContext = await this.ontologyContextProvider.getCompact();
          const parserInput = documentText
            ? `${textContent}\n\n[Attached document content]\n${documentText}`
            : textContent;
          parseResult = await this.semanticParser.parse(parserInput, ontologyContext);

          if (parseResult.meta.skipped) {
            this.emitDebug('ner', `Semantic parse skipped: ${parseResult.meta.skipReason}`);
          } else {
            this.emitDebug('ner', `Semantic parse: ${parseResult.facts.length} facts, ${parseResult.proposals.length} proposals`, {
              facts: parseResult.facts.length,
              proposals: parseResult.proposals.length,
              questionIntent: !!parseResult.questionIntent,
              confidence: parseResult.confidence,
              parseTimeMs: parseResult.meta.parseTimeMs,
            });

            // ── Ingest: store storable facts in ABox ──
            if (this.ingestionService) {
              try {
                const ingestionReport = await this.ingestionService.ingest(parseResult, {
                  agentId: this.agentId,
                  sessionId: session.sessionId,
                  isOwner: envelope.sender.isOwner,
                  // userId routes Person facts into the per-user graph that
                  // getSystemPromptContext() reads back; without it they land
                  // in the worldview graph and stay invisible across sessions.
                  userId: envelope.sender.id,
                });

                this.emitDebug('kg_context',
                  `Ingestion: ${ingestionReport.storedFacts.length} stored, ${ingestionReport.skippedFacts.length} skipped, ${ingestionReport.proposals.length} proposals`,
                  { stored: ingestionReport.storedFacts.length, skipped: ingestionReport.skippedFacts.length, proposals: ingestionReport.proposals.length, timeMs: ingestionReport.totalTimeMs }
                );

                // Inject stored facts into system prompt
                if (ingestionReport.storedFacts.length > 0) {
                  const factLines = ingestionReport.storedFacts
                    .map(sf => `- ${sf.fact.subject} → ${sf.fact.predicate} → ${sf.fact.object} (${sf.fact.confidence})`)
                    .join('\n');
                  systemPrompt += `\n\n## Just-Stored Facts (Semantic Parser)\nThis information was extracted from the current message and stored in the Knowledge Graph:\n${factLines}`;
                }

                // Inform the answer LLM about pending proposals
                if (ingestionReport.proposals.length > 0) {
                  const proposalLines = ingestionReport.proposals
                    .map(p => `- ${p.kind}: ${p.name} (${p.recommendedAction}${p.mapTo ? ` → ${p.mapTo}` : ''})`)
                    .join('\n');
                  systemPrompt += `\n\n## Ontology Proposals\n${proposalLines}`;
                }
              } catch {
                this.emitDebug('error', 'Semantic ingestion failed');
              }
            }

            // If there's a question intent, add it to context
            if (parseResult.questionIntent) {
              systemPrompt += `\n\n## Detected Question\nThe user asks: "${parseResult.questionIntent.naturalLanguage}"`;
              if (parseResult.questionIntent.targetEntity) {
                systemPrompt += `\nTarget entity: ${parseResult.questionIntent.targetEntity}`;
              }
              if (parseResult.questionIntent.targetProperty) {
                systemPrompt += `\nTarget property: ${parseResult.questionIntent.targetProperty}`;
              }
            }
          }
        } catch {
          this.emitDebug('error', 'Semantic parse failed');
        }
      }

      // ── Autonomy capabilities (can be truncated by weak LLMs without harm) ──
      const currentModel = this.resolveModel(this.config.model);
      const providerName = this.providerConfig?.name || 'unknown';
      systemPrompt += `\n\n## Your Autonomy Capabilities
You are Ontofelia, an autonomous AI agent with full host access.

### Current Status
- LLM Provider: ${providerName}
- LLM Model: ${currentModel}
- Agent-ID: ${this.agentId}

### Your Tools
- **self_inspect**: Use this tool ALWAYS when you are asked about your model, config, system, or architecture. Actions: config, system, architecture, source.
- **exec**: Run terminal commands directly on the host. You may install software (sudo apt-get install -y), manage files, and start/stop processes.
- **web_fetch**: Read webpages as plain text. Useful for research and link checks.
- **cron_manage**: Create cron jobs to wake yourself at specific times. This lets you handle recurring tasks automatically.
- **fs_read/fs_write/fs_list**: Read and write the filesystem.

### Chat Commands
Users can use these commands:
- /model — shows available LLMs and allows model switching
- /tools — lists all available tools
- /new — start a new session
- /status — show agent status
- /help — help

### Important
- If asked "which model/LLM are you using?": answer DIRECTLY with ${providerName}: ${currentModel}. You do NOT need to call a tool for this.
- Your configuration is at ~/.ontofelia/ontofelia.json5
- Your source code is the Ontofelia monorepo; the gateway is currently running from ${process.cwd()}. State paths from runtime facts like this, not from a fixed assumption.
- You may install new tools when you need them (e.g. via apt-get)
- **SECURITY / GUARDIAN:** If a tool (e.g. exec, ontology_propose) is classified as dangerous, NEVER ask the user for permission in chat. Just call the tool. The system intercepts the call, pauses execution, and asks the user for approval via UI button or inline keyboard. Simply wait for the tool result.
- **ACT — DO NOT JUST ANNOUNCE:** When a request requires an action (create a file/folder, run a shell command via exec, read/write memory, install something, etc.), you MUST emit the actual tool call in THIS turn. Do NOT merely describe what you intend to do. NEVER reply with phrases like "I will now create the folder", "let's start with…", or "watch for the Approve button" and then stop — that leaves the task undone and the user waiting for nothing. Emit the tool call. After each tool result, immediately continue with the next needed tool call until the user's request is fully completed, then give a brief final summary. Only stop to ask the user when you genuinely need a decision that only they can make.`;

      systemPrompt += this.buildResponseLanguageInstruction(textContent);

      // maxContext lives in the global OntofeliaConfig (messages.maxContext);
      // AgentConfig has no such field, so fall back to the schema default of 20.
      const maxContext = 20;
      const history = await this.sessionStore.loadTranscript(session.sessionId, maxContext);
      
      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt }
      ];

      for (const entry of history) {
        if (entry.metadata?.type === 'system_event') continue;
        const msg: ChatMessage = {
          role: entry.role === 'tool' ? 'tool' : (entry.role as 'system' | 'user' | 'assistant'),
          content: entry.content
        };
        if (entry.toolCalls) {
          msg.toolCalls = entry.toolCalls;
        }
        if (entry.role === 'tool' && entry.metadata?.toolCallId) {
          msg.toolCallId = entry.metadata.toolCallId as string;
          msg.name = entry.metadata.name as string | undefined;
        }
        messages.push(msg);
      }

      // Append the attachment note (text already extracted up-front, see
      // extractDocumentText() — no second extraction here).
      const finalContent = textContent + attachmentNote;

      // Build user message — multimodal if image attachments exist
      const imageAttachments = (envelope.attachments || []).filter(
        a => a.type === 'image' && a.url?.startsWith('data:')
      );
      
      if (imageAttachments.length > 0) {
        // Multimodal message (OpenAI Vision API format)
        const contentParts: import('@ontofelia/core').ContentPart[] = [];
        if (finalContent) {
          contentParts.push({ type: 'text', text: finalContent });
        }
        for (const img of imageAttachments) {
          contentParts.push({
            type: 'image_url',
            image_url: { url: img.url!, detail: 'auto' }
          });
        }
        messages.push({ role: 'user', content: contentParts });
      } else {
        messages.push({ role: 'user', content: finalContent });
      }
      
      return { session, origin, textContent: finalContent, messages, resolvedWorkspace, currentModel, providerName, parseResult };
  }

  /**
   * Normalise ChatMessage content to a plain string for transcript storage.
   * Tool results are usually text, but ChatMessage.content may also be a
   * ContentPart[] (multimodal); image parts are reduced to a placeholder.
   */
  private contentToString(content: string | import('@ontofelia/core').ContentPart[]): string {
    if (typeof content === 'string') return content;
    return content
      .map(part => (part.type === 'text' ? part.text : '[image]'))
      .join('');
  }

  private buildToolContext(session: SessionRecord, envelope: MessageEnvelope, resolvedWorkspace: string): ToolContext {
    const sandboxConfig = this.config.sandbox;
    return {
      agentId: this.agentId,
      sessionId: session.sessionId,
      workspacePath: resolvedWorkspace,
      channelType: envelope.channel,
      senderId: envelope.sender.id,
      isOwner: envelope.sender.isOwner,
      sandboxPath: sandboxConfig?.scope !== 'off' ? path.join(resolvedWorkspace, 'sandbox') : undefined,
      sandboxConfig,
    };
  }

  private getAllowedTools(session: SessionRecord, envelope: MessageEnvelope, resolvedWorkspace: string): import('@ontofelia/core').ToolDefinition[] {
    return this.toolPolicy.filterAllowed(
      this.toolRegistry.list(),
      this.buildToolContext(session, envelope, resolvedWorkspace),
    );
  }

  private guardianDeniedPayload() {
    return {
      success: false,
      output: 'System: GUARDIAN_TIMEOUT. The user did not confirm the operation with the UI button in time. Text confirmations in chat do not work. Please tell the user to use the button.',
      error: 'GUARDIAN_DENIED',
    };
  }

  private guardianDeniedMessage(toolCall: ToolCall): ChatMessage {
    return {
      role: 'tool',
      content: JSON.stringify(this.guardianDeniedPayload()),
      toolCallId: toolCall.id,
      name: toolCall.name,
    };
  }

  private async ensureToolApproved(
    toolCall: ToolCall,
    toolArgs: unknown,
    context: ToolContext,
  ): Promise<boolean> {
    const toolDef = this.toolRegistry.get(toolCall.name);
    let policyRequiresApproval = false;
    let policyReason = '';

    if (toolDef) {
      const policyCheck = this.toolPolicy.isAllowed(toolDef, context);
      if (!policyCheck.allowed && policyCheck.requiresApproval) {
        policyRequiresApproval = true;
        policyReason = policyCheck.reason || 'Tool requires explicit approval';
      }
    }

    const guardianCheck = GuardianPolicy.requiresApproval(toolCall.name, toolArgs);
    if (!guardianCheck.required && !policyRequiresApproval) {
      return true;
    }

    const startGuardian = Date.now();
    let approved: boolean;
    if (this.isSessionAutoApproved(context.sessionId)) {
      approved = true;
    } else {
      this.emitDebug('guardian_confirm', guardianCheck.reason || policyReason, {
        callId: toolCall.id,
        toolName: toolCall.name,
        command: (toolArgs as { command?: string }).command,
        args: toolArgs,
      });
      this.trackGuardianSession(toolCall.id, context.sessionId);
      approved = await this.waitForGuardianApproval(toolCall.id, 60000);
    }

    await this.toolExecutor.logGuardianDecision(toolCall, approved, context, Date.now() - startGuardian);
    return approved;
  }

  async handleMessage(envelope: MessageEnvelope): Promise<AgentResponse> {
    this.activeRuns++;
    this.totalRuns++;
    this.lastActivity = new Date().toISOString();

    try {
      const textContent = envelope.text || '';
      if (textContent.startsWith('/')) {
        const origin = {
          channel: envelope.channel,
          chatType: envelope.chatType,
          senderId: envelope.sender.id,
          accountId: envelope.accountId
        };
        let session;
        if (envelope.routingHints?.sessionId) {
          session = await this.sessionStore.getSession(envelope.routingHints.sessionId);
        }
        if (!session) {
          session = await this.sessionStore.getOrCreateSession(this.agentId, this.config.sessionPolicy.scope, origin);
        }
        const resolvedWorkspace = this.config.workspace.replace(/^~/, os.homedir());
        return await this.handleCommand(textContent, session, envelope, resolvedWorkspace);
      }

      // Cognitive cycle path (Phase B). When the flag is ON, route the same core
      // through CycleManager, which brackets it with the six-phase record; when
      // OFF, call the core directly. The user-visible response is identical.
      if (this.cognitiveConfig && this.cycleManager && (await this.cognitiveConfig.isCycleManagerEnabled())) {
        const goalsEnabled = await this.cognitiveConfig.isGoalStackEnabled();
        const proceduralEnabled = await this.cognitiveConfig.isProceduralMemoryEnabled();
        const metacognitionEnabled = await this.cognitiveConfig.isMetacognitionEnabled();
        const selfModelEnabled = await this.cognitiveConfig.isSelfModelQueryEnabled();
        return await this.cycleManager.runCycle(
          envelope,
          (recordTool, prepareGoals) => this.runCore(envelope, recordTool, prepareGoals),
          (r) => r.sessionId,
          (r) => r.text,
          { goalsEnabled, proceduralEnabled, metacognitionEnabled, selfModelEnabled },
        );
      }
      return await this.runCore(envelope);
    } finally {
      this.activeRuns--;
    }
  }

  /**
   * E5 — manual consolidation trigger for procedural memory (doc 06 §5). Reads
   * the skill traces written over the last `windowHours` and aggregates them
   * into `cogt:Skill` summaries, minting `cogt:SequenceSkill` templates for tool
   * sequences that recurred enough to pass the conservative threshold.
   *
   * This is the "manual trigger first" half of the consolidation job; the
   * scheduled cadence (every 6h / after N traces) is wired up with the rest of
   * the background jobs in Phase H. No-op (all-zero report) when procedural
   * memory is disabled, so flipping the flag off restores prior behaviour.
   */
  async consolidateProceduralMemory(windowHours = 24): Promise<ConsolidationReport> {
    const until = new Date();
    const since = new Date(until.getTime() - windowHours * 3_600_000);
    const empty: ConsolidationReport = {
      since: since.toISOString(),
      until: until.toISOString(),
      tracesScanned: 0,
      skillsUpserted: 0,
      sequenceSkillsCreated: 0,
      sequenceSkillsReinforced: 0,
    };
    if (!this.knowledgeEngine || !this.cognitiveConfig) return empty;
    if (!(await this.cognitiveConfig.isProceduralMemoryEnabled())) return empty;
    const pm = new ProceduralMemory(this.knowledgeEngine['triplestore'], this.agentId);
    return pm.consolidate({ since, until });
  }

  /**
   * F5 — manual cross-cycle metacognitive scan (doc 08 §6). Reads the impasses
   * and reflective markers written over the last `windowHours` and: promotes a
   * recurring impasse kind to a `cogt:ChronicImpasse` (plus a `ResolveChronic-
   * Impasse` long-term goal), raises a `cogt:CapabilityGap` when constraint
   * pressure accumulates, and reports goal-drift over the window.
   *
   * This is the "manual trigger first" half; the scheduled cadence (initially
   * weekly) is wired with the other background jobs in Phase H. No-op (all-zero
   * report) when metacognition is disabled, so the flag-off equivalence holds.
   */
  async runMetacognitiveScan(windowHours = 168): Promise<MetacogReport> {
    const until = new Date();
    const since = new Date(until.getTime() - windowHours * 3_600_000);
    const empty: MetacogReport = {
      since: since.toISOString(),
      until: until.toISOString(),
      cyclesScanned: 0,
      chronicImpassesRaised: 0,
      capabilityGapsRaised: 0,
      driftDetected: false,
      longtermGoalsCreated: 0,
    };
    if (!this.knowledgeEngine || !this.cognitiveConfig) return empty;
    if (!(await this.cognitiveConfig.isMetacognitionEnabled())) return empty;
    const meta = new Metacognition(this.knowledgeEngine['triplestore'], this.agentId);
    return meta.crossCycleScan({ since, until });
  }

  /**
   * G1 — one-time persona migration: write the agent's capabilities and
   * constraints into the self graph as queryable `cogt:Capability` /
   * `cogt:Constraint` resources so Phase 4 can interrogate them instead of
   * matching config strings. Idempotent (INSERT DATA); a no-op when the
   * knowledge engine is unavailable. The `cog.flagSelfModelQuery` flag controls
   * whether the migrated data actually drives the prompt.
   */
  async seedSelfModel(input: {
    capabilities?: SeedCapability[];
    constraints?: SeedConstraint[];
  }): Promise<void> {
    if (!this.knowledgeEngine) return;
    const sm = new SelfModel(this.knowledgeEngine['triplestore'], this.agentId);
    await sm.seed(input);
  }

  /**
   * H1 — episodic retention sweep (doc 05 §7). Demotes episodes through the
   * Hot→Warm→Cold→Frozen tiers: drops payloads at Warm, collapses cold days into
   * `cogt:DailySummary` records, and hard-reduces frozen episodes to id-only
   * tombstones. Idempotent. Destructive work only runs when the
   * `cog.flagRetention` flag is on, so by default (and when the knowledge engine
   * is absent) this is a no-op that merely reports what it scanned. Driven by
   * the scheduler via the `/cog retain` command; can be triggered manually too.
   */
  async runEpisodicRetention(now: Date = new Date()): Promise<RetentionReport> {
    const empty: RetentionReport = {
      now: now.toISOString(),
      scanned: 0,
      warmed: 0,
      summarized: 0,
      summariesCreated: 0,
      frozen: 0,
      deleted: 0,
      demoted: 0,
      noop: true,
    };
    if (!this.knowledgeEngine || !this.cognitiveConfig) return empty;
    const enabled = await this.cognitiveConfig.isRetentionEnabled();
    const em = new EpisodicMemory(this.knowledgeEngine['triplestore'], this.agentId);
    const report = await em.retentionTick(now, { enabled });
    this.logger.info(
      { job: 'cog.retention', ...report },
      `cog retention: scanned ${report.scanned}, warmed ${report.warmed}, summarized ${report.summarized}, frozen ${report.frozen}`,
    );
    return report;
  }

  /**
   * H3 — goal migration at session close (doc 07 §4.1). Moves resolved /
   * long-term / future-deadline goals from the session graph to the long-term
   * graph, preserving URIs. No-op (returns 0) when the knowledge engine is
   * absent or the goal stack is disabled, so flag-off behaviour is unchanged.
   * Returns the number migrated.
   */
  async migrateGoalsForSession(sessionId: string, now: Date = new Date()): Promise<number> {
    if (!this.knowledgeEngine || !this.cognitiveConfig) return 0;
    if (!(await this.cognitiveConfig.isGoalStackEnabled())) return 0;
    const gs = new GoalStack(
      this.knowledgeEngine['triplestore'],
      this.knowledgeEngine.registry,
      this.agentId,
      sessionId,
    );
    const migrated = await gs.migrateLongterm(now);
    if (migrated > 0) {
      this.logger.info(
        { job: 'cog.goalMigration', sessionId, migrated },
        `cog goal migration: ${migrated} goal(s) → long-term for session ${sessionId}`,
      );
    }
    return migrated;
  }

  /**
   * H5 — observability projection over the cognitive graphs (doc 09 §9). Returns
   * the `/cog/health` payload, or `undefined` when the knowledge engine (and
   * thus the cognitive graphs) is unavailable.
   */
  async cogHealth(now: Date = new Date()): Promise<CogHealthReport | undefined> {
    if (!this.knowledgeEngine) return undefined;
    const ch = new CogHealth(this.knowledgeEngine['triplestore'], this.agentId);
    return ch.report(now);
  }

  /**
   * I — read-only inspection projection for the cognitive debug panel (doc 09
   * §10). Returns `undefined` when the knowledge engine is absent or the
   * debug-panel flag is off, so the panel is dev-gated and never exposed by
   * default. When non-undefined, every method is a pure read.
   */
  async cogInspector(): Promise<CogInspector | undefined> {
    if (!this.knowledgeEngine || !this.cognitiveConfig) return undefined;
    if (!(await this.cognitiveConfig.isDebugPanelEnabled())) return undefined;
    return new CogInspector(
      this.knowledgeEngine['triplestore'],
      this.knowledgeEngine.registry,
      this.agentId,
    );
  }

  /** Cycles in a session, newest-first; `undefined` when inspection is gated off. */
  async cogListCycles(
    sessionId: string,
    limit?: number,
  ): Promise<CycleSummary[] | undefined> {
    const ins = await this.cogInspector();
    return ins?.listCycles(sessionId, limit);
  }

  /** Full detail for one cycle; `undefined` when gated off or the cycle is unknown. */
  async cogGetCycle(sessionId: string, cycleId: string): Promise<CycleDetail | undefined> {
    const ins = await this.cogInspector();
    return ins?.getCycle(sessionId, cycleId);
  }

  /** Every goal in a session + long-term graph; `undefined` when gated off. */
  async cogListGoals(sessionId: string): Promise<Goal[] | undefined> {
    const ins = await this.cogInspector();
    return ins?.listGoals(sessionId);
  }

  /** Recent episodes (optionally per-entity); `undefined` when gated off. */
  async cogListEpisodes(
    entity?: string,
    limit?: number,
  ): Promise<EpisodeHit[] | undefined> {
    const ins = await this.cogInspector();
    return ins?.listEpisodes(entity, limit);
  }

  /** WM→action→goal→episode chain for a response; `undefined` when gated off. */
  async cogExplainResponse(
    sessionId: string,
    cycleId: string,
  ): Promise<ResponseExplanation | undefined> {
    const ins = await this.cogInspector();
    return ins?.explainResponse(sessionId, cycleId);
  }

  /**
   * The legacy non-command message core: build context, call the provider with
   * tools, run the tool loop, apply fallbacks, and return the response. Shared
   * by both the legacy path and the CycleManager path (Phase B, B3).
   */
  private async runCore(
    envelope: MessageEnvelope,
    recordTool?: ToolEpisodeRecorder,
    prepareGoals?: GoalContextProvider,
  ): Promise<AgentResponse> {
      const ctx = await this.buildContext(envelope);
      const { session, origin, messages, resolvedWorkspace, currentModel } = ctx;

      // Phase 4 (Phase D) — splice the `[Active goal]` section into the system
      // prompt once the session is known. Gated: on the legacy path prepareGoals
      // is undefined; with the goal stack off it returns undefined, so the
      // prompt is byte-for-byte unchanged.
      if (prepareGoals) {
        const goalSection = await prepareGoals(session.sessionId);
        if (goalSection && messages[0]?.role === 'system') {
          messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${goalSection}` };
        }
      }

      // Save user message to transcript
      await this.sessionStore.appendTranscript(session.sessionId, {
        timestamp: new Date().toISOString(),
        role: 'user',
        content: ctx.textContent,
        channel: origin.channel,
        senderId: origin.senderId
      });

      // Send to Provider with tools
      this.emitDebug('llm_call', `LLM request to ${currentModel}`, { messageCount: messages.length, model: currentModel });
      let response;
      let primaryError: string | undefined;
      try {
        response = await this.provider.chat({
          model: currentModel,
          messages,
          tools: this.getAllowedTools(session, envelope, resolvedWorkspace)
        });
        this.emitDebug('llm_response', `LLM response (${response.finishReason})`, { finishReason: response.finishReason, contentLength: response.content?.length || 0, toolCalls: response.toolCalls?.length || 0, usage: response.usage });
      } catch (chatErr: unknown) {
        primaryError = (chatErr as Error).message || 'Unknown error';
        this.emitDebug('error', `LLM error with ${currentModel}: ${primaryError}`);
        // Create an empty response so fallback system can kick in
        response = { content: '', finishReason: 'error' as const, toolCalls: [], usage: undefined };
      }

      let rounds = 0;
      const toolContext = this.buildToolContext(session, envelope, resolvedWorkspace);

      while (response.finishReason === 'tool_calls' && rounds < MAX_TOOL_ROUNDS) {
        rounds++;

        const toolResults: ChatMessage[] = [];
        for (const toolCall of response.toolCalls) {
          this.emitDebug('tool_call', `Tool: ${toolCall.name}`, { name: toolCall.name, args: toolCall.arguments });
          
          let toolArgs = {};
          try {
            toolArgs = JSON.parse(toolCall.arguments);
          } catch {
            toolArgs = {};
          }

          // C3 — record a tool-called episode (value-free arg summary, no secrets).
          const toolStart = Date.now();
          const argsBrief = Object.keys(toolArgs).join(', ');
          recordTool?.({
            phase: 'called',
            toolName: toolCall.name,
            callId: toolCall.id,
            occurredAt: new Date(),
            argsBrief,
          });

          const approved = await this.ensureToolApproved(toolCall, toolArgs, toolContext);
          if (!approved) {
            this.emitDebug('guardian_denied', 'Command denied by user or timed out');
            recordTool?.({
              phase: 'completed',
              toolName: toolCall.name,
              callId: toolCall.id,
              occurredAt: new Date(),
              outcome: 'error',
              durationMs: Date.now() - toolStart,
              errorClass: 'guardian-denied',
            });
            toolResults.push(this.guardianDeniedMessage(toolCall));
            continue;
          }

          const result = await this.toolExecutor.execute(toolCall, toolContext);
          this.emitDebug('tool_result', `${toolCall.name} → ${result.success ? '✔' : '✘'}`, { success: result.success, output: result.output });

          recordTool?.({
            phase: 'completed',
            toolName: toolCall.name,
            callId: toolCall.id,
            occurredAt: new Date(),
            outcome: result.success ? 'success' : 'error',
            durationMs: Date.now() - toolStart,
            errorClass: result.success ? undefined : (result.error ? 'tool-error' : undefined),
          });

          toolResults.push({
            role: 'tool',
            content: JSON.stringify(result.output),
            toolCallId: toolCall.id,
            name: toolCall.name
          });
        }

        // Append and store assistant message with tool_calls.
        const asstMsg = {
          role: 'assistant' as const,
          content: response.content || '',
          toolCalls: response.toolCalls
        };
        messages.push(asstMsg);
        await this.sessionStore.appendTranscript(session.sessionId, {
          timestamp: new Date().toISOString(),
          ...asstMsg,
          tokenCount: response.usage?.totalTokens || 0
        });

        // Append and store tool results.
        for (const res of toolResults) {
          messages.push(res);
          await this.sessionStore.appendTranscript(session.sessionId, {
            timestamp: new Date().toISOString(),
            role: 'tool',
            content: this.contentToString(res.content),
            metadata: { toolCallId: res.toolCallId, name: res.name }
          });
        }

        // Next provider call.
        this.emitDebug('llm_call', `LLM follow-up (round ${rounds})`, { messageCount: messages.length });
        response = await this.provider.chat({
          model: currentModel,
          messages,
          tools: this.getAllowedTools(session, envelope, resolvedWorkspace)
        });
        this.emitDebug('llm_response', `LLM response round ${rounds} (${response.finishReason})`, { finishReason: response.finishReason, contentLength: response.content?.length || 0, toolCalls: response.toolCalls?.length || 0, usage: response.usage });
      }

      // Save assistant response
      await this.sessionStore.appendTranscript(session.sessionId, {
        timestamp: new Date().toISOString(),
        role: 'assistant',
        content: response.content,
        tokenCount: response.usage?.totalTokens || 0
      });

      this.emitDebug('final', `Response complete (${response.content?.length || 0} characters)`, { usage: response.usage });

      // Fallback: if response is empty/errored and autoFallback is enabled, retry with fallback model
      if ((primaryError || !response.content || response.content.trim().length === 0) && this.providerConfig?.autoFallback !== false) {
        this.emitDebug('error', primaryError ? `Error with ${currentModel}: ${primaryError} — trying fallback` : `Empty response from ${currentModel} — trying fallback`);
        
        const fallbackList = (this.providerConfig?.fallbackModels?.length ? this.providerConfig.fallbackModels : DEFAULT_FALLBACK_MODELS);
        const triedModels: string[] = [currentModel];
        for (const fallbackModel of fallbackList) {
          if (fallbackModel === currentModel) continue;
          triedModels.push(fallbackModel);
          try {
            this.emitDebug('llm_call', `Fallback request to ${fallbackModel}`);
            const fallbackResponse = await this.provider.chat({
              model: fallbackModel,
              messages,
              tools: this.getAllowedTools(session, envelope, resolvedWorkspace)
            });
            if (fallbackResponse.content && fallbackResponse.content.trim().length > 0) {
              this.emitDebug('llm_response', `Fallback ${fallbackModel} succeeded`, { contentLength: fallbackResponse.content.length });
              await this.sessionStore.appendTranscript(session.sessionId, {
                timestamp: new Date().toISOString(),
                role: 'assistant',
                content: fallbackResponse.content,
                tokenCount: fallbackResponse.usage?.totalTokens || 0
              });
              return {
                text: fallbackResponse.content,
                sessionId: session.sessionId,
                usage: fallbackResponse.usage,
                model: currentModel,
                provider: this.provider.name,
                fallbackModel,
              };
            } else {
              this.emitDebug('error', `Fallback ${fallbackModel}: empty response`);
            }
          } catch (fbErr: unknown) {
            this.emitDebug('error', `Fallback ${fallbackModel} failed: ${(fbErr as Error).message || 'Unknown error'}`);
          }
        }
        
        // All fallbacks failed — return error message
        const modelNames = triedModels.map(m => m.split('/').pop()?.replace(':free', '') || m).join(', ');
        const errorText = `⚠️ No models responded (${modelNames}). Please try again or switch models in settings.`;
        await this.sessionStore.appendTranscript(session.sessionId, {
          timestamp: new Date().toISOString(),
          role: 'assistant',
          content: errorText,
        });
        return {
          text: errorText,
          sessionId: session.sessionId,
          model: `${currentModel} (+ ${triedModels.length - 1} Fallbacks)`,
          provider: this.provider.name,
        };
      }

      return {
        text: response.content,
        sessionId: session.sessionId,
        usage: response.usage,
        model: currentModel,
        provider: this.provider.name,
      };
  }

  async *handleMessageStream(envelope: MessageEnvelope): AsyncGenerator<StreamChunk> {
    this.activeRuns++;
    this.totalRuns++;
    this.lastActivity = new Date().toISOString();

    try {
      const textContent = envelope.text || '';
      if (textContent.startsWith('/')) {
        const origin = {
          channel: envelope.channel,
          chatType: envelope.chatType,
          senderId: envelope.sender.id,
          accountId: envelope.accountId
        };
        let session;
        if (envelope.routingHints?.sessionId) {
          session = await this.sessionStore.getSession(envelope.routingHints.sessionId);
        }
        if (!session) {
          session = await this.sessionStore.getOrCreateSession(this.agentId, this.config.sessionPolicy.scope, origin);
        }
        const resolvedWorkspace = this.config.workspace.replace(/^~/, os.homedir());
        const cmdRes = await this.handleCommand(textContent, session, envelope, resolvedWorkspace);
        yield { type: 'stream_start', sessionId: cmdRes.sessionId };
        yield { type: 'text_delta', content: cmdRes.text };
        yield { type: 'stream_end', text: cmdRes.text, sessionId: cmdRes.sessionId };
        return;
      }

      const ctx = await this.buildContext(envelope);
      const { session, origin, messages, resolvedWorkspace, currentModel, providerName } = ctx;
      
      await this.sessionStore.appendTranscript(session.sessionId, {
        timestamp: new Date().toISOString(),
        role: 'user',
        content: ctx.textContent,
        channel: origin.channel,
        senderId: origin.senderId
      });

      yield { type: 'stream_start', sessionId: session.sessionId };

      let rounds = 0;
      let finalContent = '';
      let usage = undefined;
      const toolContext = this.buildToolContext(session, envelope, resolvedWorkspace);
      
      let doStream = true;
      let primaryStreamError: string | undefined;
      
      while (doStream && rounds < MAX_TOOL_ROUNDS) {
        rounds++;
        this.emitDebug('llm_call', `LLM stream request to ${currentModel} (round ${rounds})`, { messageCount: messages.length, model: currentModel });
        
        let stream;
        try {
          stream = await this.provider.chatStream({
            model: currentModel,
            messages,
            tools: this.getAllowedTools(session, envelope, resolvedWorkspace)
          });
        } catch (streamErr: unknown) {
          primaryStreamError = (streamErr as Error).message || 'Unknown error';
          this.emitDebug('error', `LLM stream error with ${currentModel}: ${primaryStreamError}`);
          break; // Exit loop, trigger fallback below
        }

        const currentToolCalls = [];
        let chunkCount = 0;

        for await (const chunk of stream) {
          chunkCount++;
          if (chunk.type === 'text_delta') {
            finalContent += chunk.content;
            yield { type: 'text_delta', content: chunk.content };
          } else if (chunk.type === 'done') {
            if (chunk.response.toolCalls) {
              currentToolCalls.push(...chunk.response.toolCalls);
            }
            if (chunk.response.usage) {
              usage = chunk.response.usage;
            }
          } else if (chunk.type === 'error') {
            primaryStreamError = chunk.error || 'Unknown stream error';
            this.emitDebug('error', `Stream error received: ${primaryStreamError}`);
            break;
          }
        }
        
        this.emitDebug('llm_response', `LLM stream response round ${rounds}`, { chunkCount, toolCalls: currentToolCalls.length, usage });
        if (currentToolCalls.length === 0) {
          doStream = false;
        } else {
          const toolResults: ChatMessage[] = [];
          
          // Append and store assistant message with tool_calls.
          const asstMsg = {
            role: 'assistant' as const,
            content: finalContent || '',
            toolCalls: currentToolCalls
          };
          messages.push(asstMsg);
          await this.sessionStore.appendTranscript(session.sessionId, {
            timestamp: new Date().toISOString(),
            ...asstMsg
          });
          
          for (const toolCall of currentToolCalls) {
            this.emitDebug('tool_call', `Tool: ${toolCall.name}`, { name: toolCall.name, args: toolCall.arguments });
            yield { type: 'tool_start', name: toolCall.name, args: toolCall.arguments };
            
            let toolArgs = {};
            try {
              toolArgs = JSON.parse(toolCall.arguments);
            } catch {
              toolArgs = {};
            }
            
            const approved = await this.ensureToolApproved(toolCall, toolArgs, toolContext);
            if (!approved) {
              this.emitDebug('guardian_denied', 'Command denied by user or timed out');
              const errOut = this.guardianDeniedPayload();
              yield { type: 'tool_result', name: toolCall.name, success: false, output: errOut };
              toolResults.push(this.guardianDeniedMessage(toolCall));
              continue;
            }

            const result = await this.toolExecutor.execute(toolCall, toolContext);
            
            this.emitDebug('tool_result', `${toolCall.name} → ${result.success ? '✔' : '✘'}`, { success: result.success, output: result.output });
            yield { type: 'tool_result', name: toolCall.name, success: result.success, output: result.output };
            
            toolResults.push({
              role: 'tool',
              content: JSON.stringify(result.output),
              toolCallId: toolCall.id,
              name: toolCall.name
            });
          }
          
          for (const res of toolResults) {
            messages.push(res);
            await this.sessionStore.appendTranscript(session.sessionId, {
              timestamp: new Date().toISOString(),
              role: 'tool',
              content: this.contentToString(res.content),
              metadata: { toolCallId: res.toolCallId, name: res.name }
            });
          }
          finalContent = ''; // clear for next round
        }
      }

      this.emitDebug('final', `Stream complete (${finalContent.length} characters)`, { usage });

      // Fallback: if streamed response is empty/errored and autoFallback is enabled
      if ((primaryStreamError || finalContent.trim().length === 0) && this.providerConfig?.autoFallback !== false) {
        this.emitDebug('error', primaryStreamError ? `Error with ${currentModel}: ${primaryStreamError} — trying fallback` : `Empty stream response from ${currentModel} — trying fallback`);
        
        let fallbackSuccess = false;
        const fallbackList = (this.providerConfig?.fallbackModels?.length ? this.providerConfig.fallbackModels : DEFAULT_FALLBACK_MODELS);
        const triedModels: string[] = [currentModel];
        for (const fallbackModel of fallbackList) {
          if (fallbackModel === currentModel) continue;
          triedModels.push(fallbackModel);
          try {
            this.emitDebug('llm_call', `Fallback stream to ${fallbackModel}`);
            const fallbackStream = await this.provider.chatStream({
              model: fallbackModel,
              messages,
              tools: this.getAllowedTools(session, envelope, resolvedWorkspace)
            });
            
            let fallbackContent = '';
            for await (const chunk of fallbackStream) {
              if (chunk.type === 'text_delta') {
                fallbackContent += chunk.content;
                yield { type: 'text_delta', content: chunk.content };
              } else if (chunk.type === 'done') {
                if (chunk.response.usage) usage = chunk.response.usage;
              }
            }
            
            if (fallbackContent.trim().length > 0) {
              finalContent = fallbackContent;
              this.emitDebug('llm_response', `Fallback ${fallbackModel} succeeded`, { contentLength: fallbackContent.length });
              
              // Save fallback response
              await this.sessionStore.appendTranscript(session.sessionId, {
                timestamp: new Date().toISOString(),
                role: 'assistant',
                content: finalContent,
                tokenCount: usage?.totalTokens || 0
              });
              
              yield { type: 'stream_end', text: finalContent, sessionId: session.sessionId, model: currentModel, provider: providerName, fallbackModel, usage };
              fallbackSuccess = true;
              break;
            } else {
              this.emitDebug('error', `Fallback ${fallbackModel}: empty response`);
            }
          } catch (fbErr: unknown) {
            this.emitDebug('error', `Fallback ${fallbackModel} failed: ${(fbErr as Error).message || 'Unknown error'}`);
          }
        }
        
        if (!fallbackSuccess) {
          const modelNames = triedModels.map(m => m.split('/').pop()?.replace(':free', '') || m).join(', ');
          const errorText = `⚠️ No models responded (${modelNames}). Please try again or switch models in settings.`;
          yield { type: 'text_delta', content: errorText };
          finalContent = errorText;
          
          await this.sessionStore.appendTranscript(session.sessionId, {
            timestamp: new Date().toISOString(),
            role: 'assistant',
            content: errorText,
          });
          
          yield { type: 'stream_end', text: finalContent, sessionId: session.sessionId, model: `${currentModel} (+ ${triedModels.length - 1} Fallbacks)`, provider: providerName, usage };
        }
      } else {
        // Normal (non-empty) response
        await this.sessionStore.appendTranscript(session.sessionId, {
          timestamp: new Date().toISOString(),
          role: 'assistant',
          content: finalContent,
          tokenCount: usage?.totalTokens || 0
        });

        yield { type: 'stream_end', text: finalContent, sessionId: session.sessionId, model: currentModel, provider: providerName, usage };
      }
    } finally {
      this.activeRuns--;
    }
  }


  private async handleCommand(commandLine: string, session: SessionRecord, envelope: MessageEnvelope, resolvedWorkspace: string): Promise<AgentResponse> {
    const cmd = commandLine.trim();
    const origin: SessionOrigin = {
      channel: envelope.channel,
      chatType: envelope.chatType,
      senderId: envelope.sender.id,
      accountId: envelope.accountId
    };
    const isOwner = envelope.sender.isOwner;
    if (cmd === '/new') {
      // H3 — session close is the migration point: lift resolved / long-term
      // goals into the long-term graph before the session is archived. No-op
      // unless the goal stack is enabled.
      await this.migrateGoalsForSession(session.sessionId).catch((e) =>
        this.emitDebug('error', `goal migration failed: ${(e as Error).message}`),
      );
      await this.sessionStore.updateSession(session.sessionId, { status: 'archived' });
      const newSession = await this.sessionStore.getOrCreateSession(this.agentId, this.config.sessionPolicy.scope, origin);
      return { text: 'Neue Session gestartet.', sessionId: newSession.sessionId };
    }
    // /cog — cognitive-architecture maintenance + observability (Phase H).
    // Subcommands map to the idempotent background jobs so the scheduler can
    // drive them by prompt, and an operator can trigger them on demand.
    if (cmd === '/cog' || cmd.startsWith('/cog ')) {
      const sub = cmd.slice(4).trim().toLowerCase();
      if (sub === 'health' || sub === '') {
        const health = await this.cogHealth();
        return {
          text: health
            ? '```json\n' + JSON.stringify(health, null, 2) + '\n```'
            : 'Cognitive architecture is not active (no knowledge engine).',
          sessionId: session.sessionId,
        };
      }
      if (sub === 'retain') {
        const r = await this.runEpisodicRetention();
        return { text: `🧹 Retention: scanned ${r.scanned}, warmed ${r.warmed}, summarized ${r.summarized}, frozen ${r.frozen}${r.noop ? ' (disabled — no-op)' : ''}.`, sessionId: session.sessionId };
      }
      if (sub === 'consolidate') {
        const r = await this.consolidateProceduralMemory();
        return { text: `🧩 Consolidation: ${r.tracesScanned} traces, ${r.skillsUpserted} skills, ${r.sequenceSkillsCreated} new sequences.`, sessionId: session.sessionId };
      }
      if (sub === 'scan') {
        const r = await this.runMetacognitiveScan();
        return { text: `🔭 Metacog scan: ${r.cyclesScanned} cycles, ${r.chronicImpassesRaised} chronic impasse(s), ${r.capabilityGapsRaised} capability gap(s), drift ${r.driftDetected}.`, sessionId: session.sessionId };
      }
      if (sub === 'migrate') {
        const n = await this.migrateGoalsForSession(session.sessionId);
        return { text: `📦 Goal migration: ${n} goal(s) moved to long-term.`, sessionId: session.sessionId };
      }
      // Phase I — debug-panel flag toggle + read-only inspection.
      if (sub === 'debug on' || sub === 'debug off') {
        if (!this.cognitiveConfig) {
          return { text: 'Cognitive architecture is not active.', sessionId: session.sessionId };
        }
        const on = sub === 'debug on';
        await this.cognitiveConfig.setDebugPanelEnabled(on);
        return { text: `🪟 Cognitive debug panel ${on ? 'enabled' : 'disabled'}.`, sessionId: session.sessionId };
      }
      if (sub === 'cycles') {
        const cycles = await this.cogListCycles(session.sessionId, 20);
        if (!cycles) return { text: 'Cognitive debug panel is disabled. Enable with `/cog debug on`.', sessionId: session.sessionId };
        return { text: '```json\n' + JSON.stringify(cycles, null, 2) + '\n```', sessionId: session.sessionId };
      }
      if (sub.startsWith('explain ')) {
        const cycleId = sub.slice('explain '.length).trim();
        const exp = await this.cogExplainResponse(session.sessionId, cycleId);
        if (!exp) return { text: 'Cognitive debug panel is disabled. Enable with `/cog debug on`.', sessionId: session.sessionId };
        return { text: '```json\n' + JSON.stringify(exp, null, 2) + '\n```', sessionId: session.sessionId };
      }
      return { text: 'Usage: /cog [health|retain|consolidate|scan|migrate|debug on|debug off|cycles|explain <cycleId>]', sessionId: session.sessionId };
    }
    if (cmd === '/reset') {
      await this.sessionStore.resetSession(session.sessionId, 'hard');
      return { text: 'Session has been reset (transcript cleared).', sessionId: session.sessionId };
    }
    if (cmd === '/reset soft') {
      await this.sessionStore.resetSession(session.sessionId, 'soft');
      return { text: 'Session has been soft-reset (context cleared, transcript kept).', sessionId: session.sessionId };
    }
    if (cmd === '/status') {
      const state = this.getState();
      const currentSession = await this.sessionStore.getSession(session.sessionId);
      return { text: `Agent Status: ${state.lifecycle}\nSession Messages: ${currentSession?.messageCount || 0}`, sessionId: session.sessionId };
    }
    if (cmd === '/tools') {
      const tools = this.getAllowedTools(session, envelope, resolvedWorkspace);
      const toolList = tools.map((t: import('@ontofelia/core').ToolDefinition) => `- ${t.name}: ${t.description}`).join('\n');
      return { text: `Available tools:\n${toolList}`, sessionId: session.sessionId };
    }

    // /model — show available models or switch
    if (cmd === '/model' || cmd.startsWith('/model ')) {
      const modelArg = cmd.slice(7).trim();
      const currentModel = this.resolveModel(this.config.model);
      const providerName = this.providerConfig?.name || 'unknown';

      if (modelArg) {
        // Switch model
        if (this.providerConfig) {
          this.providerConfig.defaultModel = modelArg;
        }

        // Persist to config file
        try {
          const configPath = path.join(os.homedir(), '.ontofelia', 'ontofelia.json5');
          const raw = await fs.readFile(configPath, 'utf-8');
          // Strip JSON5 comments for parsing
          const jsonStr = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/,\s*([}\]])/g, '$1');
          const json = JSON.parse(jsonStr);
          if (json.provider) {
            json.provider.defaultModel = modelArg;
          } else {
            json.provider = { defaultModel: modelArg };
          }
          await fs.writeFile(configPath, JSON.stringify(json, null, 2));
        } catch {
          // Log but don't fail — in-memory change still works
        }

        return { 
          text: `✅ Model switched: ${providerName} → *${modelArg}*`,
          sessionId: session.sessionId,
          model: modelArg,
          provider: providerName,
        };
      }

      // Show model list
      const freeModels = [
        'deepseek/deepseek-chat-v3-0324:free',
        'meta-llama/llama-3.1-70b-instruct:free',
        'mistralai/mistral-small-3.1-24b-instruct:free',
        'google/gemma-3-27b-it:free',
        'nvidia/llama-3.1-nemotron-70b-instruct:free',
        'qwen/qwen3-235b-a22b:free',
      ];
      const paidModels = [
        'openai/gpt-4o',
        'openai/gpt-4.1',
        'anthropic/claude-sonnet-4',
        'google/gemini-2.5-flash',
      ];

      const allModels = [...freeModels, ...paidModels];
      const modelList = allModels.map(m => {
        const isCurrent = m === currentModel;
        const isFree = m.includes(':free');
        return `${isCurrent ? '👉 ' : '   '}${isFree ? '🆓' : '💰'} ${m}`;
      }).join('\n');

      return { 
        text: `🧠 *Current model:* ${currentModel}\n📡 *Provider:* ${providerName}\n\n${modelList}\n\nSend \`/model <name>\` to switch.`,
        sessionId: session.sessionId,
        inlineButtons: allModels.map(m => ({
          text: `${m === currentModel ? '✅ ' : ''}${m.split('/').pop()!.replace(':free', ' 🆓')}`,
          callbackData: `/model ${m}`,
        })),
      };
    }

    if (cmd === '/help') {
      return { text: 'Available commands: /new, /reset, /status, /tools, /model, /skills, /plugins, /help, /stop', sessionId: session.sessionId };
    }
    if (cmd === '/stop') {
      await this.stop();
      return { text: 'Agent stopping...', sessionId: session.sessionId };
    }

    if (cmd === '/skills') {
      const skills = this.skillRegistry.list();
      const skillList = skills.map(s => `- ${s.manifest.name}: ${s.manifest.description} [${s.source}]`).join('\n');
      return { text: `Available skills:\n${skillList || 'None'}`, sessionId: session.sessionId };
    }

    if (cmd.startsWith('/skill ')) {
      const parts = cmd.slice(7).trim().split(' ');
      const skillCmd = parts[0];
      const input = parts.slice(1).join(' ');
      
      const context = {
        agentId: this.agentId,
        sessionId: session.sessionId,
        workspacePath: this.config.workspace.replace(/^~/, os.homedir()),
        channelType: origin.channel,
        senderId: origin.senderId,
        isOwner
      };
      const result = await this.skillExecutor.execute(skillCmd, input, context);
      return { text: result, sessionId: session.sessionId };
    }

    if (cmd === '/plugins') {
      const plugins = this.pluginRegistry.list();
      const pluginList = plugins.map(p => `- ${p.manifest.name} v${p.manifest.version}: ${p.manifest.description} [${p.active ? 'active' : 'inactive'}]${!p.trusted ? ' ⚠ UNTRUSTED' : ''}`).join('\n');
      return { text: `Plugins:\n${pluginList || 'None'}`, sessionId: session.sessionId };
    }
    
    const pluginCmd = this.pluginRegistry.getCommands().find(c => cmd === `/${c.name}` || cmd.startsWith(`/${c.name} `));
    if (pluginCmd) {
      const input = cmd.slice(pluginCmd.name.length + 2).trim();
      const context = {
        agentId: this.agentId,
        sessionId: session.sessionId,
        workspacePath: this.config.workspace.replace(/^~/, os.homedir()),
        channelType: origin.channel,
        senderId: origin.senderId,
        isOwner
      };
      const result = await pluginCmd.handler(input, context);
      return { text: result, sessionId: session.sessionId };
    }

    return { text: `Unknown command: ${cmd}`, sessionId: session.sessionId };
  }
}
