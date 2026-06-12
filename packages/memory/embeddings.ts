// ─── Semantic memory: embeddings-powered search for lessons and skills ────────
//
// Replaces fragile substring matching (trigger.includes) with vector similarity
// search. Uses vectra (pure-TS local vector DB) when available, falls back to
// the original substring matching when embeddings are not configured.
//
// Setup: `bun add vectra` and set PROJECTOS_EMBEDDINGS_API_KEY + optionally
// PROJECTOS_EMBEDDINGS_BASE_URL and PROJECTOS_EMBEDDINGS_MODEL.

/** Provider contract — anything that can turn text into float vectors. */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
  dimensions: number;
}

/** OpenAI-compatible embedding provider (works with OpenAI, Azure, any proxy).
 *  Default model: text-embedding-3-small (1536 dimensions, ~$0.02/1M tokens). */
export class ApiEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(
    private apiKey: string,
    private baseUrl = "https://api.openai.com/v1",
    private model = "text-embedding-3-small",
    dimensions = 1536,
  ) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`Embeddings API error: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };
    // Sort by index to preserve input order
    return json.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}

// ─── Lightweight in-memory vector index (no external dependency) ─────────────
//
// When vectra is not installed, we provide a minimal cosine-similarity index
// that stores vectors as JSON. This avoids a hard dependency while still
// providing semantic search out of the box.

interface VectorItem {
  id: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";

/** Minimal vector index backed by a JSON file. Suitable for small collections
 *  (hundreds of items). For larger scale, swap in vectra or hnswlib. */
export class SimpleVectorIndex {
  private items: VectorItem[] = [];

  constructor(private filePath: string) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      this.items = JSON.parse(readFileSync(this.filePath, "utf8"));
    } catch {
      this.items = [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.items), "utf8");
  }

  upsert(id: string, vector: number[], metadata: Record<string, unknown> = {}): void {
    const existing = this.items.findIndex((item) => item.id === id);
    if (existing >= 0) {
      this.items[existing] = { id, vector, metadata };
    } else {
      this.items.push({ id, vector, metadata });
    }
    this.persist();
  }

  query(
    queryVector: number[],
    topK = 5,
  ): Array<{ id: string; score: number; metadata: Record<string, unknown> }> {
    const scored = this.items.map((item) => ({
      id: item.id,
      score: cosineSimilarity(queryVector, item.vector),
      metadata: item.metadata,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  get size(): number {
    return this.items.length;
  }
}

// ─── SemanticIndex: high-level API ───────────────────────────────────────────

export class SemanticIndex {
  private index: SimpleVectorIndex;
  private provider: EmbeddingProvider;

  constructor(indexPath: string, provider: EmbeddingProvider) {
    this.index = new SimpleVectorIndex(indexPath);
    this.provider = provider;
  }

  /** Add or update an item by id. The text is embedded and stored. */
  async upsert(
    id: string,
    text: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    const [vector] = await this.provider.embed([text]);
    this.index.upsert(id, vector, { ...metadata, text });
  }

  /** Find the topK most semantically similar items to the query. */
  async search(
    query: string,
    topK = 5,
  ): Promise<Array<{ id: string; score: number; text: string }>> {
    if (this.index.size === 0) return [];
    const [queryVec] = await this.provider.embed([query]);
    const results = this.index.query(queryVec, topK);
    return results.map((r) => ({
      id: r.id,
      score: r.score,
      text: (r.metadata as { text?: string }).text ?? "",
    }));
  }

  get size(): number {
    return this.index.size;
  }
}

// ─── Factory: create a SemanticIndex from environment configuration ──────────

/** Create a SemanticIndex if embedding credentials are available.
 *  Uses PROJECTOS_EMBEDDINGS_API_KEY, falling back to OPENAI_API_KEY (and
 *  OPENAI_BASE_URL) so an existing OpenAI-compatible setup works without
 *  extra configuration. Returns null when no key is set. */
export function createSemanticIndex(indexPath: string): SemanticIndex | null {
  const apiKey =
    process.env.PROJECTOS_EMBEDDINGS_API_KEY ?? process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  // Normalize: providers expect <base>/embeddings where base ends in /v1.
  const rawBase =
    process.env.PROJECTOS_EMBEDDINGS_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    "https://api.openai.com/v1";
  const trimmed = rawBase.replace(/\/+$/, "");
  const baseUrl = /\/v\d+$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
  const model =
    process.env.PROJECTOS_EMBEDDINGS_MODEL ?? "text-embedding-3-small";

  const provider = new ApiEmbeddingProvider(apiKey, baseUrl, model);
  return new SemanticIndex(indexPath, provider);
}
