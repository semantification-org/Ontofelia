import { describe, it, expect } from 'vitest';
import { splitForTelegram, telegramStepLabel, renderTelegramChecklist, TELEGRAM_STATUS_HEADER } from '../telegram.js';

describe('telegramStepLabel (checklist steps)', () => {
  it('maps the cognitive-cycle phases explicitly', () => {
    expect(telegramStepLabel('perception')).toBe('👁 Perception');
    expect(telegramStepLabel('goal_management', { goalType: 'answer_question' })).toBe('🎯 Goal: answer_question');
    expect(telegramStepLabel('goal_management')).toBe('🎯 Deliberation');
    expect(telegramStepLabel('reflection')).toBe('🔍 Reflection');
  });

  it('maps the core LLM/memory phases', () => {
    expect(telegramStepLabel('kg_context')).toBe('🔎 Searching memory');
    expect(telegramStepLabel('llm_call')).toBe('🧠 Reasoning');
    expect(telegramStepLabel('llm_response')).toBe('✍️ Writing answer');
    expect(telegramStepLabel('final')).toBe('✍️ Writing answer');
  });

  it('shows tool usage explicitly with the tool name', () => {
    expect(telegramStepLabel('tool_call', { toolName: 'web_search' })).toBe('🔧 Tool: web_search');
    expect(telegramStepLabel('tool_call', { name: 'calc' })).toBe('🔧 Tool: calc');
    expect(telegramStepLabel('tool_call')).toBe('🔧 Tool');
  });

  it('returns null for phases that should not add a step', () => {
    expect(telegramStepLabel('guardian_confirm')).toBeNull();
    expect(telegramStepLabel('something_else')).toBeNull();
  });
});

describe('renderTelegramChecklist', () => {
  it('is just the header when there are no steps', () => {
    expect(renderTelegramChecklist([])).toBe(TELEGRAM_STATUS_HEADER);
  });

  it('marks completed steps ✓ and the current (last) step ⏳', () => {
    const out = renderTelegramChecklist(['👁 Perception', '🔎 Searching memory', '🔧 Tool: web_search']);
    expect(out).toContain('✓ 👁 Perception');
    expect(out).toContain('✓ 🔎 Searching memory');
    expect(out).toContain('⏳ 🔧 Tool: web_search');
  });

  it('elides the middle when the list exceeds the cap', () => {
    const many = Array.from({ length: 20 }, (_, i) => `step-${i}`);
    const out = renderTelegramChecklist(many);
    expect(out).toContain('…');
    expect(out).toContain('⏳ step-19'); // last is still the current step
    expect(out.split('\n').length).toBeLessThan(20);
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
