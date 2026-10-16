import { describe, it, expect } from 'vitest';
import { classifySatisfaction } from '../cognitive/Satisfaction.js';

const T = true;
const F = false;
const N = null;

describe('classifySatisfaction', () => {
  const cases: Array<[string, boolean | null]> = [
    // English: plain
    ['perfect, thanks!', T],
    ['Thank you so much', T],
    ['that works', T],
    ['spot on', T],
    ['No problem, that is great', T],
    ['no worries', T],
    ['that is wrong', F],
    ['nope', F],
    ['No, that is wrong.', F],
    ['stop', F],
    ['that was not what I asked', F],
    // English: negation scope
    ['not good', F],
    ['that is not good at all', F],
    ["it isn't great", F],
    ["that doesn't work", F],
    ["that didn't work", F],
    ['never worked', F],
    ['not really that helpful', F],
    ['not bad', T],
    ['not wrong', T],
    ['no good', F],
    // English: ambiguity
    ['thanks, but can you also add the date?', N],
    ['is that correct?', N],
    ['great, thanks! anything else?', N],
    ['thanks but wrong', N],
    ['good morning', N],
    ['I do not know', N],
    ['what about the other one', N],
    ['we will work on it tomorrow', N],
    ['the network is down', N],
    // German: plain
    ['danke!', T],
    ['Vielen Dank, perfekt', T],
    ['genau, das passt', T],
    ['das stimmt', T],
    ['kein Problem', T],
    ['falsch', F],
    ['nein, das ist falsch', F],
    ['quatsch', F],
    ['leider nicht', F],
    // German: negation scope
    ['nicht gut', F],
    ['das ist nicht richtig', F],
    ['das ist gar nicht gut', F],
    ['funktioniert nicht', F],
    ['das stimmt nicht', F],
    ['das passt nicht', F],
    ['nicht schlecht', T],
    ['gar nicht schlecht', T],
    ['nicht falsch', T],
    ['kein Quatsch', T],
    // German: ambiguity
    ['danke, aber ich meinte etwas anderes', N],
    ['stimmt das?', N],
    ['guten Morgen', N],
    ['nicht schlecht, aber zu lang', N],
    ['ich weiss nicht', N],
    // Word boundaries: no match inside other words
    ['superb', N],
    ['topography', N],
    ['stoppage', N],
    ['nothing', N],
    ['knowledge', N],
    ['goodness', N],
    ['dankbar', N],
    ['Grüße', N],
    // Emoji
    ['👍', T],
    ['👎', F],
    ['✅ danke', T],
    ['', N],
  ];
  for (const [text, want] of cases) {
    it(`${JSON.stringify(text)} -> ${want}`, () => {
      expect(classifySatisfaction(text)).toBe(want);
    });
  }

  it('does not read a long message as a reaction', () => {
    expect(classifySatisfaction(`thanks! ${'please also check the other file and report back. '.repeat(8)}`)).toBeNull();
  });

  it('ignores a non-string', () => {
    expect(classifySatisfaction(undefined as unknown as string)).toBeNull();
  });
});
