import type { GuildConfig } from '@prisma/client';
import { matchKeywords } from '../ai/lexicon.js';
import { scoreToxicity, type ToxicityResult } from '../ai/toxicity.js';
import { embed, cosineSimilarity } from '../ai/embeddings.js';
import type { RuleView } from '../rules/ruleService.js';
import type { PunishmentType } from '../rules/parser.js';

export type MatchType = 'keyword' | 'semantic' | 'default' | 'none';

export interface CheckDecision {
  /** The rule-specified action, or null meaning "resolve via default/escalation". */
  ruleAction: PunishmentType | null;
  ruleDuration: number | null;
  matchedRule: RuleView | null;
  matchType: MatchType;
  matchedKeywords: string[];
  similarity: number;
  toxicity: ToxicityResult | null;
  reason: string;
  /** True if anything actionable was found. */
  violation: boolean;
}

const NO_VIOLATION: CheckDecision = {
  ruleAction: null,
  ruleDuration: null,
  matchedRule: null,
  matchType: 'none',
  matchedKeywords: [],
  similarity: 0,
  toxicity: null,
  reason: 'No rule matched.',
  violation: false,
};

/**
 * Core moderation decision for a single message.
 *
 * Pipeline (see task spec §3):
 *   1. Fast pass — explicit keyword match against each rule.
 *   2. AI pass — toxicity classifier + semantic (embedding) match to the most
 *      relevant rule above its similarity threshold.
 *   3. Fallback — if no specific rule matched but general toxicity is high, the
 *      guild's configurable default action applies (source of truth is still
 *      the rules: this only fires when the guild opted in).
 */
export async function checkMessage(
  text: string,
  rules: RuleView[],
  guild: GuildConfig,
): Promise<CheckDecision> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return NO_VIOLATION;

  // ── 1. Fast keyword pass ──────────────────────────────────────────────
  for (const rule of rules) {
    const hits = matchKeywords(trimmed, rule.keywords);
    if (hits.length > 0) {
      return {
        ruleAction: rule.punishmentType,
        ruleDuration: rule.punishmentDuration,
        matchedRule: rule,
        matchType: 'keyword',
        matchedKeywords: hits,
        similarity: 1,
        toxicity: null,
        reason: `Matched forbidden keyword(s): ${hits.join(', ')}`,
        violation: true,
      };
    }
  }

  // ── 2. AI pass ────────────────────────────────────────────────────────
  const toxicity = await scoreToxicity(trimmed);

  // Semantic match against rules.
  let bestRule: RuleView | null = null;
  let bestSim = 0;
  const rulesWithEmbedding = rules.filter((r) => r.embedding && r.embedding.length > 0);
  if (rulesWithEmbedding.length > 0) {
    const msgVec = await embed(trimmed);
    if (msgVec) {
      for (const rule of rulesWithEmbedding) {
        const sim = cosineSimilarity(msgVec, rule.embedding as number[]);
        const threshold = rule.similarityThreshold ?? guild.similarityThreshold;
        if (sim >= threshold && sim > bestSim) {
          bestSim = sim;
          bestRule = rule;
        }
      }
    }
  }

  if (bestRule) {
    // A specific rule is semantically implicated. We still gate on some signal
    // of actual toxicity so that merely *discussing* a topic (high similarity,
    // zero toxicity) does not trigger punishment — unless the rule itself
    // carries explicit keywords intent. Use a soft floor.
    const toxicSignal = toxicity.score;
    const rule = bestRule;
    // Require either a meaningful toxicity signal OR a very strong semantic hit.
    if (toxicSignal >= 0.4 || bestSim >= Math.min(0.75, (rule.similarityThreshold ?? guild.similarityThreshold) + 0.15)) {
      return {
        ruleAction: rule.punishmentType,
        ruleDuration: rule.punishmentDuration,
        matchedRule: rule,
        matchType: 'semantic',
        matchedKeywords: [],
        similarity: bestSim,
        toxicity,
        reason: `Semantically matched rule #${rule.id} (similarity ${bestSim.toFixed(2)}, toxicity ${toxicSignal.toFixed(2)}).`,
        violation: true,
      };
    }
  }

  // ── 3. Default-action fallback for high general toxicity ──────────────
  if (guild.defaultAction !== 'ignore' && toxicity.score >= guild.toxicityThreshold) {
    return {
      ruleAction: guild.defaultAction as PunishmentType, // "warn" | "delete"
      ruleDuration: null,
      matchedRule: null,
      matchType: 'default',
      matchedKeywords: toxicity.lexiconMatches,
      similarity: bestSim,
      toxicity,
      reason: `High general toxicity (${toxicity.score.toFixed(2)}, ${toxicity.category}) with no specific rule; applying guild default action.`,
      violation: true,
    };
  }

  return { ...NO_VIOLATION, toxicity, similarity: bestSim };
}
