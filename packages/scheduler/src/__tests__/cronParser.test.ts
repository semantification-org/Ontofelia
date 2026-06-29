import { describe, it, expect } from 'vitest';
// Import cron-parser exactly as JobScheduler does (default import). Regression
// guard for #994: cron-parser@4 is CommonJS, so `import * as` left
// `parseExpression` undefined ("is not a function") and every cron job failed.
import cronParser from 'cron-parser';

describe('cron-parser import (#994 regression)', () => {
  it('parseExpression is callable via the default import', () => {
    expect(typeof cronParser.parseExpression).toBe('function');
  });

  it('parses a daily cron and yields a future next run', () => {
    const interval = cronParser.parseExpression('0 3 * * *');
    const next = interval.next().toDate();
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });
});
