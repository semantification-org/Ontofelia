import { afterEach, describe, expect, it, vi } from 'vitest';
import { installShutdownHandlers } from '../utils/shutdown.js';

function setup(timeoutMs?: number) {
  const handlers = new Map<string, () => void>();
  const order: string[] = [];
  const deps = {
    removePid: vi.fn(async () => { order.push('removePid'); }),
    exit: vi.fn((code: number) => { order.push(`exit(${code})`); }),
    on: (sig: 'SIGINT' | 'SIGTERM', h: () => void) => { handlers.set(sig, h); },
    onError: vi.fn(),
    timeoutMs,
  };
  const handle = installShutdownHandlers(deps);
  return { handlers, order, deps, handle };
}

describe('installShutdownHandlers', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers SIGINT and SIGTERM', () => {
    const { handlers } = setup();
    expect([...handlers.keys()].sort()).toEqual(['SIGINT', 'SIGTERM']);
  });

  it('closes the app once for two signals, then removes the pid and exits', async () => {
    const { handlers, order, handle } = setup();
    const close = vi.fn(async () => { order.push('close'); });
    handle.setApp({ close });
    const first = handlers.get('SIGTERM')!() as unknown as Promise<void>;
    const second = handlers.get('SIGINT')!() as unknown as Promise<void>;
    await Promise.all([first, second]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['close', 'removePid', 'exit(0)']);
  });

  it('only removes the pid and exits when the signal comes before the gateway started', async () => {
    const { order, handle } = setup();
    await handle.shutdown();
    expect(order).toEqual(['removePid', 'exit(0)']);
  });

  it('exits after the timeout when close never resolves', async () => {
    vi.useFakeTimers();
    const { order, deps, handle } = setup(10_000);
    handle.setApp({ close: () => new Promise(() => {}) });
    const done = handle.shutdown();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(deps.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(order).toEqual(['removePid', 'exit(0)']);
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('did not finish'));
  });

  it('still removes the pid and exits when close rejects', async () => {
    const { order, deps, handle } = setup();
    handle.setApp({ close: async () => { throw new Error('boom'); } });
    await handle.shutdown();
    expect(order).toEqual(['removePid', 'exit(0)']);
    expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  it('defaults the timeout to 10 s', async () => {
    vi.useFakeTimers();
    const { deps, handle } = setup();
    handle.setApp({ close: () => new Promise(() => {}) });
    const done = handle.shutdown();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(deps.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(deps.exit).toHaveBeenCalledWith(0);
  });
});
