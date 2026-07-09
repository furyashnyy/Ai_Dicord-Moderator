/**
 * Text-normalization helpers shared by the lexicon matcher and the rule
 * keyword matcher. The goal is to defeat the common obfuscations people use
 * to slip profanity past filters (leetspeak, Latin/Cyrillic homoglyphs,
 * character repetition, inserted punctuation) while keeping RU + EN intact.
 */

// Latin letters that are visually identical to Cyrillic ones, plus a few
// digit/symbol substitutions used as leetspeak. Everything maps toward the
// Cyrillic form when ambiguous so RU profanity written with Latin look-alikes
// ("xyй", "cyka") still normalizes to its Cyrillic root.
const HOMOGLYPHS: Record<string, string> = {
  a: 'а',
  e: 'е',
  o: 'о',
  p: 'р',
  c: 'с',
  y: 'у',
  x: 'х',
  k: 'к',
  m: 'м',
  t: 'т',
  h: 'н',
  b: 'в',
  '3': 'з',
  '0': 'о',
  '4': 'ч',
  '@': 'а',
  $: 'с',
  '!': 'и',
  '1': 'и',
};

/**
 * Base normalization: lowercase, strip diacritics, fold ё→е, keep only
 * letters (Latin + Cyrillic) and spaces, and collapse 3+ repeated chars.
 *
 * NOTE: this does NOT apply homoglyph folding, so genuine English and genuine
 * Russian text are both preserved as-is. Cross-script obfuscation is handled
 * separately via `foldHomoglyphs`, and callers match against BOTH forms so
 * neither language's matching is corrupted by the other's look-alikes.
 */
export function normalize(input: string): string {
  let s = input.toLowerCase();
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, ''); // strip combining marks
  s = s.replace(/ё/g, 'е');

  // Keep only letters (Latin + Cyrillic) and whitespace.
  s = s.replace(/[^a-zа-я\s]/g, ' ');

  // Collapse runs of 3+ identical chars ("бляяяять" -> "бляять").
  s = s.replace(/(.)\1{2,}/g, '$1');

  // Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Aggressive homoglyph / leetspeak folding: lowercase then map Latin letters,
 * digits and symbols toward their Cyrillic look-alikes BEFORE stripping, so
 * cross-script obfuscation like "xyecoc" or "п3тух" collapses onto the Cyrillic
 * root. Genuine English words get mangled here (that's fine — callers also
 * match the un-folded `normalize` form, so English still matches there).
 */
export function foldedNormalize(input: string): string {
  let s = input.toLowerCase();
  s = s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/ё/g, 'е');

  let mapped = '';
  for (const ch of s) {
    mapped += HOMOGLYPHS[ch] ?? ch;
  }
  s = mapped;

  s = s.replace(/[^a-zа-я\s]/g, ' ');
  s = s.replace(/(.)\1{2,}/g, '$1');
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/** Base-normalized text with ALL spaces removed (catches "с у к а" spacing). */
export function normalizeCompact(input: string): string {
  return normalize(input).replace(/\s+/g, '');
}

/** Aggressively-folded text with ALL spaces removed. */
export function foldedCompact(input: string): string {
  return foldedNormalize(input).replace(/\s+/g, '');
}

/** Split normalized text into word tokens. */
export function tokens(input: string): string[] {
  const n = normalize(input);
  return n.length === 0 ? [] : n.split(' ');
}

/**
 * Very small, dependency-free Russian/English "stemmer": strips the most
 * common inflectional endings so a keyword like "оскорбление" matches
 * "оскорбления"/"оскорблений". This is deliberately lightweight — it is only
 * used to make exact keyword matching a bit more forgiving, not for NLP.
 */
const RU_ENDINGS = [
  'ыми', 'ому', 'его', 'ому', 'ами', 'ями', 'ого', 'ему', 'ими',
  'ая', 'яя', 'ое', 'ее', 'ый', 'ий', 'ой', 'ем', 'им', 'ым', 'ух', 'ах', 'ях',
  'ов', 'ев', 'ью', 'ям', 'ам', 'ом', 'ет', 'ешь', 'ут', 'ют', 'ат', 'ят',
  'а', 'я', 'о', 'е', 'у', 'ю', 'ы', 'и', 'ь', 'й',
];
const EN_ENDINGS = ['ing', 'ers', 'ed', 'es', 'er', 's'];

export function stem(word: string): string {
  let w = word;
  if (/[а-я]/.test(w)) {
    for (const end of RU_ENDINGS) {
      if (w.length - end.length >= 3 && w.endsWith(end)) {
        return w.slice(0, -end.length);
      }
    }
    return w;
  }
  for (const end of EN_ENDINGS) {
    if (w.length - end.length >= 3 && w.endsWith(end)) {
      return w.slice(0, -end.length);
    }
  }
  return w;
}

/** Truncate a string for safe logging / embeds. */
export function truncate(input: string, max = 200): string {
  if (input.length <= max) return input;
  return input.slice(0, max - 1) + '…';
}
