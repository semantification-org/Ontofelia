/**
 * Thrown when a query exceeds its deadline. Lives in its own module so adapters
 * can throw it without importing the executors (which import the adapters).
 */
export class QueryTimeoutError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`Query exceeded the time limit of ${deadlineMs} ms`);
    this.name = 'QueryTimeoutError';
  }
}
