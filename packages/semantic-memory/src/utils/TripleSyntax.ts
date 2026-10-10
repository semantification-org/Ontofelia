import type { Triple } from '@ontofelia/core';
import { sparqlIri, sparqlStringLiteral } from './SparqlSyntax.js';

const LANG_TAG = /^[a-zA-Z]+(-[a-zA-Z0-9]+)*$/;
const BNODE_LABEL = /^_:[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

/** Returns `@tag` after validating a BCP 47 style language tag; throws otherwise. */
export function sparqlLangTag(lang: string): string {
  if (typeof lang !== 'string' || !LANG_TAG.test(lang)) {
    throw new Error(`Invalid language tag for SPARQL: ${JSON.stringify(String(lang).slice(0, 40))}`);
  }
  return `@${lang}`;
}

/** Subject position: blank node label or validated IRI. */
export function sparqlSubject(subject: string): string {
  if (typeof subject === 'string' && subject.startsWith('_:')) {
    if (!BNODE_LABEL.test(subject)) {
      throw new Error(`Invalid blank node label for SPARQL: ${JSON.stringify(subject.slice(0, 40))}`);
    }
    return subject;
  }
  return sparqlIri(subject);
}

/** Object position: IRI-shaped strings and `{type:'uri'}` become IRIs, the rest literals. */
export function sparqlObject(obj: Triple['object']): string {
  if (typeof obj === 'string') {
    if (obj.startsWith('http://') || obj.startsWith('https://') || obj.startsWith('urn:')) {
      return sparqlIri(obj);
    }
    return sparqlStringLiteral(obj);
  }
  if (obj.type === 'uri') {
    return sparqlIri(obj.value);
  }
  let literal = sparqlStringLiteral(obj.value);
  if (obj.language) {
    literal += sparqlLangTag(obj.language);
  }
  return literal;
}

/** One complete triple statement ("s p o .") with every term validated or escaped. */
export function sparqlTripleLine(t: Triple): string {
  return `${sparqlSubject(t.subject)} ${sparqlIri(t.predicate)} ${sparqlObject(t.object)} .`;
}
