import { Events, type Message } from 'discord.js';
import { isGuildAllowed } from '../config.js';
import { getGuildConfig } from '../db.js';
import { logger } from '../logger.js';
import { getRulesCached } from '../rules/ruleService.js';
import { checkMessage } from '../moderation/checker.js';
import { applyPunishment } from '../moderation/punishment.js';
import { isExemptMember, isWhitelistedChannel } from '../util/permissions.js';
import { truncate } from '../util/text.js';

export const name = Events.MessageCreate;

export async function execute(message: Message): Promise<void> {
  try {
    // Basic gating.
    if (message.author.bot || message.system) return;
    if (!message.guild || !message.inGuild()) return;
    if (message.content.trim().length === 0) return;

    const guildId = message.guild.id;
    if (!isGuildAllowed(guildId)) return;

    const guild = await getGuildConfig(guildId);
    if (!guild.enabled) return;

    // Never moderate the rules channel or the log channel itself.
    if (message.channelId === guild.rulesChannelId) return;
    if (message.channelId === guild.logChannelId) return;

    if (await isWhitelistedChannel(guildId, message.channelId)) return;

    const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (!member) return;
    if (await isExemptMember(guildId, member)) return;

    const rules = await getRulesCached(guildId);
    const decision = await checkMessage(message.content, rules, guild);
    if (!decision.violation) return;

    logger.debug(
      `Violation in guild ${guildId} by ${member.id}: ${decision.matchType} — ${truncate(decision.reason, 120)}`,
    );

    await applyPunishment(message, member, guild, decision);
  } catch (err) {
    logger.error('Error handling message:', err instanceof Error ? err.stack ?? err.message : err);
  }
}
