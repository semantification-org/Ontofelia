import { describe, it, expect } from 'vitest';
import {
  buildPerception,
  classifyIntent,
  resolvePerception,
  MAX_NER_ENTRIES,
  type IntentLabel,
  type PerceptionSource,
} from '../cognitive/Perception.js';

// Phase 1 is pure: no store, no model. The classifier is a rule table; the
// perception record follows the doc 04 salience table.

describe('classifyIntent', () => {
  const cases: Array<[string, IntentLabel, { questionIntent?: boolean; resolvedEntities?: number }?]> = [
    ['', 'chit-chat'],
    ['/status', 'command'],
    ['restart the gateway', 'command'],
    ['Lösche die Sitzung', 'command'],
    ['hello', 'chit-chat'],
    ['Hallo Ofelia', 'chit-chat'],
    ["wie geht's", 'chit-chat'],
    ['ok', 'chit-chat'],
    ['Who is Anna?', 'question'],
    ['Wer ist Anna', 'question'],
    ['Wie spät ist es?', 'question'],
    ['Is the garden plan done?', 'question'],
    ['Do you remember the plan?', 'question'],
    ['Hi, who is Anna?', 'question'],
    ['Please summarize the notes', 'request'],
    ['Bitte starte den Dienst neu', 'request'],
    ['Kannst du mir das erklären?', 'request'],
    ['Erkläre mir den Unterschied', 'request'],
    ['Ich brauche eine Zusammenfassung', 'request'],
    ['Thanks, please draft the email', 'request'],
    ['Thanks, that helps', 'feedback'],
    ['Danke!', 'feedback'],
    ['Das ist falsch', 'feedback'],
    ['Nein, ich meinte Berlin', 'feedback'],
    ['Wrong', 'feedback'],
    ['👍', 'feedback'],
    ['ontofelia', 'topic-reference'],
    ['Gartenplan Budget', 'topic-reference'],
    ['Zum Thema Gartenplan', 'topic-reference'],
    ['Back to the garden plan', 'topic-reference'],
    ['Anna Berlin garden plan', 'topic-reference', { resolvedEntities: 1 }],
    ['Anna Berlin garden plan', 'chit-chat'],
    ['I live in Berlin and work at Acme', 'chit-chat'],
    ['the garden plan status', 'question', { questionIntent: true }],
    ['Ich wohne in Berlin und arbeite bei Acme', 'chit-chat'],
  ];

  it.each(cases)('%j -> %s', (text, expected, hints) => {
    expect(classifyIntent(text, hints)).toBe(expected);
  });

  it('has at least 20 cases over German and English', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });

  it('is deterministic', () => {
    for (const [text, , hints] of cases) {
      expect(classifyIntent(text, hints)).toBe(classifyIntent(text, hints));
    }
  });

  it('does not treat a word that merely starts like a request phrase as one', () => {
    expect(classifyIntent('letters from the archive arrived yesterday')).not.toBe('request');
  });
});

describe('buildPerception', () => {
  const known = (name: string) => ({ name, source: 'known' as const });
  const iri = (name: string) => `urn:ontofelia:entity:${encodeURIComponent(name)}`;
  const claim = {
    subject: 'Anna', predicate: 'worksAt', object: 'Acme', claimUri: 'urn:ontofelia:claim:c1',
    subjectUri: 'urn:ontofelia:entity:Anna_Person', objectUri: 'urn:ontofelia:entity:Acme',
  };
  const source = (names: string[], withClaim = true): PerceptionSource => ({
    entities: names.map(known),
    storedClaims: withClaim ? [claim] : [],
    parseResult: {
      facts: [
        { kind: 'fact', subject: 'Anna', predicate: 'worksAt', object: 'Acme' },
        { kind: 'question', subject: 'Anna', predicate: 'livesIn', object: '?' },
      ],
    },
    transcriptLine: 4,
  });
  const input = { text: 'Anna works at Acme', senderId: 'u1', senderIsOwner: false, channel: 'webchat' };

  it('writes the doc 04 salience values and the owner bonus', () => {
    const p = buildPerception(input, source(['Anna']));
    const sal = (kind: string) => p.entries.filter((e) => e.entryKind === kind).map((e) => e.salience);
    expect(sal('message-text')).toEqual([1.0]);
    expect(sal('sender-id')).toEqual([0.9]);
    expect(sal('ner-result')).toEqual([0.7]);
    expect(sal('parsed-claim')).toEqual([0.6]);
    expect(sal('intent')).toEqual([0.8]);
    const owner = buildPerception({ ...input, senderIsOwner: true }, source([]));
    expect(owner.entries.find((e) => e.entryKind === 'sender-id')?.salience).toBe(1.0);
  });

  it('takes the IRI of an entity named by a stored fact from the store result, never from the name', () => {
    const p = buildPerception(input, source(['Anna', 'Acme']));
    expect(p.about).toEqual(['urn:ontofelia:entity:Acme', 'urn:ontofelia:entity:Anna_Person']);
    expect(p.pending).toEqual([]);
    expect(p.entries.filter((e) => e.entryKind === 'ner-result').map((e) => e.refersTo)).toEqual([
      'urn:ontofelia:entity:Acme', 'urn:ontofelia:entity:Anna_Person',
    ]);
  });

  it('keeps other known entities pending: no about and no ner-result before resolution (no slug guess)', () => {
    const p = buildPerception(input, source(['Anna', 'Berlin']));
    expect(p.pending).toEqual(['Berlin']);
    expect(p.about).toEqual(['urn:ontofelia:entity:Anna_Person']);
    expect(JSON.stringify(p)).not.toContain(iri('Berlin'));
    // Pattern-only matches are never candidates.
    const none = buildPerception(input, { ...source([], false), entities: [{ name: 'Acme', source: 'ner' }] });
    expect(none.pending).toEqual([]);
    expect(none.about).toEqual([]);
  });

  it('resolvePerception fills pending entities (all nodes of an ambiguous name), leaves unfound ones out, and does not mutate', () => {
    const p = buildPerception(input, source(['Anna', 'Paris', 'Nowhere']));
    const before = JSON.stringify(p);
    const r = resolvePerception(
      p,
      new Map([['paris', ['urn:x:Paris_Place', 'urn:x:Paris']]]),
    );
    expect(JSON.stringify(p)).toBe(before);
    expect(r.about).toEqual(['urn:ontofelia:entity:Anna_Person', 'urn:x:Paris', 'urn:x:Paris_Place']);
    expect(r.pending).toEqual(['Nowhere']);
    const ner = r.entries.filter((e) => e.entryKind === 'ner-result');
    expect(ner.map((e) => e.refersTo)).toEqual([
      'urn:ontofelia:entity:Anna_Person', 'urn:x:Paris', 'urn:x:Paris_Place',
    ]);
    // Entry order is preserved around the ner block: intent stays last.
    expect(r.entries[r.entries.length - 1].entryKind).toBe('intent');
  });

  it('orders entities by name regardless of input order and caps ner-result entries at five', () => {
    const names = ['Zeta', 'Alpha', 'Gamma', 'Beta', 'Delta', 'Epsilon', 'Eta'];
    const map = new Map(names.map((n) => [n.toLowerCase(), [iri(n)]]));
    const a = resolvePerception(buildPerception(input, source(names, false)), map);
    const b = resolvePerception(buildPerception(input, source([...names].reverse(), false)), map);
    const ner = a.entries.filter((e) => e.entryKind === 'ner-result');
    expect(ner).toHaveLength(MAX_NER_ENTRIES);
    expect(ner.map((e) => e.payload)).toEqual(
      ['Alpha', 'Beta', 'Delta', 'Epsilon', 'Eta'].map((n) => `entity=${n} (resolved)`),
    );
    expect(b).toEqual(a);
    expect(a.about).toHaveLength(7);
  });

  it('exposes tags, hasClaim and the transcript line for the episode; questions are not claims', () => {
    const p = buildPerception(input, source(['Anna']));
    expect(p.tags).toEqual([p.intent]);
    expect(p.hasClaim).toEqual(['urn:ontofelia:claim:c1']);
    expect(p.transcriptLine).toBe(4);
    const claims = p.entries.filter((e) => e.entryKind === 'parsed-claim');
    expect(claims).toHaveLength(1);
    expect(claims[0].refersTo).toBe('urn:ontofelia:claim:c1');
  });

  it('drops an IRI that cannot be written safely into SPARQL', () => {
    const bad = { ...claim, subjectUri: 'urn:x:a>b', objectUri: undefined };
    const p = buildPerception(input, { ...source(['Anna']), storedClaims: [bad] });
    expect(p.about).toEqual([]);
    const r = resolvePerception(p, new Map([['anna', ['urn:x:b c']]]));
    expect(r.about).toEqual([]);
  });

  it('works without a source (envelope only)', () => {
    const p = buildPerception({ text: 'hi', senderIsOwner: false });
    expect(p.entries.map((e) => e.entryKind)).toEqual(['message-text', 'intent']);
    expect(p.hasClaim).toEqual([]);
    expect(p.transcriptLine).toBeUndefined();
  });
});
