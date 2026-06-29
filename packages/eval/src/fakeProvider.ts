import type {
  ProviderAdapter,
  ProviderConfig,
  ChatRequest,
  ChatResponse,
  StreamEvent,
  HealthResult,
} from '@ontofelia/core';

/**
 * A deterministic, offline ProviderAdapter for tests and offline pilot runs
 * (spec §3 — "must be mockable"). It does NOT hit the network.
 *
 * Default behaviour: a tiny extractive "answerer" that echoes the most relevant
 * lines from the retrieved-memory section of the prompt. This is enough for the
 * programmatic scorer to find gold tokens when the backend actually surfaced
 * them, and to fail when it did not (so backends are genuinely distinguished).
 */
export class FakeProvider implements ProviderAdapter {
  readonly name = 'fake';
  private respond: (req: ChatRequest) => string;

  constructor(respond?: (req: ChatRequest) => string) {
    this.respond = respond ?? defaultExtractiveAnswer;
  }

  async initialize(_config: ProviderConfig): Promise<void> {}

  async healthCheck(): Promise<HealthResult> {
    return { healthy: true, component: 'FakeProvider', checkedAt: new Date().toISOString() };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const content = this.respond(request);
    const promptTokens = approxTokens(request.messages.map((m) => stringifyContent(m.content)).join(' '));
    const completionTokens = approxTokens(content);
    return {
      id: `fake-${Date.now()}`,
      content,
      toolCalls: [],
      finishReason: 'stop',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      },
    };
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const response = await this.chat(request);
    yield { type: 'text_delta', content: response.content };
    yield { type: 'done', response };
  }
}

function stringifyContent(content: ChatRequest['messages'][number]['content']): string {
  if (typeof content === 'string') return content;
  return content.map((p) => (p.type === 'text' ? p.text : '')).join(' ');
}

function approxTokens(s: string): number {
  return Math.max(1, Math.ceil(s.length / 4));
}

/**
 * Extractive answerer: pull the user message, isolate the "Retrieved memory"
 * block and the "Question", then return the memory lines most relevant to the
 * question. With empty memory it answers "I don't know", which is exactly what
 * no-memory should do once the answer has been padded out of the window.
 *
 * Two deliberate fairness properties (review fixes):
 *  - It reads the WHOLE retrieved context (no volume-based truncation that
 *    penalises the verbose backend): fact-like lines (`- …`) are surfaced in
 *    full, prose only fills remaining slack. A real LLM reads all lines.
 *  - The conflict note is emitted ONLY when the retrieved memory carries an
 *    explicit `[CONFLICT]` marker that a backend put there — NEVER from a raw
 *    "actually/superseded/…" trigger word in the rolling window. So vector-rag
 *    and no-memory cannot magically flag a conflict.
 */
function defaultExtractiveAnswer(req: ChatRequest): string {
  const userMsg = req.messages.find((m) => m.role === 'user');
  const text = userMsg ? stringifyContent(userMsg.content) : '';

  const memory = sliceBetween(text, '## Retrieved memory', '## Recent conversation').trim();
  const recent = sliceBetween(text, '## Recent conversation', '## Question').trim();
  const question = text.split('## Question').pop()?.trim() ?? '';

  const corpus = [memory, recent].filter((s) => s && s !== '(no retrieved memory)' && s !== '(empty)').join('\n');
  if (!corpus.trim()) return "I don't know.";

  const qTokens = new Set(tokenize(question));
  const lines = corpus.split('\n').map((l) => l.trim()).filter(Boolean);

  // Fact-like / structured lines (bullets) carry the answer content; surface
  // ALL of them so a verbose backend is not truncated. Prose lines (headers,
  // narrative) are only used to fill query-relevant slack. No hard volume cap
  // that would favour lean backends.
  const factLines = lines.filter((l) => l.startsWith('-'));
  const proseRelevant = lines
    .filter((l) => !l.startsWith('-'))
    .map((line) => ({ line, overlap: tokenize(line).filter((t) => qTokens.has(t)).length }))
    .filter((s) => s.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap)
    .map((s) => s.line);
  const chosen = [...new Set([...factLines, ...proseRelevant])];

  // Conflict flag is gated on an explicit backend-emitted [CONFLICT] marker.
  const conflict = /\[CONFLICT\]/.test(corpus)
    ? ' Note: there is a conflict between facts; I prefer the most recent one.'
    : '';

  return `Based on what I remember: ${chosen.join('; ')}.${conflict}`;
}

function sliceBetween(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  if (i < 0) return '';
  const from = i + start.length;
  const j = text.indexOf(end, from);
  return text.slice(from, j < 0 ? undefined : j);
}

function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 1);
}
