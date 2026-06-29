import { Triple } from '@ontofelia/core';
import { inferTriples } from '@ontofelia/reasoner';
import { TriplestoreAdapter } from '@ontofelia/core';

export class ReasonableEngine {
  constructor(private triplestore: TriplestoreAdapter) {}

  /**
   * Run materialization. Takes the new triples, combined with TBox and ABox
   * context, passes them to the rust reasoner, and returns ONLY the genuinely
   * inferred triples — the ones that exist *because of* the new facts.
   *
   * The reasoner does forward-chaining materialization: its output contains
   * the input triples (TBox + ABox + new) PLUS everything derivable. Storing
   * that full set would pollute the inferred graph with copies of the TBox
   * and the self-model.
   *
   * To isolate the real new inferences we materialize twice:
   *   baseline = reason over (TBox + ABox)            — without the new facts
   *   extended = reason over (TBox + ABox + newFacts) — with them
   * The set difference (extended − baseline) is exactly what the new facts
   * caused. This needs no Turtle parsing and is robust to reasoner internals.
   */
  async materialize(newTriples: Triple[], contextGraphUri: string): Promise<Triple[]> {
    if (newTriples.length === 0) return [];

    // Get TBOX as Turtle
    const tboxTtl = await this.triplestore.getGraph('urn:shared:ontology', 'turtle');
    // Get agent's context graph as Turtle
    const aboxTtl = await this.triplestore.getGraph(contextGraphUri, 'turtle');

    // New triples as N-Triples string
    const newTtl = newTriples.map(t => ReasonableEngine.tripleToNt(t)).join('\n');

    try {
      // Baseline: what is already derivable without the new facts.
      const baseline = inferTriples(tboxTtl, aboxTtl);
      const baselineKeys = new Set(
        baseline.map(t => ReasonableEngine.rawTripleKey(t)),
      );

      // Extended: derivable once the new facts are added.
      const extended = inferTriples(tboxTtl, `${aboxTtl}\n${newTtl}`);

      // Keep only what the new facts caused, and drop the new facts
      // themselves (they are stored in their target graph, not here).
      const newFactKeys = new Set(
        newTriples.map(t => ReasonableEngine.tripleKey(t)),
      );

      // The reasoner emits terms in N-Triples form: IRIs wrapped in <...>,
      // literals wrapped in "...". Strip that wrapping so downstream code
      // (insertTriples) does not double-wrap into <<...>> / <"...">.
      return extended
        .filter(t => !baselineKeys.has(ReasonableEngine.rawTripleKey(t)))
        .map(t => ({
          subject: ReasonableEngine.unwrapIri(t.subject),
          predicate: ReasonableEngine.unwrapIri(t.predicate),
          object: ReasonableEngine.parseTerm(t.object),
        }))
        .filter(t => !newFactKeys.has(ReasonableEngine.tripleKey(t)));
    } catch (e) {
      console.error('Reasoning failed:', e);
      return [];
    }
  }

  /** Identity key for a raw reasoner triple (terms still in N-Triples form). */
  private static rawTripleKey(t: { subject: string; predicate: string; object: string }): string {
    return `${t.subject.trim()}${t.predicate.trim()}${t.object.trim()}`;
  }

  /** Serialize a triple to an N-Triples line. */
  private static tripleToNt(t: Triple): string {
    const s = t.subject.startsWith('_:') ? t.subject : `<${t.subject}>`;
    const p = `<${t.predicate}>`;
    let o = '';
    if (typeof t.object === 'string') {
      o = (t.object.startsWith('http') || t.object.startsWith('urn:')) ? `<${t.object}>` : `"${t.object}"`;
    } else {
      if (t.object.type === 'uri') o = `<${t.object.value}>`;
      else o = `"${t.object.value}"` + (t.object.language ? `@${t.object.language}` : '');
    }
    return `${s} ${p} ${o} .`;
  }

  /** A stable identity key for a triple, for set membership tests. */
  private static tripleKey(t: Triple): string {
    let o: string;
    if (typeof t.object === 'string') {
      o = t.object;
    } else {
      o = `${t.object.type}:${t.object.value}${t.object.language ? `@${t.object.language}` : ''}`;
    }
    return `${t.subject}${t.predicate}${o}`;
  }

  /** Strip surrounding <> from an N-Triples IRI; leave blank nodes as-is. */
  private static unwrapIri(term: string): string {
    const t = term.trim();
    return t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t;
  }

  /** Parse an N-Triples object term into a Triple object value. */
  private static parseTerm(term: string): Triple['object'] {
    const t = term.trim();
    if (t.startsWith('<') && t.endsWith('>')) {
      return { type: 'uri', value: t.slice(1, -1) };
    }
    // Literal: "value"[@lang][^^<datatype>]
    const litMatch = t.match(/^"((?:[^"\\]|\\.)*)"(?:@([\w-]+))?/);
    if (litMatch) {
      return litMatch[2]
        ? { type: 'literal', value: litMatch[1], language: litMatch[2] }
        : { type: 'literal', value: litMatch[1] };
    }
    // Fallback: treat as plain literal.
    return { type: 'literal', value: t };
  }
}
