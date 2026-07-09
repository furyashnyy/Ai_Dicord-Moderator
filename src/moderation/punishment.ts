import { EmbedBuilder, type GuildMember, type Message } from 'discord.js';
import type { GuildConfig } from '@prisma/client';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { truncate } from '../util/text.js';
import { activeWarningCount, resolveEscalation } from './escalation.js';
import {
  ACTION_COLORS,
  banMember,
  kickMember,
  logModeration,
  sendModLog,
  timeoutMember,
} from './actions.js';
import type { CheckDecision } from './checker.js';
import type { PunishmentType } from '../rules/parser.js';

export type FinalAction = 'none' | 'warn' | 'mute' | 'kick' | 'ban' | 'delete';

const DEFAULT_MUTE_SECONDS = 3600;

export interface AppliedResult {
  action: FinalAction;
  escalated: boolean;
  reason: string;
}

/**
 * Apply a moderation decision to a member/message: delete offending content,
 * record warnings, run the escalation ladder, and carry out the final
 * punishment. Everything is best-effort and guarded by permission checks.
 */
export async function applyPunishment(
  message: Message,
  member: GuildMember,
  guild: GuildConfig,
  decision: CheckDecision,
): Promise<AppliedResult> {
  const guildId = guild.id;
  const userId = member.id;

  // Resolve the base action: rule-specified > guild default (for warn path).
  // A violation always implies at least "warn", so `baseAction` is never "none".
  const baseAction: FinalAction = decision.ruleAction ?? 'warn';
  const duration = decision.ruleDuration ?? null;
  let escalated = false;
  let reason = decision.reason;

  // The offending message broke a rule — always try to remove it.
  await safeDeleteMessage(message);

  // Record a warning for history + escalation on any punitive action other
  // than a pure delete.
  const shouldWarn = baseAction === 'warn' || baseAction === 'mute' || baseAction === 'kick' || baseAction === 'ban';
  if (shouldWarn) {
    await prisma.warning.create({
      data: {
        guildId,
        userId,
        reason: truncate(reason, 400),
        ruleId: decision.matchedRule?.id ?? null,
      },
    });
  }

  let finalAction: FinalAction = baseAction;
  let finalDuration = duration;

  if (baseAction === 'warn') {
    // Warn path: consult the escalation ladder based on total active warnings.
    const count = await activeWarningCount(guildId, userId);
    const esc = await resolveEscalation(guildId, count);
    if (esc) {
      finalAction = esc.action as FinalAction;
      finalDuration = esc.action === 'mute' ? esc.duration ?? DEFAULT_MUTE_SECONDS : null;
      escalated = true;
      reason += ` | Escalation: ${count} warnings → ${esc.action}.`;
    }
  }

  // Carry out the punishment on the member.
  switch (finalAction) {
    case 'mute':
      await timeoutMember(member, finalDuration ?? DEFAULT_MUTE_SECONDS, reason);
      break;
    case 'kick':
      await kickMember(member, reason);
      break;
    case 'ban':
      if (message.guild) await banMember(message.guild, userId, reason, 0);
      break;
    case 'warn':
    case 'delete':
    case 'none':
      break;
  }

  await logModeration(guildId, {
    userId,
    action: finalAction,
    reason,
    ruleId: decision.matchedRule?.id ?? null,
    score: decision.toxicity?.score ?? null,
    content: message.content,
  });
  await notifyLogChannel(message, member, guild, finalAction, finalDuration, decision, reason, escalated);

  return { action: finalAction, escalated, reason };
}

async function safeDeleteMessage(message: Message): Promise<void> {
  try {
    if (message.deletable) await message.delete();
  } catch (err) {
    logger.warn('Failed to delete message:', err instanceof Error ? err.message : err);
  }
}

async function notifyLogChannel(
  message: Message,
  member: GuildMember,
  guild: GuildConfig,
  action: FinalAction,
  duration: number | null,
  decision: CheckDecision,
  reason: string,
  escalated: boolean,
): Promise<void> {
  if (!message.guild) return;

  const embedMsg = new EmbedBuilder()
    .setColor(ACTION_COLORS[action] ?? 0x2b2d31)
    .setTitle(`Moderation: ${action.toUpperCase()}${escalated ? ' (escalated)' : ''}`)
    .setDescription(truncate(message.content || '(no text)', 1000))
    .addFields(
      { name: 'User', value: `<@${member.id}> (${member.id})`, inline: true },
      { name: 'Match', value: decision.matchType, inline: true },
      {
        name: 'Rule',
        value: decision.matchedRule ? `#${decision.matchedRule.id}` : '—',
        inline: true,
      },
    )
    .setFooter({ text: truncate(reason, 200) })
    .setTimestamp(new Date());

  if (decision.matchedKeywords.length > 0) {
    embedMsg.addFields({ name: 'Keywords', value: truncate(decision.matchedKeywords.join(', '), 200) });
  }
  if (decision.toxicity) {
    embedMsg.addFields({
      name: 'Toxicity',
      value: `${decision.toxicity.score.toFixed(2)} (${decision.toxicity.category})`,
      inline: true,
    });
  }
  if (action === 'mute' && duration) {
    embedMsg.addFields({ name: 'Duration', value: `${duration}s`, inline: true });
  }

  await sendModLog(message.guild, guild, embedMsg);
}

export function actionLabel(type: PunishmentType | null): string {
  return type ?? 'default';
}
