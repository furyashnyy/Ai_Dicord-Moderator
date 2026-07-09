/**
 * Parses free-form rules-channel messages into structured rules.
 *
 * Owners write rules in wildly different formats (numbered lists, emoji
 * bullets, markdown headers, plain paragraphs), so the parser is heuristic and
 * forgiving. Anything it cannot confidently split still becomes a "general"
 * rule whose full text participates in semantic (embedding) matching. Owners
 * can always fix a bad parse via `/moderation rules edit`.
 */

export interface ParsedRule {
  rawText: string;
  keywords: string[];
  punishmentType: PunishmentType | null;
  punishmentDuration: number | null; // seconds
  sourceMessageId?: string;
}

export type PunishmentType = 'warn' | 'mute' | 'kick' | 'ban' | 'delete';

export interface SourceMessage {
  id: string;
  content: string;
}

// Leading list/heading markers: markdown headers, "1." / "1)", bullets, emoji.
const MARKER_RE =
  /^\s*(?:#{1,6}\s+|>+\s+|\d+\s*[.)]\s+|[-*+•·▪◦‣⁃–—]\s+|[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}✅❌⛔🚫]\s*)/u;

function stripMarker(line: string): string {
  return line.replace(MARKER_RE, '').trim();
}

function hasMarker(line: string): boolean {
  return MARKER_RE.test(line);
}

/** Split a single message's content into candidate rule blocks. */
function splitIntoBlocks(content: string): string[] {
  const lines = content.replace(/\r\n?/g, '\n').split('\n');
  const anyMarker = lines.some((l) => l.trim().length > 0 && hasMarker(l));

  if (anyMarker) {
    const blocks: string[] = [];
    let current: string[] = [];
    const flush = () => {
      const joined = current.join(' ').trim();
      if (joined.length > 0) blocks.push(joined);
      current = [];
    };
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        flush();
        continue;
      }
      if (hasMarker(line)) {
        flush();
        current.push(stripMarker(line));
      } else if (current.length > 0) {
        // continuation of the previous item
        current.push(trimmed);
      } else {
        // leading unmarked line before any marker — its own block
        current.push(trimmed);
        flush();
      }
    }
    flush();
    return blocks;
  }

  // No markers: prefer paragraph split (blank-line separated); if a single
  // paragraph spans multiple lines, treat each non-empty line as a rule.
  const paragraphs = content
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (paragraphs.length > 1) return paragraphs;

  const nonEmptyLines = lines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (nonEmptyLines.length > 1) return nonEmptyLines;
  return nonEmptyLines;
}

// ── Keyword extraction ─────────────────────────────────────────────────────

const QUOTE_RE = /["'«»“”‘’`]([^"'«»“”‘’`\n]{1,80})["'«»“”‘’`]/g;
const KEYWORD_TRIGGER_RE =
  /(?:запрещен[аноые]*\s+слов[аво]*|запрещённ[ыеао]+\s+слов[аво]*|слов[ао]|фраз[аыэ]|words?|phrases?|terms?|ban[\s-]?words?)\s*[:：\-–—]\s*(.+)$/iu;

function extractKeywords(block: string): string[] {
  const found = new Set<string>();

  // 1) Anything the owner put in quotes / backticks.
  let m: RegExpExecArray | null;
  QUOTE_RE.lastIndex = 0;
  while ((m = QUOTE_RE.exec(block)) !== null) {
    const term = m[1].trim();
    if (term.length > 0) found.add(term);
  }

  // 2) A comma/semicolon list after a trigger like "слова:" / "words:".
  const trig = KEYWORD_TRIGGER_RE.exec(block);
  if (trig) {
    const rest = trig[1];
    for (const part of rest.split(/[,;،、]/)) {
      const term = part.replace(/["'«»“”‘’`]/g, '').trim();
      // Keep short-ish standalone terms; skip long sentence fragments.
      if (term.length > 0 && term.length <= 40 && term.split(/\s+/).length <= 4) {
        found.add(term);
      }
    }
  }

  return [...found];
}

// ── Punishment extraction ──────────────────────────────────────────────────

interface PunishmentSpec {
  type: PunishmentType | null;
  duration: number | null;
}

const UNIT_SECONDS: Record<string, number> = {
  s: 1, sec: 1, secs: 1, second: 1, seconds: 1, сек: 1, секунд: 1, секунды: 1, секунда: 1,
  m: 60, min: 60, mins: 60, minute: 60, minutes: 60, мин: 60, минут: 60, минуты: 60, минута: 60,
  h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, час: 3600, часа: 3600, часов: 3600, ч: 3600,
  d: 86400, day: 86400, days: 86400, дн: 86400, день: 86400, дня: 86400, дней: 86400, сут: 86400, суток: 86400,
  w: 604800, week: 604800, weeks: 604800, нед: 604800, недел: 604800,
};

// NOTE: `\b` is ASCII-only in JS regex and does NOT create a boundary next to
// Cyrillic letters, so we use a Unicode look-ahead `(?![\p{L}])` instead.
const DURATION_RE =
  /(\d+)\s*(секунд[аы]?|сек|seconds?|s|минут[аы]?|мин|minutes?|mins?|m|час[аов]*|hours?|hrs?|hr|h|ч|дн[ейяё]*|день|days?|day|d|сут(?:ок|ки)?|недел[ьия]*|нед|weeks?|week|w)(?![\p{L}])/iu;

function parseDuration(text: string): number | null {
  const m = DURATION_RE.exec(text);
  if (!m) return null;
  const amount = parseInt(m[1], 10);
  const unitRaw = m[2].toLowerCase();
  // Find the matching unit by prefix.
  for (const [key, secs] of Object.entries(UNIT_SECONDS)) {
    if (unitRaw === key || unitRaw.startsWith(key)) {
      return amount * secs;
    }
  }
  return null;
}

// Unicode-aware "word start" boundary (works for Latin AND Cyrillic).
function word(pattern: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})`, 'iu');
}

function parsePunishment(text: string): PunishmentSpec {
  const t = text.toLowerCase();
  let type: PunishmentType | null = null;

  // Order matters: strongest punishment wins if several are mentioned.
  if (word('ban|бан|забан|перма?|перм[аои]').test(t)) type = 'ban';
  else if (word('kick|кик|выгна|выкин').test(t)) type = 'kick';
  else if (word('mute|мут|timeout|тайм-?аут|заглуш').test(t)) type = 'mute';
  else if (word('warn|варн|предупрежд|пред(?![\\p{L}])').test(t)) type = 'warn';
  else if (word('delete|удал|снос|remove|удали').test(t)) type = 'delete';

  const duration = parseDuration(text);
  return { type, duration };
}

// ── Public API ─────────────────────────────────────────────────────────────

export function parseRuleBlock(block: string, sourceMessageId?: string): ParsedRule | null {
  const rawText = block.trim();
  if (rawText.length < 2) return null;
  const keywords = extractKeywords(rawText);
  const { type, duration } = parsePunishment(rawText);
  return {
    rawText,
    keywords,
    punishmentType: type,
    punishmentDuration: type === 'mute' ? duration : null,
    sourceMessageId,
  };
}

/**
 * Parse an ordered list of rules-channel messages into structured rules.
 * Messages should be provided oldest-first.
 */
export function parseRulesFromMessages(messages: SourceMessage[]): ParsedRule[] {
  const rules: ParsedRule[] = [];
  for (const msg of messages) {
    const content = msg.content ?? '';
    if (content.trim().length === 0) continue;
    const blocks = splitIntoBlocks(content);
    for (const block of blocks) {
      const rule = parseRuleBlock(block, msg.id);
      if (rule) rules.push(rule);
    }
  }
  return rules;
}
