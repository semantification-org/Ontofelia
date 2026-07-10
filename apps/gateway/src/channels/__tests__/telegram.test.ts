import { describe, it, expect } from 'vitest';
import { splitForTelegram, telegramPhaseLabel } from '../telegram.js';

describe('telegramPhaseLabel (live progress status)', () => {
  it('maps known agent phases to short human labels', () => {
    expect(telegramPhaseLabel('kg_context')).toBe('🔎 Searching memory…');
    expect(telegramPhaseLabel('llm_call')).toBe('🧠 Reasoning…');
    expect(telegramPhaseLabel('llm_response')).toBe('✍️ Writing answer…');
    expect(telegramPhaseLabel('final')).toBe('✍️ Writing answer…');
  });

  it('includes the tool name for tool_call when present', () => {
    expect(telegramPhaseLabel('tool_call', { toolName: 'web_search' })).toBe('🔧 Running tool: web_search');
    expect(telegramPhaseLabel('tool_call', { name: 'calc' })).toBe('🔧 Running tool: calc');
    expect(telegramPhaseLabel('tool_call')).toBe('🔧 Running tool…');
  });

  it('returns null for phases that should not change the status', () => {
    // guardian_confirm is handled separately; unknown phases are ignored.
    expect(telegramPhaseLabel('guardian_confirm')).toBeNull();
    expect(telegramPhaseLabel('something_else')).toBeNull();
  });
});

describe('splitForTelegram', () => {
  it('returns the text unchanged when shorter than the limit', () => {
    const text = 'Hallo, hier ist eine kurze Nachricht.';
    expect(splitForTelegram(text)).toEqual([text]);
  });

  it('splits at paragraph boundaries when possible', () => {
    const limit = 100;
    const para = 'A'.repeat(60);
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = splitForTelegram(text, limit);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(limit);
    }
    expect(chunks.join(' ').replace(/\s+/g, '')).toBe(text.replace(/\s+/g, ''));
  });

  it('every chunk respects the Telegram 4096 cap', () => {
    const text = 'word '.repeat(2000); // ~10000 chars
    const chunks = splitForTelegram(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(4096);
    }
  });

  it('falls back to word boundaries when no line breaks exist', () => {
    const text = 'word '.repeat(1000); // ~5000 chars, no newlines
    const chunks = splitForTelegram(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(200);
      // Word-boundary cuts should never split a word
      expect(c.startsWith('word')).toBe(true);
    }
  });

  it('hard-cuts when no whitespace is available', () => {
    const text = 'x'.repeat(10000);
    const chunks = splitForTelegram(text, 500);
    expect(chunks.length).toBe(Math.ceil(10000 / 500));
    expect(chunks.every(c => c.length <= 500)).toBe(true);
  });

  it('closes and reopens code fences across chunks', () => {
    const codeBlockLine = 'some code that is fairly long for testing\n';
    const inner = codeBlockLine.repeat(20); // ~860 chars
    const text = `Hier ist ein Beispiel:\n\n\`\`\`\n${inner}\`\`\`\nFertig.`;
    const chunks = splitForTelegram(text, 300);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk must have an even number of triple-backticks
    for (const c of chunks) {
      const fences = (c.match(/```/g) || []).length;
      expect(fences % 2).toBe(0);
    }
  });

  it('reassembles to the original content (modulo whitespace)', () => {
    const text = 'Erste Zeile.\n\nZweite Zeile mit etwas Text.\nDritte Zeile.\n'.repeat(100);
    const chunks = splitForTelegram(text, 500);
    const rejoined = chunks.join('\n');
    // Inner content must be preserved (we may add whitespace at split points)
    expect(rejoined.replace(/\s+/g, ' ').trim()).toBe(text.replace(/\s+/g, ' ').trim());
  });
});
