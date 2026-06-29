import type { ProviderAdapter, ChatMessage } from '@ontofelia/core';

/**
 * The answer LLM (spec §3). One {@link ProviderAdapter}, fixed across A/B/C,
 * temperature 0. The runner builds: system skeleton + retrieved context +
 * rolling window + probe; we call chat() and record answer + tokens + latency.
 *
 * Mockable: inject a fake ProviderAdapter (see FakeProvider) for offline tests.
 */
export interface AnswerLlmConfig {
  provider: ProviderAdapter;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

const SYSTEM_SKELETON = [
  'You are an evaluation assistant. Answer the user using ONLY the information',
  'in the "Retrieved memory" and "Recent conversation" sections below.',
  'If the information is not present, say you do not know.',
  'If two facts about the same thing conflict, you MUST say so explicitly using',
  'the word "conflict" and prefer the most recent one.',
  'Do not invent facts. Be concise.',
].join(' ');

export interface BuildPromptArgs {
  retrievedContext: string;
  rollingWindow: string[];
  probe: string;
}

export function buildMessages(args: BuildPromptArgs): ChatMessage[] {
  const context = args.retrievedContext.trim() || '(no retrieved memory)';
  const recent = args.rollingWindow.length
    ? args.rollingWindow.map((t) => `- ${t}`).join('\n')
    : '(empty)';
  const user = [
    '## Retrieved memory',
    context,
    '',
    '## Recent conversation',
    recent,
    '',
    '## Question',
    args.probe,
  ].join('\n');
  return [
    { role: 'system', content: SYSTEM_SKELETON },
    { role: 'user', content: user },
  ];
}

export interface AnswerResult {
  answer: string;
  tokens: number;
  latencyMs: number;
}

export class AnswerLlm {
  constructor(private cfg: AnswerLlmConfig) {}

  /** The model id this answer LLM is configured with (multi-model blocking). */
  get model(): string {
    return this.cfg.model;
  }

  async answer(args: BuildPromptArgs): Promise<AnswerResult> {
    const messages = buildMessages(args);
    const start = Date.now();
    const res = await this.cfg.provider.chat({
      model: this.cfg.model,
      messages,
      temperature: this.cfg.temperature ?? 0,
      maxTokens: this.cfg.maxTokens ?? 256,
    });
    const latencyMs = Date.now() - start;
    return {
      answer: res.content ?? '',
      tokens: res.usage?.totalTokens ?? 0,
      latencyMs,
    };
  }
}
