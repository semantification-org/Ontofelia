/**
 * Pure mapper from one Vault-LD note (already-parsed YAML frontmatter) to
 * `FactInput`s for `KnowledgeEngine.storeFact`. No I/O, no store access.
 *
 * Scope: key names are used as predicate names verbatim — JSON-LD @context
 * composition is deliberately NOT implemented.
 */
import type { FactInput } from '../types.js';
import { isUserAliasSubject } from '../KnowledgeEngine.js';

export interface VaultNote {
  /** Vault-relative path, e.g. 'Recipes/hummus.md'. */
  path: string;
  /** Already parsed YAML frontmatter. */
  frontmatter: Record<string, unknown>;
  /** Markdown body, used as evidence text. */
  body?: string;
  /** Hash of the whole file, e.g. 'sha256:<hex>'. */
  contentHash: string;
  /** Vault name, e.g. 'demo'. */
  vaultName: string;
}

export interface VaultNoteMapping {
  facts: FactInput[];
  /** Keys deliberately or necessarily not turned into facts. */
  unmapped: { key: string; reason: string }[];
  /** Set when the whole note is refused; `facts` is then empty. */
  refused?: string;
}

/** Longest body excerpt kept as evidence text. */
const MAX_SPAN = 2000;

/**
 * Vault-LD §4.3 "Host-tool keys are not triples": `tags`, `aliases` and
 * `cssclasses` belong to the host editor; while unmapped a tool MUST NOT emit
 * them as triples (and MUST NOT warn about them as unknown constructs).
 */
const HOST_KEYS = new Set(['tags', 'aliases', 'cssclasses']);

const WIKI_LINK = /^\s*\[\[([^\]]*)\]\]\s*$/;
// prefix:local — prefix starts with a letter, no whitespace, local part does not start with '/'.
const CURIE = /^[A-Za-z][\w.-]*:[^\s/][^\s]*$/;

/** Target note name of a wiki link body: drop `|alias`, `#heading`, folder path and `.md`. */
function wikiTarget(inner: string): string {
  const noAlias = inner.split('|')[0];
  const noFragment = noAlias.split('#')[0];
  const last = noFragment.trim().split('/').pop() ?? '';
  return last.replace(/\.md$/i, '').trim();
}

type Mapped = { object: string; objectType: 'literal' | 'Concept' } | { skip: string };

function mapScalar(value: unknown): Mapped {
  if (value instanceof Date) return { object: value.toISOString(), objectType: 'literal' };
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { object: String(value), objectType: 'literal' };
  }
  if (typeof value !== 'string') {
    return { skip: value === null || value === undefined ? 'null value' : 'unsupported value type' };
  }
  const link = WIKI_LINK.exec(value);
  if (link) {
    const target = wikiTarget(link[1]);
    return target ? { object: target, objectType: 'Concept' } : { skip: 'empty wiki link' };
  }
  const text = value.trim();
  if (!text) return { skip: 'empty value' };
  if (CURIE.test(text) && !text.includes('//')) return { object: text, objectType: 'Concept' };
  return { object: value, objectType: 'literal' };
}

export function mapVaultNote(note: VaultNote): VaultNoteMapping {
  const fm = note.frontmatter ?? {};
  const unmapped: { key: string; reason: string }[] = [];
  const fileName = (note.path.split('/').pop() ?? note.path).replace(/\.md$/i, '');
  const label = typeof fm.label === 'string' && fm.label.trim() ? fm.label.trim() : undefined;
  const subject = label ?? fileName;

  const refuse = (reason: string): VaultNoteMapping => ({ facts: [], unmapped, refused: reason });

  if (isUserAliasSubject(subject)) {
    return refuse(`subject "${subject}" is a user alias`);
  }
  // Vault-LD §4.4.1: "A note with no frontmatter, or whose frontmatter lacks
  // `@type`, does **not** participate in the graph; it is an ordinary
  // document." `type` is the declared alias of `@type` (§4.3); both spellings count.
  const typeKey = 'type' in fm ? 'type' : '@type' in fm ? '@type' : undefined;
  const typeValue = typeKey ? fm[typeKey] : undefined;
  const hasType = Array.isArray(typeValue)
    ? typeValue.length > 0
    : typeValue !== undefined && typeValue !== null && typeValue !== '';
  if (!hasType) return refuse('no type (not in the graph per Vault-LD)');

  const sourceUri = 'vault://' + encodeURIComponent(note.vaultName) + '/'
    + note.path.split('/').map(encodeURIComponent).join('/');
  const span = (note.body ?? '').trim().slice(0, MAX_SPAN);

  const facts: FactInput[] = [];
  for (const [key, value] of Object.entries(fm)) {
    if (key === 'id' || key === '@id') {
      unmapped.push({ key, reason: 'identity key (not mapped yet)' });
      continue;
    }
    if (HOST_KEYS.has(key)) {
      unmapped.push({ key, reason: 'host key (not a triple)' });
      continue;
    }
    if (key === '@context') {
      unmapped.push({ key, reason: 'context declaration (composition not implemented)' });
      continue;
    }
    // `type`/`@type` is expressed as the predicate 'type': KnowledgeEngine's
    // BUILTIN_PREDICATES funnels it to rdf:type, so the reasoner sees a real
    // type edge. Every other key is used verbatim as the predicate name.
    const predicate = key === '@type' ? 'type' : key;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      const m = mapScalar(v);
      if ('skip' in m) {
        const reason = typeof v === 'object' && v !== null && !(v instanceof Date)
          ? 'nested object or list (not mapped)' : m.skip;
        if (!unmapped.some(u => u.key === key && u.reason === reason)) unmapped.push({ key, reason });
        continue;
      }
      facts.push({
        // subjectType 'Concept' (the generic type the parser uses) makes
        // storeFact create the subject node with its label; the Vault-LD class
        // itself is carried by the `type` fact, not by subjectType.
        subject,
        subjectType: 'Concept',
        predicate,
        object: m.object,
        objectType: m.objectType,
        sourceKind: 'tool',
        channel: 'vault-import',
        evidenceType: 'document',
        sourceUri,
        contentHash: note.contentHash,
        ...(span ? { sourceSpan: span } : {}),
        confidenceLabel: 'high',
        status: 'accepted',
      });
    }
  }
  return { facts, unmapped };
}
