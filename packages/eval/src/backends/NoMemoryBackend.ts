import type { MemoryBackend, IngestTurn, RetrievedContext } from '../types.js';

/**
 * Condition C (spec §2-C): no persistence. Ingest is a no-op, retrieve returns
 * the empty string. Long scenarios overflow the rolling context window → this
 * isolates the contribution of persistence itself.
 */
export class NoMemoryBackend implements MemoryBackend {
  readonly name = 'no-memory' as const;

  async reset(): Promise<void> {
    /* nothing to reset */
  }

  async ingest(_turn: IngestTurn): Promise<void> {
    /* no-op */
  }

  async retrieve(_query: string): Promise<RetrievedContext> {
    return { text: '', meta: { backend: 'no-memory' } };
  }
}
