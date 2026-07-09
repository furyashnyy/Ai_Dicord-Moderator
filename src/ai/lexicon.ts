import {
  normalize,
  normalizeCompact,
  foldedNormalize,
  foldedCompact,
  tokens,
  stem,
} from '../util/text.js';

/**
 * RU + EN profanity/insult ROOTS used for the general-toxicity signal.
 *
 * IMPORTANT DESIGN NOTE: this list is NOT the source of truth for what gets
 * punished. The source of truth is always the guild's own rules channel.
 * This lexicon only produces a general "is this profanity/toxic" score which
 * a guild may optionally act on via `/moderation default-action`. On a server
 * where profanity is allowed, this score does nothing on its own.
 *
 * We match on roots (substring on a compacted, homoglyph-normalized string)
 * so inflected forms and light obfuscation are caught. Each entry is a
 * Cyrillic/Latin root already in normalized form.
 */
const PROFANITY_ROOTS: string[] = [
  // Russian mat — core roots and derivatives
  'хуй', 'хуе', 'хуё', 'хуя', 'хуи', 'хую', 'нахуй', 'похуй', 'охуе', 'охуи',
  'пизд', 'пезд', 'спизд', 'распизд',
  'ебат', 'ебан', 'ебал', 'ебуч', 'ебло', 'ебыр', 'выеб', 'заеб', 'наеб', 'уеб', 'разъеб',
  'еби', 'ебу', 'ёбан', 'ёбну', 'ебну',
  'бляд', 'блят', 'блях', 'блеад',
  'сука', 'суки', 'суче', 'сучк',
  'муда', 'мудак', 'мудил', 'мудо',
  'гандон', 'гондон',
  'залуп',
  'манда',
  'пидор', 'пидар', 'педик', 'пидр',
  'долбоеб', 'долбоёб', 'долбаеб',
  'уебок', 'уёбок', 'уебищ', 'уёбищ',
  'дебил', 'даун', 'кретин', 'идиот', 'тупиц', 'тупой', 'тупая',
  'гнида', 'мразь', 'ублюд', 'выродок', 'скотина', 'тварь',
  'шлюх', 'шалав', 'проститу',
  'хуесос', 'хуеплет', 'членосос',
  'ссан', 'обосра', 'насрать', 'говн', 'дерьм',
  'жоп', 'жопа',
  'петух', 'опущ',
  'чмо', 'чмошник',
  'козел', 'козёл', 'ущербн',
  'вонюч', 'урод',

  // English profanity / insults
  'fuck', 'fuk', 'fck', 'motherfuck', 'fucker', 'fucking',
  'shit', 'bullshit', 'bitch', 'bastard', 'asshole', 'arsehole',
  'cunt', 'dick', 'cock', 'pussy', 'whore', 'slut',
  'faggot', 'fag', 'nigger', 'nigga', 'retard', 'retarded',
  'idiot', 'moron', 'dumbass', 'jackass', 'douche', 'scumbag',
  'wanker', 'twat', 'prick', 'jerk',
];

/**
 * Whole-word exact insults (matched on tokens, not substring) to avoid the
 * "Scunthorpe problem" for short English words that appear inside innocent
 * words (e.g. "ass" in "class", "hell" in "shell").
 */
const PROFANITY_EXACT: string[] = [
  'ass', 'hell', 'damn', 'crap', 'suck', 'gay', 'хер', 'херня', 'фигня',
];

export interface LexiconMatch {
  matched: string[];
  /** 0..1 crude score derived from how many distinct roots matched. */
  score: number;
}

/**
 * Detect built-in profanity in a message. Substring roots are matched against
 * a compacted (spaceless, homoglyph-folded) form; short words are matched
 * exactly against tokens.
 */
export function profanityMatches(text: string): LexiconMatch {
  const compact = normalizeCompact(text); // English + Russian, no folding
  const folded = foldedCompact(text); // cross-script obfuscation folded to Cyrillic
  const tokenSet = new Set(tokens(text));

  const matched = new Set<string>();

  for (const root of PROFANITY_ROOTS) {
    if (root.length === 0) continue;
    if (compact.includes(root) || folded.includes(root)) matched.add(root);
  }
  for (const word of PROFANITY_EXACT) {
    if (tokenSet.has(word)) matched.add(word);
  }

  const count = matched.size;
  // Saturating score: 1 hit ≈ 0.6, 2 ≈ 0.8, 3+ ≈ ~0.9+.
  const score = count === 0 ? 0 : Math.min(1, 0.6 + 0.2 * (count - 1));
  return { matched: [...matched], score };
}

/**
 * Match an arbitrary list of explicit keywords/phrases (as written by a server
 * owner in a rule) against a message. This is the "fast pass" of the checker.
 *
 * Matching strategy per keyword:
 *  - Multi-word phrase → normalized substring match (also on the compacted
 *    form to defeat spacing obfuscation).
 *  - Single word → exact token match OR stemmed token match OR, for longer
 *    keywords (len ≥ 4), compacted substring match (to catch inflection +
 *    light obfuscation) — while staying strict enough for short words.
 */
export function matchKeywords(text: string, keywords: string[]): string[] {
  if (keywords.length === 0) return [];

  const normText = normalize(text);
  const foldedText = foldedNormalize(text);
  const compactText = normalizeCompact(text);
  const foldedCompactText = foldedCompact(text);

  const toks = tokens(text);
  const foldedToks = foldedNormalize(text).split(' ').filter((t) => t.length > 0);
  const tokenSet = new Set([...toks, ...foldedToks]);
  const stemmedTokens = new Set([...toks, ...foldedToks].map(stem));

  const matched = new Set<string>();

  for (const rawKw of keywords) {
    // Match each keyword under both its plain and folded normalization, so a
    // Cyrillic keyword catches Latin-obfuscated text and vice-versa.
    const kw = normalize(rawKw);
    const kwFolded = foldedNormalize(rawKw);
    if (kw.length === 0 && kwFolded.length === 0) continue;

    const forms = new Set([kw, kwFolded].filter((k) => k.length > 0));
    let hit = false;

    for (const form of forms) {
      if (form.includes(' ')) {
        // Phrase match.
        const compactForm = form.replace(/\s+/g, '');
        if (
          normText.includes(form) ||
          foldedText.includes(form) ||
          compactText.includes(compactForm) ||
          foldedCompactText.includes(compactForm)
        ) {
          hit = true;
          break;
        }
        continue;
      }
      // Single-word keyword.
      if (tokenSet.has(form) || stemmedTokens.has(stem(form))) {
        hit = true;
        break;
      }
      if (form.length >= 4 && (compactText.includes(form) || foldedCompactText.includes(form))) {
        hit = true;
        break;
      }
    }

    if (hit) matched.add(rawKw);
  }

  return [...matched];
}
