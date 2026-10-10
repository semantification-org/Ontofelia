import { Triple } from '@ontofelia/core';
import { inferTriples } from '@ontofelia/reasoner';
import { TriplestoreAdapter } from '@ontofelia/core';
import { sparqlIri, sparqlStringLiteral } from '../utils/SparqlSyntax.js';
import { sparqlLangTag, sparqlSubject } from '../utils/TripleSyntax.js';

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
  async materialize(
    newTriples: Triple[],
    contextGraphUri: string | string[],
    options: { strict?: boolean } = {},
  ): Promise<Triple[]> {
    if (newTriples.length === 0) return [];

    // Get TBOX as Turtle (outside the try so strict callers see read errors too)
    const tboxTtl = await this.triplestore.getGraph('urn:shared:ontology', 'turtle');
    // Get the ABox as Turtle: one context graph, or several that are reasoned
    // over together (e.g. the worldview plus one user's graph). Concatenated
    // Turtle documents are a valid Turtle document.
    const contextGraphs = Array.isArray(contextGraphUri) ? contextGraphUri : [contextGraphUri];
    const aboxTtl = (await Promise.all(
      contextGraphs.map(g => this.triplestore.getGraph(g, 'turtle')),
    )).join('\n');

    try {
      // New triples as N-Triples string (terms validated/escaped; a value that
      // cannot be written safely aborts reasoning instead of reaching the parser).
      const newTtl = newTriples.map(t => ReasonableEngine.tripleToNt(t)).join('\n');

      // inferTriples is now async (the native reasoner runs on a libuv worker
      // thread instead of blocking the event loop). Baseline and extended are
      // independent runs, so materialize them in parallel — this also exercises
      // the reasoner under concurrent calls.
      const [baseline, extended] = await Promise.all([
        // Baseline: what is already derivable without the new facts.
        inferTriples(tboxTtl, aboxTtl),
        // Extended: derivable once the new facts are added.
        inferTriples(tboxTtl, `${aboxTtl}\n${newTtl}`),
      ]);
      const baselineKeys = new Set(
        baseline.map(t => ReasonableEngine.rawTripleKey(t)),
      );

      // Keep only what the new facts caused, and drop the new facts
      // themselves (they are stored in their target graph, not here). The
      // new facts are compared in the reasoner's own N-Triples form: a plain
      // string object and the reasoner's `"value"` literal denote the same
      // term, which a key built from the Triple shape did not recognise, so
      // every literal input fact came back as a "derivation".
      const newFactKeys = new Set(
        newTriples.map(t => ReasonableEngine.rawTripleKey(ReasonableEngine.tripleToNtTerms(t))),
      );

      // The reasoner emits terms in N-Triples form: IRIs wrapped in <...>,
      // literals wrapped in "...". Strip that wrapping so downstream code
      // (insertTriples) does not double-wrap into <<...>> / <"...">.
      return extended
        .filter(t => !baselineKeys.has(ReasonableEngine.rawTripleKey(t)))
        .filter(t => !newFactKeys.has(ReasonableEngine.rawTripleKey(t)))
        .map(t => ({
          subject: ReasonableEngine.unwrapIri(t.subject),
          predicate: ReasonableEngine.unwrapIri(t.predicate),
          object: ReasonableEngine.parseTerm(t.object),
        }));
    } catch (e) {
      // Callers that act on an EMPTY result destructively (rebuilds) need to
      // tell "nothing derived" from "reasoner failed".
      if (options.strict) throw e;
      console.error('Reasoning failed:', e);
      return [];
    }
  }

  /**
   * Identity key for a triple whose terms are in N-Triples form. A plain
   * literal and an explicit xsd:string literal are the same term in RDF 1.1,
   * so the datatype is dropped from the key.
   */
  private static rawTripleKey(t: { subject: string; predicate: string; object: string }): string {
    const o = t.object.trim().replace(/\^\^<http:\/\/www\.w3\.org\/2001\/XMLSchema#string>$/, '');
    return `${t.subject.trim()} ${t.predicate.trim()} ${o}`;
  }

  /** The three N-Triples terms of a triple (every term validated or escaped). */
  private static tripleToNtTerms(t: Triple): { subject: string; predicate: string; object: string } {
    const s = sparqlSubject(t.subject);
    const p = sparqlIri(t.predicate);
    let o = '';
    if (typeof t.object === 'string') {
      o = (t.object.startsWith('http') || t.object.startsWith('urn:')) ? sparqlIri(t.object) : sparqlStringLiteral(t.object);
    } else {
      if (t.object.type === 'uri') o = sparqlIri(t.object.value);
      else o = sparqlStringLiteral(t.object.value) + (t.object.language ? sparqlLangTag(t.object.language) : '');
    }
    return { subject: s, predicate: p, object: o };
  }

  /** Serialize a triple to an N-Triples line. */
  private static tripleToNt(t: Triple): string {
    const { subject, predicate, object } = ReasonableEngine.tripleToNtTerms(t);
    return `${subject} ${predicate} ${object} .`;
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
