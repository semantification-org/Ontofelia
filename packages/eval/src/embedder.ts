/**
 * Embedder abstraction (spec §4).
 *
 * - {@link OfflineHashingEmbedder} — deterministic bag-of-words / hashing vector,
 *   no network. Default whenever no embeddings endpoint is configured, so build +
 *   smoke pass in CI.
 * - {@link OpenAICompatibleEmbedder} — thin client for an OpenAI-compatible
 *   `/v1/embeddings` endpoint (real runs).
 */

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  readonly dim: number;
}

const TOKEN_RE = /[a-z0-9]+/g;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

/** FNV-1a 32-bit hash — deterministic, no deps. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic hashing / bag-of-words embedder. Each token is hashed into a
 * bucket of a fixed-dimension vector with a signed contribution; the vector is
 * L2-normalised so cosine similarity is well-behaved. Purely offline.
 */
export class OfflineHashingEmbedder implements Embedder {
  readonly dim: number;

  constructor(dim = 256) {
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): number[] {
    const v = new Array<number>(this.dim).fill(0);
    for (const tok of tokenize(text)) {
      const h = fnv1a(tok);
      const bucket = h % this.dim;
      const sign = (h & 1) === 0 ? 1 : -1;
      v[bucket] += sign;
    }
    // L2 normalise
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm);
    if (norm === 0) return v;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  }
}

export interface OpenAICompatibleEmbedderConfig {
  baseUrl: string; // e.g. https://api.openai.com/v1  (the /embeddings path is appended)
  apiKey?: string;
  model: string;
  dim?: number;
}

/** Thin OpenAI-compatible `/v1/embeddings` client (real runs only). */
export class OpenAICompatibleEmbedder implements Embedder {
  readonly dim: number;
  private cfg: OpenAICompatibleEmbedderConfig;

  constructor(cfg: OpenAICompatibleEmbedderConfig) {
    this.cfg = cfg;
    this.dim = cfg.dim ?? 1536;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const url = this.cfg.baseUrl.replace(/\/$/, '') + '/embeddings';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.cfg.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`Embeddings request failed: ${res.status} ${await res.text()}`);
    }
    const json = (await res.json()) as { data: Array<{ embedding: number[] }> };
    return json.data.map((d) => d.embedding);
  }
}

/** Cosine similarity of two equal-length vectors. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
