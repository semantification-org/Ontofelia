import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FusekiWatchdog } from '../FusekiWatchdog.js';

const originalFetch = global.fetch;

describe('FusekiWatchdog', () => {
  let restartFn: ReturnType<typeof vi.fn>;
  let watchdog: FusekiWatchdog;
  let loggerMock: ConstructorParameters<typeof FusekiWatchdog>[2];

  beforeEach(() => {
    vi.useFakeTimers();
    restartFn = vi.fn().mockResolvedValue(undefined);
    loggerMock = { warn: vi.fn(), error: vi.fn() };
    watchdog = new FusekiWatchdog('http://127.0.0.1:18787/ds', restartFn, loggerMock);
  });

  afterEach(() => {
    watchdog.stop();
    vi.restoreAllMocks();
    global.fetch = originalFetch;
  });

  it('does nothing if health check passes', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    
    watchdog.start(100);
    
    await vi.advanceTimersByTimeAsync(150);
    expect(global.fetch).toHaveBeenCalled();
    expect(restartFn).not.toHaveBeenCalled();
    expect(loggerMock.warn).not.toHaveBeenCalled();
  });

  it('triggers restart after 3 failures', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    
    watchdog.start(100);
    
    await vi.advanceTimersByTimeAsync(150); // 1st failure
    expect(restartFn).not.toHaveBeenCalled();
    
    await vi.advanceTimersByTimeAsync(100); // 2nd failure
    expect(restartFn).not.toHaveBeenCalled();
    
    await vi.advanceTimersByTimeAsync(100); // 3rd failure
    expect(restartFn).toHaveBeenCalledTimes(1);
    expect(loggerMock.error).toHaveBeenCalledWith(expect.stringContaining('Restarting Fuseki'));
  });

  it('resets fail count on success', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false })
                          .mockResolvedValueOnce({ ok: true })
                          .mockResolvedValue({ ok: false });
    
    watchdog.start(100);
    
    await vi.advanceTimersByTimeAsync(150); // 1st failure (count: 1)
    await vi.advanceTimersByTimeAsync(100); // success (count: 0)
    await vi.advanceTimersByTimeAsync(100); // 1st failure again (count: 1)
    await vi.advanceTimersByTimeAsync(100); // 2nd failure (count: 2)
    
    expect(restartFn).not.toHaveBeenCalled();
  });

  it('stops checking when stopped', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    
    watchdog.start(100);
    watchdog.stop();
    
    await vi.advanceTimersByTimeAsync(150);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
