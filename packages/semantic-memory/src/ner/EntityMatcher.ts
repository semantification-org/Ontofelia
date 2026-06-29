import { KnowledgeEngine } from '../KnowledgeEngine.js';

export interface EntityMatch {
  name: string;
  source: 'known' | 'ner';
}

/**
 * EntityMatcher — combines the known-entity dictionary with pattern-based NER.
 * 
 * Strategy:
 * 1. Known Entity Lookup: Match user text against entities already in the Knowledge Graph
 * 2. Pattern NER: Detect potential new entities via linguistic patterns
 *    - Quoted strings ("Berlin", 'Ontofelia')
 *    - Multi-word capitalized sequences at non-sentence positions
 *    - Common named entity patterns (proper nouns after certain prepositions)
 */
export class EntityMatcher {
  private knownEntities: string[] = [];
  private lastRefresh = 0;
  private readonly CACHE_TTL_MS = 60_000; // Refresh entity list every 60s

  /** Common words that should not be treated as entities. */
  private static STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'has', 'have', 'will', 'can',
    'i', 'you', 'he', 'she', 'it', 'we', 'they', 'my', 'your', 'his',
    'and', 'or', 'but', 'not', 'yes', 'no', 'what', 'who', 'where', 'how',
    'Hello', 'Hi', 'Hey', 'Yes', 'No', 'Ok', 'Good', 'Thanks', 'Please',
    'Also', 'But', 'And', 'Or', 'Then', 'Maybe', 'Of', 'Course',
    'Exactly', 'Right', 'Correct',
  ]);

  constructor(private knowledgeEngine: KnowledgeEngine) {}

  /**
   * Refresh the known entity list from the triplestore (cached).
   */
  async refreshEntities(agentId: string, userId?: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastRefresh < this.CACHE_TTL_MS && this.knownEntities.length > 0) {
      return; // Cache still valid
    }
    this.knownEntities = await this.knowledgeEngine.listKnownEntities(agentId, userId);
    this.lastRefresh = now;
  }

  /**
   * Extract entities from user text.
   * Returns both known entities (from graph) and newly detected entities (from NER).
   */
  async extractEntities(text: string, agentId: string, userId?: string): Promise<EntityMatch[]> {
    await this.refreshEntities(agentId, userId);
    const results: EntityMatch[] = [];
    const seen = new Set<string>();

    // 1. Known Entity Matching (case-insensitive substring)
    for (const entity of this.knownEntities) {
      if (entity.length < 2) continue; // Skip very short labels
      if (text.toLowerCase().includes(entity.toLowerCase())) {
        if (!seen.has(entity.toLowerCase())) {
          results.push({ name: entity, source: 'known' });
          seen.add(entity.toLowerCase());
        }
      }
    }

    // 2. Pattern-based NER for new entities

    // 2a. Quoted strings: "Entity Name" or 'Entity Name'
    const quotedPattern = /["'„]([A-ZÄÖÜa-zäöüß][A-Za-zÄÖÜäöüß\s\-\.]{1,40})["'"]|»([^«]+)«/g;
    let match;
    while ((match = quotedPattern.exec(text)) !== null) {
      const name = (match[1] || match[2]).trim();
      if (name.length >= 2 && !seen.has(name.toLowerCase())) {
        results.push({ name, source: 'ner' });
        seen.add(name.toLowerCase());
      }
    }

    // 2b. Proper nouns: Capitalized words NOT at sentence start, not in stop list
    // Split into sentences first
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/);
      // Skip first word of each sentence (always capitalized in German)
      for (let i = 1; i < words.length; i++) {
        const word = words[i].replace(/[,;:!?()]/g, '');
        if (word.length < 2) continue;
        
        // Check for capitalized word (not a stop word, not all-caps)
        if (/^[A-ZÄÖÜ][a-zäöüß]+/.test(word) && !EntityMatcher.STOP_WORDS.has(word)) {
          // Build multi-word entity (consecutive capitalized words)
          let entityName = word;
          for (let j = i + 1; j < words.length; j++) {
            const next = words[j].replace(/[,;:!?()]/g, '');
            if (/^[A-ZÄÖÜ][a-zäöüß]+/.test(next) && !EntityMatcher.STOP_WORDS.has(next)) {
              entityName += ' ' + next;
              i = j; // Skip consumed words
            } else {
              break;
            }
          }

          if (!seen.has(entityName.toLowerCase())) {
            results.push({ name: entityName, source: 'ner' });
            seen.add(entityName.toLowerCase());
          }
        }
      }
    }

    // 2c. Entities after key prepositions.
    const prepPattern = /\b(?:in|at|from|for|with|on)\s+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß\-\.]+(?:\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß\-\.]+)*)/gi;
    while ((match = prepPattern.exec(text)) !== null) {
      const name = match[1].trim();
      if (name.length >= 2 && !EntityMatcher.STOP_WORDS.has(name) && !seen.has(name.toLowerCase())) {
        results.push({ name, source: 'ner' });
        seen.add(name.toLowerCase());
      }
    }

    return results;
  }
}
