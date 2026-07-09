import { loadEmbeddingPipeline } from './modelManager.js';
import { logger } from '../logger.js';

/**
 * Compute a sentence embedding for a piece of text using the multilingual
 * MiniLM model (mean-pooled + L2-normalized). Returns null if embeddings are
 * disabled or the model is unavailable.
 */
export async function embed(text: string): Promise<number[] | null> {
  const pipe = await loadEmbeddingPipeline();
  if (!pipe || text.trim().length === 0) return null;
  try {
    const output = (await pipe(text, { pooling: 'mean', normalize: true })) as {
      data?: Float32Array | number[];
    };
    const data = output?.data;
    if (!data) return null;
    return Array.from(data as ArrayLike<number>);
  } catch (err) {
    logger.warn('Embedding inference failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Serialize an embedding for storage in SQLite (JSON string). */
export function serializeEmbedding(vec: number[] | null): string | null {
  return vec ? JSON.stringify(vec) : null;
}

/** Parse a stored embedding back into a vector. */
export function parseEmbedding(json: string | null): number[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as number[]) : null;
  } catch {
    return null;
  }
}
