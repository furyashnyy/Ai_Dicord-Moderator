import type { GuildRule } from '@prisma/client';
import type { Collection, Message, TextBasedChannel } from 'discord.js';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { embed, serializeEmbedding, parseEmbedding } from '../ai/embeddings.js';
import {
  parseRulesFromMessages,
  type ParsedRule,
  type PunishmentType,
} from './parser.js';

export interface RuleView {
  id: number;
  rawText: string;
  keywords: string[];
  embedding: number[] | null;
  punishmentType: PunishmentType | null;
  punishmentDuration: number | null;
  similarityThreshold: number | null;
}

export function keywordsOf(rule: GuildRule): string[] {
  try {
    const parsed = JSON.parse(rule.keywords);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

export function toView(rule: GuildRule): RuleView {
  return {
    id: rule.id,
    rawText: rule.rawText,
    keywords: keywordsOf(rule),
    embedding: parseEmbedding(rule.embedding),
    punishmentType: (rule.punishmentType as PunishmentType | null) ?? null,
    punishmentDuration: rule.punishmentDuration,
    similarityThreshold: rule.similarityThreshold,
  };
}

/**
 * Read every message from a rules channel (paginated, oldest-first) and return
 * their id/content pairs.
 */
async function fetchAllMessages(channel: TextBasedChannel): Promise<{ id: string; content: string }[]> {
  const collected: { id: string; content: string; createdTimestamp: number }[] = [];
  let before: string | undefined;
  const MAX = 1000; // safety cap

  // `messages.fetch` exists on guild text-based channels.
  const fetchable = channel as unknown as {
    messages: { fetch: (opts: { limit: number; before?: string }) => Promise<Collection<string, Message>> };
  };

  while (collected.length < MAX) {
    const batch = await fetchable.messages.fetch({ limit: 100, before });
    if (batch.size === 0) break;
    for (const msg of batch.values()) {
      if (msg.content && msg.content.trim().length > 0) {
        collected.push({ id: msg.id, content: msg.content, createdTimestamp: msg.createdTimestamp });
      }
    }
    before = batch.last()?.id;
    if (batch.size < 100) break;
  }

  // oldest-first
  collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  return collected.map(({ id, content }) => ({ id, content }));
}

export interface SyncResult {
  parsed: number;
  withKeywords: number;
  withPunishment: number;
  embedded: number;
}

/**
 * Re-scan the guild's rules channel and replace stored rules with freshly
 * parsed + embedded ones. Existing rules for the guild are deleted first so a
 * sync always reflects the current channel state.
 */
export async function syncRules(guildId: string, channel: TextBasedChannel): Promise<SyncResult> {
  const messages = await fetchAllMessages(channel);
  const parsed: ParsedRule[] = parseRulesFromMessages(messages);
  logger.info(`Parsed ${parsed.length} rule(s) from ${messages.length} message(s) in guild ${guildId}.`);

  let embedded = 0;
  let withKeywords = 0;
  let withPunishment = 0;

  // Prepare rows (compute embeddings sequentially to bound memory/CPU).
  const rows: Array<{
    guildId: string;
    rawText: string;
    keywords: string;
    embedding: string | null;
    punishmentType: string | null;
    punishmentDuration: number | null;
    sourceMessageId: string | null;
  }> = [];

  for (const rule of parsed) {
    const vec = await embed(rule.rawText);
    if (vec) embedded++;
    if (rule.keywords.length > 0) withKeywords++;
    if (rule.punishmentType) withPunishment++;
    rows.push({
      guildId,
      rawText: rule.rawText,
      keywords: JSON.stringify(rule.keywords),
      embedding: serializeEmbedding(vec),
      punishmentType: rule.punishmentType,
      punishmentDuration: rule.punishmentDuration,
      sourceMessageId: rule.sourceMessageId ?? null,
    });
  }

  await prisma.$transaction([
    prisma.guildRule.deleteMany({ where: { guildId } }),
    ...rows.map((data) => prisma.guildRule.create({ data })),
    prisma.guildConfig.update({ where: { id: guildId }, data: { lastSyncAt: new Date() } }),
  ]);

  invalidateRuleCache(guildId);
  return { parsed: parsed.length, withKeywords, withPunishment, embedded };
}

export async function listRules(guildId: string): Promise<RuleView[]> {
  const rules = await prisma.guildRule.findMany({ where: { guildId }, orderBy: { id: 'asc' } });
  return rules.map(toView);
}

// ── In-memory rule cache (hot path: every message) ─────────────────────────
const ruleCache = new Map<string, RuleView[]>();

/** Get rules for a guild, using a small in-memory cache for the message path. */
export async function getRulesCached(guildId: string): Promise<RuleView[]> {
  const cached = ruleCache.get(guildId);
  if (cached) return cached;
  const rules = await listRules(guildId);
  ruleCache.set(guildId, rules);
  return rules;
}

/** Invalidate the cache after any mutation (sync/edit/remove). */
export function invalidateRuleCache(guildId: string): void {
  ruleCache.delete(guildId);
}

export async function getRule(guildId: string, id: number): Promise<RuleView | null> {
  const rule = await prisma.guildRule.findFirst({ where: { id, guildId } });
  return rule ? toView(rule) : null;
}

export interface RuleUpdate {
  keywords?: string[];
  punishmentType?: PunishmentType | null;
  punishmentDuration?: number | null;
  similarityThreshold?: number | null;
}

export async function updateRule(guildId: string, id: number, update: RuleUpdate): Promise<RuleView | null> {
  const existing = await prisma.guildRule.findFirst({ where: { id, guildId } });
  if (!existing) return null;
  const updated = await prisma.guildRule.update({
    where: { id },
    data: {
      keywords: update.keywords !== undefined ? JSON.stringify(update.keywords) : undefined,
      punishmentType: update.punishmentType !== undefined ? update.punishmentType : undefined,
      punishmentDuration: update.punishmentDuration !== undefined ? update.punishmentDuration : undefined,
      similarityThreshold: update.similarityThreshold !== undefined ? update.similarityThreshold : undefined,
    },
  });
  invalidateRuleCache(guildId);
  return toView(updated);
}

export async function removeRule(guildId: string, id: number): Promise<boolean> {
  const existing = await prisma.guildRule.findFirst({ where: { id, guildId } });
  if (!existing) return false;
  await prisma.guildRule.delete({ where: { id } });
  invalidateRuleCache(guildId);
  return true;
}
