import { escapeSparqlStringContent, sparqlIri } from './SparqlSyntax.js';
import { sparqlLangTag } from './TripleSyntax.js';

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const BNODE_LABEL = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export interface TurtleTermInput {
  termType: string;
  value: string;
  language?: string;
  datatype?: { value: string };
}

/**
 * Serialises one RDF term as an N-Triples/Turtle token. IRIs are validated,
 * literals use the ECHAR escapes (identical in Turtle and SPARQL), blank node
 * labels and language tags are validated. Throws on anything unsafe.
 */
export function turtleTerm(term: TurtleTermInput): string {
  if (term.termType === 'NamedNode') {
    return sparqlIri(term.value);
  }
  if (term.termType === 'Literal') {
    let out = `"${escapeSparqlStringContent(term.value)}"`;
    if (term.language) {
      out += sparqlLangTag(term.language);
    } else if (term.datatype && term.datatype.value !== XSD_STRING) {
      out += `^^${sparqlIri(term.datatype.value)}`;
    }
    return out;
  }
  if (!BNODE_LABEL.test(term.value)) {
    throw new Error(`Invalid blank node label: ${JSON.stringify(term.value.slice(0, 40))}`);
  }
  return `_:${term.value}`;
}
