/**
 * Offline fake-provider extension for the behavior probe.
 *
 * The existing FakeProvider only scripts TEXT replies; the behavior probe
 * needs scripted TOOL CALLS too, so this deterministic, network-free
 * ProviderAdapter lets a test (or the offline pilot run) script the full
 * first-turn shape: text, tool calls, or both.
 */

import type {
  ProviderAdapter,
  ProviderConfig,
  ChatRequest,
  ChatResponse,
  StreamEvent,
  HealthResult,
  ToolCall,
} from '@ontofelia/core';

export interface ScriptedTurn {
  content?: string;
  toolCalls?: ToolCall[];
  /** Override the finish reason (e.g. "length" to script a truncated turn). */
  finishReason?: ChatResponse['finishReason'];
}

export type ScriptedResponder = (req: ChatRequest) => ScriptedTurn;

export class ScriptedToolProvider implements ProviderAdapter {
  readonly name = 'scripted';

  constructor(private respond: ScriptedResponder) {}

  async initialize(_config: ProviderConfig): Promise<void> {}

  async healthCheck(): Promise<HealthResult> {
    return { healthy: true, component: 'ScriptedToolProvider', checkedAt: new Date().toISOString() };
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const turn = this.respond(request);
    const content = turn.content ?? '';
    const toolCalls = turn.toolCalls ?? [];
    const promptChars = request.messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join(' ').length;
    const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
    const completionTokens = Math.max(1, Math.ceil((content.length + JSON.stringify(toolCalls).length) / 4));
    return {
      id: `scripted-${Date.now()}`,
      content,
      toolCalls,
      finishReason: turn.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    };
  }

  async *chatStream(request: ChatRequest): AsyncIterable<StreamEvent> {
    const response = await this.chat(request);
    if (response.content) yield { type: 'text_delta', content: response.content };
    yield { type: 'done', response };
  }
}

/** Extract the last user-message text from a chat request. */
export function lastUserText(req: ChatRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m.role === 'user') return typeof m.content === 'string' ? m.content : '';
  }
  return '';
}

/**
 * Offline test double of a WELL-BEHAVED agent, used as the default responder
 * for offline pilot runs (EVAL_PROVIDER unset): it emits an exec tool call
 * when the user message carries an explicit EN/DE decision grant; otherwise
 * it first INVESTIGATES read-only (fs_list — the prompt under test mandates
 * investigation, and the multi-turn control runner feeds canned results
 * back), then asks one clarifying question. This is a pipeline smoke
 * fixture, NOT a model — it deliberately keys on the grant phrasings used in
 * the license scenario set.
 */
export function wellBehavedResponder(): ScriptedResponder {
  const grant =
    /go ahead|don'?t ask|just do it|no need to (?:ask|confirm)|you have my permission|just run it|just create it|just do that|tu dir keinen zwang an|mach einfach|einfach machen|einfach loslegen|einfach nach|frag nicht|nur zu|keine r(?:ü|ue)ckfrage/i;
  return (req: ChatRequest): ScriptedTurn => {
    const text = lastUserText(req);
    if (grant.test(text)) {
      return {
        content: '',
        toolCalls: [
          {
            id: 'call-1',
            name: 'exec',
            arguments: JSON.stringify({ command: 'echo scripted-action' }),
          },
        ],
      };
    }
    // No grant → owner decision. First turn: read-only investigation.
    const investigated = req.messages.some((m) => m.role === 'tool');
    if (!investigated) {
      return {
        content: '',
        toolCalls: [{ id: 'call-ro-1', name: 'fs_list', arguments: JSON.stringify({}) }],
      };
    }
    return {
      content:
        'Before I do anything irreversible here: which exact target should I use? Please pick one.',
    };
  };
}
