/** The part of the running gateway (a Fastify instance) the shutdown needs. */
export interface Closable {
  close(): Promise<unknown>;
}

export interface ShutdownDeps {
  removePid: () => Promise<void>;
  exit: (code: number) => void;
  /** Registers the handler for a signal; the caller passes `process.on`. */
  on: (signal: 'SIGINT' | 'SIGTERM', handler: () => void) => void;
  /** Receives a message when closing the gateway failed or timed out. */
  onError?: (message: string) => void;
  /** Upper bound for closing the gateway, so a hung close cannot block exit. Default 10 s. */
  timeoutMs?: number;
}

export interface ShutdownHandle {
  /** Hands over the started gateway; signals before this only remove the pid file and exit. */
  setApp: (app: Closable) => void;
  /** The handler registered for SIGINT and SIGTERM. */
  shutdown: () => Promise<void>;
}

/**
 * Registers SIGINT/SIGTERM handlers that close the gateway (which stops the
 * triplestore and flushes it to disk), then remove the pid file and exit.
 * A second signal while the first is being handled does nothing.
 */
export function installShutdownHandlers(deps: ShutdownDeps): ShutdownHandle {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  let app: Closable | undefined;
  let running = false;

  const shutdown = async (): Promise<void> => {
    if (running) return;
    running = true;
    if (app) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      try {
        const result = await Promise.race([app.close().then(() => 'closed' as const), timedOut]);
        if (result === 'timeout') deps.onError?.(`Gateway close did not finish within ${timeoutMs} ms; exiting anyway`);
      } catch (e) {
        deps.onError?.(`Gateway close failed: ${(e as Error).message}`);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    try {
      await deps.removePid();
    } finally {
      deps.exit(0);
    }
  };

  deps.on('SIGINT', shutdown);
  deps.on('SIGTERM', shutdown);
  return { setApp: a => { app = a; }, shutdown };
}
