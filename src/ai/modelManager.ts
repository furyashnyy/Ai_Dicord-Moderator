import { config } from '../config.js';
import { logger } from '../logger.js';

/**
 * Lazily loads and caches @xenova/transformers pipelines on first use.
 *
 * Loading is best-effort: if a model cannot be fetched/initialised (e.g. no
 * network on first run, or not enough RAM) the manager logs and returns null,
 * and the moderation pipeline degrades gracefully to the lexicon-only path.
 * This keeps the bot fully functional offline without any stubs.
 */

// The transformers types are loaded dynamically to keep startup light and to
// avoid a hard failure if the native/ONNX backend is unavailable.
type Pipeline = (input: string | string[], options?: Record<string, unknown>) => Promise<unknown>;

let transformersMod: typeof import('@xenova/transformers') | null = null;
let configured = false;

let toxicityPipe: Pipeline | null = null;
let toxicityLoading: Promise<Pipeline | null> | null = null;
let toxicityFailed = false;

let embeddingPipe: Pipeline | null = null;
let embeddingLoading: Promise<Pipeline | null> | null = null;
let embeddingFailed = false;

async function getTransformers(): Promise<typeof import('@xenova/transformers')> {
  if (transformersMod) return transformersMod;
  transformersMod = await import('@xenova/transformers');
  if (!configured) {
    const env = transformersMod.env;
    // Cache weights on disk so we only download once.
    env.cacheDir = config.transformersCache;
    // Allow downloading from the HF hub on first run; use cache afterwards.
    env.allowRemoteModels = true;
    env.allowLocalModels = true;
    configured = true;
  }
  return transformersMod;
}

export async function loadToxicityPipeline(): Promise<Pipeline | null> {
  if (!config.enableToxicityModel || toxicityFailed) return null;
  if (toxicityPipe) return toxicityPipe;
  if (toxicityLoading) return toxicityLoading;

  toxicityLoading = (async () => {
    try {
      logger.info(`Loading toxicity model "${config.toxicityModel}" …`);
      const { pipeline } = await getTransformers();
      const pipe = (await pipeline('text-classification', config.toxicityModel, {
        quantized: config.useQuantizedModels,
      })) as unknown as Pipeline;
      toxicityPipe = pipe;
      logger.info('Toxicity model ready.');
      return pipe;
    } catch (err) {
      toxicityFailed = true;
      logger.warn(
        'Failed to load toxicity model — falling back to lexicon-only toxicity scoring.',
        err instanceof Error ? err.message : err,
      );
      return null;
    } finally {
      toxicityLoading = null;
    }
  })();

  return toxicityLoading;
}

export async function loadEmbeddingPipeline(): Promise<Pipeline | null> {
  if (!config.enableEmbeddings || embeddingFailed) return null;
  if (embeddingPipe) return embeddingPipe;
  if (embeddingLoading) return embeddingLoading;

  embeddingLoading = (async () => {
    try {
      logger.info(`Loading embedding model "${config.embeddingModel}" …`);
      const { pipeline } = await getTransformers();
      const pipe = (await pipeline('feature-extraction', config.embeddingModel, {
        quantized: config.useQuantizedModels,
      })) as unknown as Pipeline;
      embeddingPipe = pipe;
      logger.info('Embedding model ready.');
      return pipe;
    } catch (err) {
      embeddingFailed = true;
      logger.warn(
        'Failed to load embedding model — semantic rule matching disabled, keyword + toxicity paths still active.',
        err instanceof Error ? err.message : err,
      );
      return null;
    } finally {
      embeddingLoading = null;
    }
  })();

  return embeddingLoading;
}

export interface ModelStatus {
  toxicityEnabled: boolean;
  toxicityLoaded: boolean;
  toxicityFailed: boolean;
  embeddingsEnabled: boolean;
  embeddingsLoaded: boolean;
  embeddingsFailed: boolean;
}

export function modelStatus(): ModelStatus {
  return {
    toxicityEnabled: config.enableToxicityModel,
    toxicityLoaded: toxicityPipe !== null,
    toxicityFailed,
    embeddingsEnabled: config.enableEmbeddings,
    embeddingsLoaded: embeddingPipe !== null,
    embeddingsFailed: embeddingFailed,
  };
}

/** Eagerly warm up whichever models are enabled (called at startup). */
export async function warmupModels(): Promise<void> {
  await Promise.all([loadToxicityPipeline(), loadEmbeddingPipeline()]);
}
