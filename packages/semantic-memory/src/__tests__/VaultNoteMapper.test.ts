import { describe, it, expect } from 'vitest';
import { mapVaultNote, type VaultNote } from '../ingestion/VaultNoteMapper.js';
import { assertValidEvidenceSourceUri } from '../provenance/ClaimProvenanceService.js';

const hummus = (over: Partial<VaultNote> = {}): VaultNote => ({
  path: 'Recipes/hummus.md',
  frontmatter: {
    type: '[[Recipe]]',
    requiresIngredient: '[[Chickpeas]]',
    difficulty: '[[Beginner]]',
    prepTimeMinutes: 25,
  },
  body: '# Hummus\nA smooth purée.',
  contentHash: 'sha256:abc',
  vaultName: 'demo',
  ...over,
});

describe('mapVaultNote', () => {
  it('maps the hummus note to facts with document evidence', () => {
    const r = mapVaultNote(hummus());
    expect(r.refused).toBeUndefined();
    const by = Object.fromEntries(r.facts.map(f => [f.predicate, f]));
    expect(by.type).toMatchObject({ subject: 'hummus', object: 'Recipe', objectType: 'Concept' });
    expect(by.requiresIngredient).toMatchObject({ object: 'Chickpeas', objectType: 'Concept' });
    expect(by.difficulty).toMatchObject({ object: 'Beginner', objectType: 'Concept' });
    expect(by.prepTimeMinutes).toMatchObject({ object: '25', objectType: 'literal' });
    expect(r.facts).toHaveLength(4);
    for (const f of r.facts) {
      expect(f).toMatchObject({
        sourceKind: 'tool', channel: 'vault-import', evidenceType: 'document',
        sourceUri: 'vault://demo/Recipes/hummus.md', contentHash: 'sha256:abc',
        sourceSpan: '# Hummus\nA smooth purée.', confidenceLabel: 'high', status: 'accepted',
      });
    }
  });

  it('uses a non-empty label as subject and omits an empty span', () => {
    const r = mapVaultNote(hummus({ body: '  ', frontmatter: { type: '[[Recipe]]', label: 'Hummus dip' } }));
    expect(r.facts.every(f => f.subject === 'Hummus dip')).toBe(true);
    expect(r.facts[0]).not.toHaveProperty('sourceSpan');
  });

  it('caps the span at 2000 chars', () => {
    const r = mapVaultNote(hummus({ body: 'x'.repeat(5000) }));
    expect(r.facts[0].sourceSpan).toHaveLength(2000);
  });

  it('puts host keys and id in unmapped, not in facts', () => {
    const r = mapVaultNote(hummus({ frontmatter: {
      type: '[[Recipe]]', tags: ['a'], aliases: ['b'], cssclasses: ['c'], id: 'https://example.org/x',
    } }));
    expect(r.facts.map(f => f.predicate)).toEqual(['type']);
    expect(r.unmapped.map(u => u.key).sort()).toEqual(['aliases', 'cssclasses', 'id', 'tags']);
    expect(r.unmapped.find(u => u.key === 'id')!.reason).toBe('identity key (not mapped yet)');
  });

  it('maps a list to one fact per element, strips alias/heading/path, keeps CURIEs', () => {
    const r = mapVaultNote(hummus({ frontmatter: {
      type: '[[Recipe]]',
      requiresIngredient: ['[[Chickpeas]]', '[[Tahini|sesame paste]]', '[[Lemon#Juice]]', '[[Pantry/Salt]]'],
      subClassOf: ['sdo:Recipe', 'see: this', 'https://example.org/x'],
    } }));
    const ing = r.facts.filter(f => f.predicate === 'requiresIngredient');
    expect(ing.map(f => f.object)).toEqual(['Chickpeas', 'Tahini', 'Lemon', 'Salt']);
    const sub = r.facts.filter(f => f.predicate === 'subClassOf');
    expect(sub.map(f => [f.object, f.objectType])).toEqual([
      ['sdo:Recipe', 'Concept'], ['see: this', 'literal'], ['https://example.org/x', 'literal'],
    ]);
  });

  it('maps booleans to literals and puts nested objects and null in unmapped', () => {
    const r = mapVaultNote(hummus({ frontmatter: {
      type: '[[Recipe]]', vegan: true, nested: { a: 1 }, nothing: null,
    } }));
    expect(r.facts.find(f => f.predicate === 'vegan')).toMatchObject({ object: 'true', objectType: 'literal' });
    expect(r.unmapped.map(u => u.key).sort()).toEqual(['nested', 'nothing']);
  });

  it('refuses a note whose subject is a user alias', () => {
    const r = mapVaultNote(hummus({ path: 'ich.md', frontmatter: { type: '[[Person]]', label: 'me' } }));
    expect(r.facts).toEqual([]);
    expect(r.refused).toMatch(/user alias/);
    expect(mapVaultNote(hummus({ path: 'People/User.md' })).refused).toBeDefined();
  });

  it('refuses a note without type', () => {
    const r = mapVaultNote(hummus({ frontmatter: { difficulty: '[[Beginner]]' } }));
    expect(r.facts).toEqual([]);
    expect(r.refused).toBe('no type (not in the graph per Vault-LD)');
  });

  it('percent-encodes path segments into a valid evidence sourceUri', () => {
    const r = mapVaultNote(hummus({ path: 'Soups & Stews/Red Lentil Soup.md' }));
    const uri = r.facts[0].sourceUri!;
    expect(uri).toBe('vault://demo/Soups%20%26%20Stews/Red%20Lentil%20Soup.md');
    expect(() => assertValidEvidenceSourceUri(uri)).not.toThrow();
    expect(r.facts[0].subject).toBe('Red Lentil Soup');
  });
});
