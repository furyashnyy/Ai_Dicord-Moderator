import { loadToxicityPipeline } from './modelManager.js';
import { profanityMatches } from './lexicon.js';
import { logger } from '../logger.js';

export interface ToxicityResult {
  /** 0..1 overall toxicity score (max of model + lexicon signals). */
  score: number;
  /** Best-guess category label. */
  category: string;
  /** Raw per-label scores from the ML model, if available. */
  modelLabels: Record<string, number>;
  /** Distinct built-in profanity roots found by the lexicon. */
  lexiconMatches: string[];
  /** Whether the ML model contributed to this result. */
  usedModel: boolean;
}

// Labels that different toxicity models emit which we treat as "toxic".
const TOXIC_LABELS = new Set([
  'toxic',
  'toxicity',
  'severe_toxic',
  'severe_toxicity',
  'obscene',
  'threat',
  'insult',
  'identity_hate',
  'identity_attack',
  'hate',
  'offensive',
  'abusive',
  'negative',
  'label_1',
]);

interface RawLabel {
  label: string;
  score: number;
}

function coerceLabels(output: unknown): RawLabel[] {
  // text-classification pipelines may return an object, an array, or a nested
  // array depending on options. Flatten defensively.
  const flat: RawLabel[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
    } else if (v && typeof v === 'object' && 'label' in v && 'score' in v) {
      const rec = v as { label: unknown; score: unknown };
      if (typeof rec.label === 'string' && typeof rec.score === 'number') {
        flat.push({ label: rec.label, score: rec.score });
      }
    }
  };
  visit(output);
  return flat;
}

/**
 * Score a message for toxicity by combining the ML classifier (contextual
 * toxicity: sarcasm, threats, veiled insults) with the RU+EN lexicon (fast,
 * precise profanity detection incl. Russian mat). The final score is the max
 * of both signals, so each covers the other's blind spots.
 */
export async function scoreToxicity(text: string): Promise<ToxicityResult> {
  const lexicon = profanityMatches(text);

  const pipe = await loadToxicityPipeline();
  let modelScore = 0;
  let category = lexicon.matched.length > 0 ? 'profanity' : 'none';
  const modelLabels: Record<string, number> = {};
  let usedModel = false;

  if (pipe && text.trim().length > 0) {
    try {
      const out = await pipe(text, { topk: 0 });
      const labels = coerceLabels(out);
      usedModel = labels.length > 0;

      let bestToxic: RawLabel | null = null;
      for (const { label, score } of labels) {
        modelLabels[label] = score;
        const norm = label.toLowerCase();
        if (TOXIC_LABELS.has(norm)) {
          if (!bestToxic || score > bestToxic.score) bestToxic = { label: norm, score };
        }
      }
      if (bestToxic) {
        modelScore = bestToxic.score;
        if (bestToxic.score >= 0.5) category = mapCategory(bestToxic.label);
      }
    } catch (err) {
      logger.warn('Toxicity inference failed for a message:', err instanceof Error ? err.message : err);
    }
  }

  const score = Math.max(modelScore, lexicon.score);
  if (category === 'none' && score >= 0.5) category = 'toxic';

  return {
    score,
    category,
    modelLabels,
    lexiconMatches: lexicon.matched,
    usedModel,
  };
}

function mapCategory(label: string): string {
  switch (label) {
    case 'threat':
      return 'threat';
    case 'insult':
    case 'identity_hate':
    case 'identity_attack':
    case 'hate':
      return 'insult';
    case 'obscene':
      return 'obscenity';
    default:
      return 'toxic';
  }
}
