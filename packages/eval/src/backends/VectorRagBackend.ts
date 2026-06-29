import type { MemoryBackend, IngestTurn, RetrievedContext } from '../types.js';
import { type Embedder, OfflineHashingEmbedder, cosine } from '../embedder.js';

interface Chunk {
  text: string;
  ts: string;
  sourceTurnId: string;
  speaker: 'user' | 'agent';
  /** Monotonic insertion order, used for newest-first tiebreak. */
  seq: number;
  embedding: number[];
}

export interface VectorRagOptions {
  /** top-k chunks returned (default 5; tune on a dev split, never on test). */
  k?: number;
  embedder?: Embedder;
}

/**
 * Condition B (spec §2-B): the FAIR baseline.
 *
 * - ingest: store the turn's NL text as a chunk WITH timestamp + source-turn
 *   metadata, so H4 provenance is answerable in principle from chunk metadata
 *   (not rigged against the baseline).
 * - retrieve: embed the query, cosine top-k over chunks, newest-first tiebreak,
 *   return concatenated chunks.
 */
export class VectorRagBackend implements MemoryBackend {
  readonly name = 'vector-rag' as const;
  private chunks: Chunk[] = [];
  private seq = 0;
  private readonly k: number;
  private readonly embedder: Embedder;

  constructor(opts: VectorRagOptions = {}) {
    this.k = opts.k ?? 5;
    this.embedder = opts.embedder ?? new OfflineHashingEmbedder();
  }

  async reset(): Promise<void> {
    this.chunks = [];
    this.seq = 0;
  }

  async ingest(turn: IngestTurn): Promise<void> {
    const [embedding] = await this.embedder.embed([turn.text]);
    this.chunks.push({
      text: turn.text,
      ts: turn.ts,
      sourceTurnId: turn.id,
      speaker: turn.speaker,
      seq: this.seq++,
      embedding,
    });
  }

  async retrieve(query: string): Promise<RetrievedContext> {
    if (this.chunks.length === 0) {
      return { text: '', meta: { backend: 'vector-rag', k: this.k, hits: 0 } };
    }
    const [q] = await this.embedder.embed([query]);
    const scored = this.chunks.map((c) => ({ c, sim: cosine(q, c.embedding) }));
    // Sort by similarity desc, newest-first (higher seq) tiebreak.
    scored.sort((a, b) => (b.sim - a.sim) || (b.c.seq - a.c.seq));
    const top = scored.slice(0, this.k);

    const lines = top.map(
      ({ c, sim }) =>
        `- [${c.sourceTurnId} @ ${c.ts}] (${c.speaker}) ${c.text} (sim=${sim.toFixed(3)})`,
    );
    return {
      text: lines.join('\n'),
      meta: {
        backend: 'vector-rag',
        k: this.k,
        hits: top.length,
        sources: top.map(({ c }) => ({ id: c.sourceTurnId, ts: c.ts })),
      },
    };
  }
}
