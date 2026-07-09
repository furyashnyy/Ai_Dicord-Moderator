import {
  EmbedBuilder,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type TextChannel,
} from 'discord.js';
import type { GuildConfig } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { truncate } from '../util/text.js';

// Discord timeout hard cap is 28 days; ban message-delete cap is 7 days.
export const MAX_TIMEOUT_SECONDS = 28 * 24 * 3600;
export const MAX_BAN_DELETE_SECONDS = 7 * 24 * 3600;

export const ACTION_COLORS: Record<string, number> = {
  none: 0x2b2d31,
  delete: 0x5865f2,
  purge: 0x5865f2,
  warn: 0xfaa61a,
  clearwarnings: 0x57f287,
  mute: 0xff7043,
  timeout: 0xff7043,
  untimeout: 0x57f287,
  unban: 0x57f287,
  kick: 0xef5350,
  ban: 0xb71c1c,
};

export interface ActionResult {
  ok: boolean;
  message: string;
}

/**
 * Parse a human duration like "1h", "30m", "1d12h", "45s", "1w" into seconds.
 * A bare number is interpreted as minutes. Returns null if nothing parses.
 */
export function parseHumanDuration(input: string): number | null {
  const trimmed = input.trim().toLowerCase();
  if (trimmed.length === 0) return null;

  const units: Record<string, number> = { w: 604800, d: 86400, h: 3600, m: 60, s: 1 };
  const re = /(\d+)\s*(w|d|h|m|s)/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(trimmed)) !== null) {
    matched = true;
    total += parseInt(m[1], 10) * units[m[2]];
  }
  if (matched) return total > 0 ? total : null;

  // Bare number => minutes.
  if (/^\d+$/.test(trimmed)) {
    const n = parseInt(trimmed, 10);
    return n > 0 ? n * 60 : null;
  }
  return null;
}

/** Human-readable duration from seconds ("1h 30m"). */
export function formatDuration(seconds: number): string {
  const parts: string[] = [];
  let s = seconds;
  const units: [string, number][] = [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];
  for (const [label, size] of units) {
    if (s >= size) {
      parts.push(`${Math.floor(s / size)}${label}`);
      s %= size;
    }
  }
  return parts.length ? parts.join(' ') : '0s';
}

export async function timeoutMember(
  member: GuildMember,
  seconds: number,
  reason: string,
): Promise<ActionResult> {
  if (!member.moderatable) {
    return { ok: false, message: 'I cannot time out this member (role hierarchy or missing permission).' };
  }
  try {
    const capped = Math.min(Math.max(Math.floor(seconds), 1), MAX_TIMEOUT_SECONDS);
    await member.timeout(capped * 1000, truncate(reason, 400));
    return { ok: true, message: `Timed out for ${formatDuration(capped)}.` };
  } catch (err) {
    logger.warn('Failed to timeout member:', err instanceof Error ? err.message : err);
    return { ok: false, message: 'Failed to time out member (see logs).' };
  }
}

export async function removeTimeout(member: GuildMember, reason: string): Promise<ActionResult> {
  if (!member.moderatable) {
    return { ok: false, message: 'I cannot manage this member (role hierarchy or missing permission).' };
  }
  try {
    await member.timeout(null, truncate(reason, 400));
    return { ok: true, message: 'Timeout removed.' };
  } catch (err) {
    logger.warn('Failed to remove timeout:', err instanceof Error ? err.message : err);
    return { ok: false, message: 'Failed to remove timeout (see logs).' };
  }
}

export async function kickMember(member: GuildMember, reason: string): Promise<ActionResult> {
  if (!member.kickable) {
    return { ok: false, message: 'I cannot kick this member (role hierarchy or missing permission).' };
  }
  try {
    await member.kick(truncate(reason, 400));
    return { ok: true, message: 'Kicked.' };
  } catch (err) {
    logger.warn('Failed to kick member:', err instanceof Error ? err.message : err);
    return { ok: false, message: 'Failed to kick member (see logs).' };
  }
}

export async function banMember(
  guild: Guild,
  userId: string,
  reason: string,
  deleteSeconds = 0,
): Promise<ActionResult> {
  try {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (member && !member.bannable) {
      return { ok: false, message: 'I cannot ban this member (role hierarchy or missing permission).' };
    }
    await guild.members.ban(userId, {
      reason: truncate(reason, 400),
      deleteMessageSeconds: Math.min(Math.max(deleteSeconds, 0), MAX_BAN_DELETE_SECONDS),
    });
    return { ok: true, message: 'Banned.' };
  } catch (err) {
    logger.warn('Failed to ban user:', err instanceof Error ? err.message : err);
    return { ok: false, message: 'Failed to ban user (see logs).' };
  }
}

export async function unbanUser(guild: Guild, userId: string, reason: string): Promise<ActionResult> {
  try {
    await guild.members.unban(userId, truncate(reason, 400));
    return { ok: true, message: 'Unbanned.' };
  } catch (err) {
    logger.warn('Failed to unban user:', err instanceof Error ? err.message : err);
    return { ok: false, message: 'Failed to unban (user may not be banned).' };
  }
}

export interface LogEntry {
  userId: string;
  action: string;
  reason: string;
  ruleId?: number | null;
  score?: number | null;
  content?: string | null;
}

/** Persist a moderation action to the audit log table. */
export async function logModeration(guildId: string, entry: LogEntry): Promise<void> {
  try {
    await prisma.moderationLog.create({
      data: {
        guildId,
        userId: entry.userId,
        messageContent: truncate(entry.content ?? '', 1000),
        action: entry.action,
        ruleId: entry.ruleId ?? null,
        reason: truncate(entry.reason, 500),
        score: entry.score ?? null,
      },
    });
  } catch (err) {
    logger.warn('Failed to write moderation log:', err instanceof Error ? err.message : err);
  }
}

/** Post an embed to the guild's configured log channel, if any and writable. */
export async function sendModLog(guild: Guild, cfg: GuildConfig, embed: EmbedBuilder): Promise<void> {
  if (!cfg.logChannelId) return;
  try {
    const channel = await guild.channels.fetch(cfg.logChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const me = guild.members.me;
    if (me) {
      const perms = (channel as TextChannel).permissionsFor(me);
      if (perms && !perms.has(PermissionFlagsBits.SendMessages)) return;
    }
    await (channel as TextChannel).send({ embeds: [embed] });
  } catch (err) {
    logger.warn('Failed to post to log channel:', err instanceof Error ? err.message : err);
  }
}
