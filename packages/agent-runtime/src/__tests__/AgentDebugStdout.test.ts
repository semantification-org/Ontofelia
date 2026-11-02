import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRuntime } from '../index.js';

// emitDebug is private and needs nothing from the constructor but the logger
// set, so the test builds a bare instance instead of a whole runtime.
function bareRuntime(): { emit: (phase: string, label: string, data?: unknown) => void; runtime: AgentRuntime } {
  const runtime = Object.create(AgentRuntime.prototype) as AgentRuntime;
  (runtime as unknown as { debugLoggers: Set<unknown> }).debugLoggers = new Set();
  const emit = (phase: string, label: string, data?: unknown): void =>
    (runtime as unknown as { emitDebug: (p: string, l: string, d?: unknown) => void }).emitDebug(phase, label, data);
  return { emit, runtime };
}

const SECRET_ARG = { name: 'probe_tool', args: { api_key: 'not-a-real-key-but-private' } };

describe('AgentRuntime debug events on stdout', () => {
  const saved = process.env.ONTOFELIA_AGENT_DEBUG;
  afterEach(() => {
    if (saved === undefined) delete process.env.ONTOFELIA_AGENT_DEBUG;
    else process.env.ONTOFELIA_AGENT_DEBUG = saved;
    vi.restoreAllMocks();
  });

  it('prints nothing without ONTOFELIA_AGENT_DEBUG, but still feeds registered loggers', () => {
    delete process.env.ONTOFELIA_AGENT_DEBUG;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { emit, runtime } = bareRuntime();
    const seen: unknown[] = [];
    runtime.onDebug((event) => seen.push(event.data));
    emit('tool_call', 'Tool: probe_tool', SECRET_ARG);
    expect(log).not.toHaveBeenCalled();
    expect(seen).toEqual([SECRET_ARG]);
  });

  it('prints the event with ONTOFELIA_AGENT_DEBUG=1', () => {
    process.env.ONTOFELIA_AGENT_DEBUG = '1';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    bareRuntime().emit('tool_call', 'Tool: probe_tool', SECRET_ARG);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toBe('[AgentDebug] tool_call: Tool: probe_tool');
  });
});
