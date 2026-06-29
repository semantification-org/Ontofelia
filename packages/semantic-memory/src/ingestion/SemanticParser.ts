/**
 * SemanticParser — Translates user messages into structured semantic facts
 * using an LLM with strict JSON output.
 *
 * This is a mandatory pre-processing step in the AgentRuntime, NOT an optional
 * tool call. Every non-trivial user message runs through this parser before
 * the answer-LLM sees it.
 *
 * The parser has exactly ONE job: extract facts and question intents.
 * It does NOT generate SPARQL (that's the SparqlBuilder's job).
 */

import { ProviderAdapter } from '@ontofelia/core';
import { TrivialMessageDetector } from './TrivialMessageDetector.js';
import type {
  SemanticParseResult,
  ParserLLMOutput,
  ParsedFact,
  ParsedOntologyProposal,
  QuestionIntent,
  ConfidenceLevel,
} from './types.js';

export interface OntologyContext {
  classes: string[];
  properties: Array<{
    name: string;
    label: string;
    domain: string;
    range: string;
    aliases: string[];
  }>;
}

export interface SemanticParserConfig {
  /** The LLM model to use for parsing (should be fast/cheap, e.g. a small model) */
  model: string;
  /** Maximum tokens for the parser response */
  maxTokens?: number;
  /** Temperature for the parser (low = more deterministic) */
  temperature?: number;
}

const DEFAULT_CONFIG: SemanticParserConfig = {
  model: 'google/gemma-3-27b-it:free',
  maxTokens: 2048,
  temperature: 0.1,
};

/**
 * Build the system prompt for the semantic parser LLM.
 */
function buildParserSystemPrompt(ontologyContext: OntologyContext): string {
  const classesStr = ontologyContext.classes.join(', ');
  const propsStr = ontologyContext.properties
    .map(p => `- ${p.name} (${p.label}): ${p.domain} → ${p.range}${p.aliases.length > 0 ? ` [aliases: ${p.aliases.join(', ')}]` : ''}`)
    .join('\n');

  return `You are a semantic parser. Your only task is to translate user input into structured semantic statements.

## Rules

1. Translate the input into structured facts (subject-predicate-object triples).
2. Prefer existing classes and properties.
3. Do not invent a new ontology if existing terms are sufficient.
4. If an extension seems necessary, return only a proposal.
5. If the message contains a question, return a questionIntent (NO SPARQL!).
6. Do not store questions as facts — mark them as kind: "question".
7. Mark uncertain statements as kind: "uncertain".
8. Mark reliable facts as kind: "fact".
9. For each fact, provide the sourceSpan — the original text excerpt the fact was extracted from.

## Subject resolution (CRITICAL — read carefully)

10. FIRST PERSON → the USER. "I", "me", "my", and German "ich", "mir", "mich",
    "mein/meine/meinen" → subject: "User" (subjectType: "Person") — when the
    predicate is about the speaker themselves (e.g. "I live in Berlin",
    "Ich heiße Gökhan" → (User, name, "Gökhan")).
11. SECOND PERSON → the AGENT. "you", "your", "Ontofelia", and German "du",
    "dir", "dich", "dein/deine/deinen" → subject: "Ontofelia"
    (subjectType: "Agent") — when the statement is ABOUT the assistant. This
    holds for DESCRIPTIVE statements too, not only requests:
      - "Du bist Ontofelia" / "You are Ontofelia" → (Ontofelia, name, "Ontofelia")
      - "Du sagst die ganze Zeit du" / "You keep saying you" →
        (Ontofelia, <behavior-predicate>, "…") — a statement ABOUT the agent,
        NEVER about the user.
    Do NOT turn a statement about the agent into a fact about the user.
12. SECOND-PERSON POSSESSIVE — two cases, mirroring the first-person rule:
    a) When "your X" / "dein/deine X" names an ATTRIBUTE OF THE AGENT ITSELF
       (its name, behavior, capability, mood — "dein Name", "dein Verhalten",
       "deine Aufgabe"), the subject is Ontofelia (subjectType: "Agent").
    b) When "your X" / "dein/deine X" introduces a SEPARATE third entity that
       merely belongs to / relates to the agent (e.g. "deine Schwester Anna",
       "dein Auto"), do NOT make Ontofelia the subject of facts about X.
       Emit the relationship (Ontofelia, hasSister, Anna) and let X be the
       subject of any fact ABOUT X — (Anna, …), NOT (Ontofelia, …).
    The dative/accusative pronouns "dir"/"dich" are NOT possessives; treat them
    only as a signal that the statement is addressed TO the agent, not as a rule
    to pin a third entity onto Ontofelia.
    Conversely a FIRST-person possessive ("my X", "mein/meine X") introduces a
    NEW entity X that belongs to the user (same a/b split — see rule 13).
    **NEVER collapse third-party people, animals, places, or things onto "User"
    or onto "Ontofelia".** "X" becomes the subject of any fact about X.
13. **Multi-clause sentences must yield ONE fact per clause, each with the
    correct subject.** A single sentence like "Meine Schwester Anna ist Ärztin
    und wohnt in Hamburg" yields THREE facts:
      a) (User, hasSister, Anna)               — the relationship to the user
      b) (Anna,  hasProfession, "Ärztin")      — Anna IS the subject here
      c) (Anna,  livesIn, Hamburg)             — Anna IS the subject here
    DO NOT emit (User, hasProfession, "Ärztin") or (User, livesIn, Hamburg) —
    those would be wrong; the user is not the doctor and does not live in Hamburg.
14. **Animals (cats, dogs, …) use subjectType: "Animal"**, not "Person".
    "Meine Katze Felix ist 4 Jahre alt" → two facts:
      a) (User, hasPet, Felix)            — relationship to user
      b) (Felix, hasAge, "4 years")       — Felix is the subject; subjectType: "Animal"
15. **Negations**: "Anna wohnt NICHT in Hamburg" is NOT a fact that Anna lives
    in Hamburg. Either skip the negative claim or model it explicitly as a
    "doesNotLiveIn"-style predicate. Never emit the positive form of a
    negated statement.
16. **Corrections** like "Korrektur: …, sondern …" or "eigentlich wohnt sie
    in Köln" supersede the earlier positive fact. Emit ONLY the new positive
    fact (Anna livesIn Köln) — do NOT also re-emit the negated old object.

## Attached documents

The input may contain a section marked "[Attached document content]" — text
extracted from a file the user attached (e.g. a CV, a report, a profile).
Treat this document as a rich, reliable source of facts about the user:

- Extract EVERY discrete fact you can find: name, location, profession,
  employer, education, skills, projects, roles, dates.
- A CV is high-confidence first-party information: use kind: "fact" with
  confidence: "high" unless the text itself is vague.
- Emit one fact per atomic statement — do not bundle several attributes into
  one triple. "Senior Architect at Company A" → two facts (a role fact and an
  employer fact), not one.
- For each fact, set sourceSpan to the exact excerpt from the document.
- Do not skip a document because it is long. A CV typically yields 10-30
  facts; return all of them.

## Known Ontology

Classes: ${classesStr}

Properties:
${propsStr || '(no properties defined yet)'}

## Output Format

Respond exclusively as JSON in the following schema:

\`\`\`json
{
  "facts": [
    {
      "subject": "string",
      "subjectType": "Person | Organization | Place | Concept | Event | Animal | Agent",
      "predicate": "string",
      "object": "string",
      "objectType": "Person | Organization | Place | Concept | Event | Animal | Agent | literal",
      "confidence": "high | medium | low",
      "sourceSpan": "string",
      "kind": "fact | question | uncertain"
    }
  ],
  "proposals": [
    {
      "kind": "class | property",
      "name": "string",
      "domain": "string (optional)",
      "range": "string (optional)",
      "reason": "string",
      "similarExistingTerms": ["string"],
      "recommendedAction": "create | map_to_existing | ignore",
      "mapTo": "string (optional)"
    }
  ],
  "questionIntent": {
    "naturalLanguage": "string",
    "targetEntity": "string (optional)",
    "targetProperty": "string (optional)",
    "expectedAnswerType": "string (optional)"
  },
  "confidence": "high | medium | low"
}
\`\`\`

If no facts, no question, and no proposals are detected, return empty arrays and null:
\`\`\`json
{"facts": [], "proposals": [], "questionIntent": null, "confidence": "high"}
\`\`\`

Respond ONLY with JSON. No Markdown, no explanations.`;
}

export class SemanticParser {
  private trivialDetector = new TrivialMessageDetector();
  private config: SemanticParserConfig;

  /** Placeholder values that are not real entities. */
  private static readonly JUNK_VALUES = new Set([
    'unknown', 'n/a', 'na', 'none', 'null', 'undefined',
    'tbd', 'not specified', '-', '?', 'something',
  ]);

  /**
   * Predicate fragments that describe the conversation itself rather than
   * durable knowledge. Facts using these are chat metadata, not knowledge.
   */
  private static readonly META_PREDICATE_FRAGMENTS = [
    'requests', 'attached', 'attachment', 'extract', 'upload', 'document',
    'asks', 'wants help', 'mentions', 'expressesdisbelief', 'said', 'sent',
  ];

  /**
   * Reject facts that are structurally valid but semantically worthless:
   * placeholder values, sentence fragments masquerading as entities, or
   * conversation metadata. Keeps the knowledge graph clean.
   */
  private static isJunkFact(f: {
    subject: string; object: string; predicate: string; objectType: string;
  }): boolean {
    const subj = f.subject.trim();
    const obj = f.object.trim();
    const pred = f.predicate.trim().toLowerCase();

    // Placeholder subject/object.
    if (SemanticParser.JUNK_VALUES.has(subj.toLowerCase())) return true;
    if (SemanticParser.JUNK_VALUES.has(obj.toLowerCase())) return true;

    // Conversation-metadata predicates.
    const predNorm = pred.replace(/[\s_]+/g, '');
    if (SemanticParser.META_PREDICATE_FRAGMENTS.some(frag => predNorm.includes(frag.replace(/\s+/g, '')))) {
      return true;
    }

    // A non-literal entity that is really a sentence fragment: too many words
    // or punctuation that no proper noun would contain.
    if (f.objectType !== 'literal') {
      if (obj.split(/\s+/).length > 4) return true;
      if (/[+,;:/]/.test(obj)) return true;
    }
    if (subj.split(/\s+/).length > 4) return true;
    if (/[+,;:/]/.test(subj)) return true;

    return false;
  }

  constructor(
    private provider: ProviderAdapter,
    config?: Partial<SemanticParserConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Parse a user message into structured semantic facts.
   *
   * If the message is trivial (greeting, emoji, etc.), parsing is skipped
   * and a result with `meta.skipped: true` is returned immediately.
   */
  async parse(
    userMessage: string,
    ontologyContext: OntologyContext
  ): Promise<SemanticParseResult> {
    const start = Date.now();

    // Phase 0: Trivial message bypass
    const trivialCheck = this.trivialDetector.check(userMessage);
    if (trivialCheck.isTrivial) {
      return {
        facts: [],
        proposals: [],
        confidence: 'high',
        meta: {
          parseTimeMs: Date.now() - start,
          modelUsed: 'none',
          skipped: true,
          skipReason: trivialCheck.reason,
        },
      };
    }

    // Build parser prompt
    const systemPrompt = buildParserSystemPrompt(ontologyContext);

    // A message carrying an attached document can yield many facts (a CV
    // produces 10-30). The default response budget is too small for that —
    // raise it so the JSON is not truncated mid-array.
    const hasDocument = userMessage.includes('[Attached document content]');
    const maxTokens = hasDocument
      ? Math.max(this.config.maxTokens ?? 2048, 8192)
      : this.config.maxTokens;

    try {
      const response = await this.provider.chat({
        model: this.config.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        maxTokens,
        temperature: this.config.temperature,
      });

      const parseTimeMs = Date.now() - start;

      // Parse LLM JSON output
      const llmOutput = this.extractJSON(response.content);
      if (!llmOutput) {
        // LLM returned non-JSON — return empty result
        return {
          facts: [],
          proposals: [],
          confidence: 'low',
          meta: {
            parseTimeMs,
            modelUsed: this.config.model,
            skipped: false,
          },
        };
      }

      // Validate and sanitize output
      const validated = this.validateOutput(llmOutput);

      return {
        ...validated,
        meta: {
          parseTimeMs,
          modelUsed: this.config.model,
          skipped: false,
        },
      };
    } catch (error) {
      // On LLM error, return empty result — don't block the answer flow
      return {
        facts: [],
        proposals: [],
        confidence: 'low',
        meta: {
          parseTimeMs: Date.now() - start,
          modelUsed: this.config.model,
          skipped: false,
          skipReason: `parser_error: ${(error as Error).message}`,
        },
      };
    }
  }

  /**
   * Extract JSON from LLM response, handling markdown fences and surrounding text.
   */
  private extractJSON(content: string): ParserLLMOutput | null {
    if (!content || content.trim().length === 0) return null;

    let jsonStr = content.trim();

    // Strip markdown code fences if present
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    // Try to find JSON object boundaries if there's surrounding text
    if (!jsonStr.startsWith('{')) {
      const firstBrace = jsonStr.indexOf('{');
      if (firstBrace === -1) return null;
      jsonStr = jsonStr.substring(firstBrace);
    }
    if (!jsonStr.endsWith('}')) {
      const lastBrace = jsonStr.lastIndexOf('}');
      if (lastBrace === -1) return null;
      jsonStr = jsonStr.substring(0, lastBrace + 1);
    }

    try {
      return JSON.parse(jsonStr) as ParserLLMOutput;
    } catch {
      return null;
    }
  }

  /**
   * Validate and sanitize the parser output.
   * Ensures required fields exist, types are correct, and values are within
   * allowed enums. Invalid entries are dropped silently.
   */
  private validateOutput(raw: ParserLLMOutput): Omit<SemanticParseResult, 'meta'> {
    const validConfidences = new Set<ConfidenceLevel>(['high', 'medium', 'low']);
    const validEntityTypes = new Set(['Person', 'Organization', 'Place', 'Concept', 'Event', 'Animal', 'Agent']);
    const validObjectTypes = new Set([...validEntityTypes, 'literal']);
    const validFactKinds = new Set(['fact', 'question', 'uncertain']);
    const validProposalKinds = new Set(['class', 'property']);
    const validProposalActions = new Set(['create', 'map_to_existing', 'ignore']);

    // Validate facts
    const facts: ParsedFact[] = [];
    if (Array.isArray(raw.facts)) {
      for (const f of raw.facts) {
        if (
          typeof f.subject === 'string' && f.subject.length > 0 &&
          typeof f.predicate === 'string' && f.predicate.length > 0 &&
          typeof f.object === 'string' && f.object.length > 0 &&
          validEntityTypes.has(f.subjectType) &&
          validObjectTypes.has(f.objectType) &&
          validConfidences.has(f.confidence) &&
          validFactKinds.has(f.kind) &&
          !SemanticParser.isJunkFact(f)
        ) {
          facts.push({
            subject: f.subject,
            subjectType: f.subjectType,
            predicate: f.predicate,
            object: f.object,
            objectType: f.objectType,
            confidence: f.confidence,
            sourceSpan: typeof f.sourceSpan === 'string' ? f.sourceSpan : '',
            kind: f.kind,
          });
        }
      }
    }

    // Validate proposals
    const proposals: ParsedOntologyProposal[] = [];
    if (Array.isArray(raw.proposals)) {
      for (const p of raw.proposals) {
        if (
          typeof p.name === 'string' && p.name.length > 0 &&
          validProposalKinds.has(p.kind) &&
          validProposalActions.has(p.recommendedAction)
        ) {
          proposals.push({
            kind: p.kind,
            name: p.name,
            domain: typeof p.domain === 'string' ? p.domain : undefined,
            range: typeof p.range === 'string' ? p.range : undefined,
            reason: typeof p.reason === 'string' ? p.reason : '',
            similarExistingTerms: Array.isArray(p.similarExistingTerms)
              ? p.similarExistingTerms.filter((t: unknown) => typeof t === 'string')
              : [],
            recommendedAction: p.recommendedAction,
            mapTo: typeof p.mapTo === 'string' ? p.mapTo : undefined,
          });
        }
      }
    }

    // Validate questionIntent
    let questionIntent: QuestionIntent | undefined;
    if (raw.questionIntent && typeof raw.questionIntent.naturalLanguage === 'string') {
      questionIntent = {
        naturalLanguage: raw.questionIntent.naturalLanguage,
        targetEntity: typeof raw.questionIntent.targetEntity === 'string'
          ? raw.questionIntent.targetEntity : undefined,
        targetProperty: typeof raw.questionIntent.targetProperty === 'string'
          ? raw.questionIntent.targetProperty : undefined,
        expectedAnswerType: typeof raw.questionIntent.expectedAnswerType === 'string'
          ? raw.questionIntent.expectedAnswerType : undefined,
      };
    }

    // Validate overall confidence
    const confidence: ConfidenceLevel = validConfidences.has(raw.confidence)
      ? raw.confidence
      : 'low';

    return { facts, proposals, questionIntent, confidence };
  }
}
