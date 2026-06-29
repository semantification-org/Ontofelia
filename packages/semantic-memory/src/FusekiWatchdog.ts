export class FusekiWatchdog {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private failCount = 0;
  private readonly maxFails = 3;
  private readonly checkIntervalMs = 30_000;

  constructor(
    private endpoint: string,
    private onRestart: () => Promise<void>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private logger?: any
  ) {}

  start(intervalMs = this.checkIntervalMs): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(() => this.check(), intervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  private async check(): Promise<void> {
    const isHealthy = await this.healthCheck();
    if (isHealthy) {
      this.failCount = 0;
    } else {
      await this.handleFailure();
    }
  }

  private async healthCheck(): Promise<boolean> {
    try {
      // Create ping endpoint URL from endpoint (which is usually http://127.0.0.1:18787/ds)
      const baseUrl = new URL(this.endpoint).origin;
      const res = await fetch(`${baseUrl}/$/ping`, {
        signal: AbortSignal.timeout(5000)
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  private async handleFailure(): Promise<void> {
    this.failCount++;
    if (this.logger) this.logger.warn(`[FusekiWatchdog] Health check failed (${this.failCount}/${this.maxFails})`);
    
    if (this.failCount >= this.maxFails) {
      if (this.logger) this.logger.error(`[FusekiWatchdog] Max failures reached. Restarting Fuseki...`);
      try {
        await this.onRestart();
        this.failCount = 0;
      } catch (err) {
        if (this.logger) this.logger.error(`[FusekiWatchdog] Restart failed: ${err}`);
      }
    }
  }
}
