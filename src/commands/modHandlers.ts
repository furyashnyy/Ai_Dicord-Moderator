import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type GuildMember,
  type GuildTextBasedChannel,
  type PermissionResolvable,
} from 'discord.js';
import { getGuildConfig, prisma } from '../db.js';
import { logger } from '../logger.js';
import { truncate } from '../util/text.js';
import { listRules } from '../rules/ruleService.js';
import { activeWarningCount, resolveEscalation } from '../moderation/escalation.js';
import {
  ACTION_COLORS,
  banMember,
  formatDuration,
  kickMember,
  logModeration,
  parseHumanDuration,
  removeTimeout,
  sendModLog,
  timeoutMember,
  unbanUser,
} from '../moderation/actions.js';

const DEFAULT_MUTE_SECONDS = 3600;

function ephemeral(content: string) {
  return { content, flags: MessageFlags.Ephemeral as const };
}

/** Ensure the invoker has a permission (guild owner always passes). */
function lacksPermission(interaction: ChatInputCommandInteraction, perm: PermissionResolvable): boolean {
  if (interaction.guild?.ownerId === interaction.user.id) return false;
  return !interaction.memberPermissions?.has(perm);
}

/** Fetch the target member; returns null if not in the guild. */
async function fetchTarget(interaction: ChatInputCommandInteraction): Promise<GuildMember | null> {
  const user = interaction.options.getUser('user', true);
  return interaction.guild!.members.fetch(user.id).catch(() => null);
}

/**
 * Guard against acting on the invoker, the bot, or the guild owner. Returns an
 * error string if the action should be refused, otherwise null.
 */
function protectTarget(interaction: ChatInputCommandInteraction, member: GuildMember): string | null {
  if (member.id === interaction.user.id) return 'You cannot use this on yourself.';
  if (member.id === interaction.client.user.id) return 'You cannot use this on the bot.';
  if (member.id === interaction.guild!.ownerId) return 'You cannot moderate the server owner.';
  return null;
}

async function postActionLog(
  interaction: ChatInputCommandInteraction,
  action: string,
  targetId: string,
  reason: string,
  extra?: string,
): Promise<void> {
  const cfg = await getGuildConfig(interaction.guildId!);
  await logModeration(interaction.guildId!, { userId: targetId, action, reason });
  const embed = new EmbedBuilder()
    .setColor(ACTION_COLORS[action] ?? 0x2b2d31)
    .setTitle(`Manual: ${action.toUpperCase()}`)
    .addFields(
      { name: 'User', value: `<@${targetId}> (${targetId})`, inline: true },
      { name: 'Moderator', value: `<@${interaction.user.id}>`, inline: true },
    )
    .setFooter({ text: truncate(reason, 200) })
    .setTimestamp(new Date());
  if (extra) embed.addFields({ name: 'Details', value: truncate(extra, 500) });
  await sendModLog(interaction.guild!, cfg, embed);
}

/** Entry point for the manual moderation commands. */
export async function handleModCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply(ephemeral('This command can only be used in a server.'));
    return;
  }

  try {
    switch (interaction.commandName) {
      case 'warn':
        return await handleWarn(interaction);
      case 'warnings':
        return await handleWarnings(interaction);
      case 'clearwarnings':
        return await handleClearWarnings(interaction);
      case 'timeout':
        return await handleTimeout(interaction);
      case 'untimeout':
        return await handleUntimeout(interaction);
      case 'kick':
        return await handleKick(interaction);
      case 'ban':
        return await handleBan(interaction);
      case 'unban':
        return await handleUnban(interaction);
      case 'purge':
        return await handlePurge(interaction);
      case 'rules':
        return await handleRules(interaction);
      default:
        await interaction.reply(ephemeral(`Unknown command: ${interaction.commandName}`));
    }
  } catch (err) {
    logger.error('Mod command error:', err instanceof Error ? err.stack ?? err.message : err);
    const msg = ephemeral('An error occurred while running the command. Check the bot logs.');
    if (interaction.deferred || interaction.replied) await interaction.followUp(msg).catch(() => {});
    else await interaction.reply(msg).catch(() => {});
  }
}

async function handleWarn(interaction: ChatInputCommandInteraction): Promise<void> {
  if (lacksPermission(interaction, PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply(ephemeral('You need the "Moderate Members" permission.'));
    return;
  }
  const member = await fetchTarget(interaction);
  if (!member) {
    await interaction.reply(ephemeral('That user is not a member of this server.'));
    return;
  }
  const refuse = protectTarget(interaction, member);
  if (refuse) {
    await interaction.reply(ephemeral(refuse));
    return;
  }
  const reason = interaction.options.getString('reason', true);
  const guildId = interaction.guildId!;

  await prisma.warning.create({ data: { guildId, userId: member.id, reason: truncate(reason, 400) } });
  const count = await activeWarningCount(guildId, member.id);

  let outcome = `Warned. Active warnings: ${count}.`;
  let logExtra = `Active warnings: ${count}.`;

  const esc = await resolveEscalation(guildId, count);
  if (esc) {
    const escReason = `Escalation at ${count} warnings (${reason})`;
    if (esc.action === 'mute') {
      const res = await timeoutMember(member, esc.duration ?? DEFAULT_MUTE_SECONDS, escReason);
      outcome += ` Escalated: timeout — ${res.message}`;
    } else if (esc.action === 'kick') {
      const res = await kickMember(member, escReason);
      outcome += ` Escalated: kick — ${res.message}`;
    } else if (esc.action === 'ban') {
      const res = await banMember(interaction.guild!, member.id, escReason, 0);
      outcome += ` Escalated: ban — ${res.message}`;
    }
    logExtra += ` Escalated → ${esc.action}.`;
  }

  await postActionLog(interaction, 'warn', member.id, reason, logExtra);
  await interaction.reply(ephemeral(`⚠️ ${outcome}`));
}

async function handleWarnings(interaction: ChatInputCommandInteraction): Promise<void> {
  if (lacksPermission(interaction, PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply(ephemeral('You need the "Moderate Members" permission.'));
    return;
  }
  const user = interaction.options.getUser('user', true);
  const guildId = interaction.guildId!;
  const warnings = await prisma.warning.findMany({
    where: { guildId, userId: user.id, active: true },
    orderBy: { createdAt: 'desc' },
    take: 15,
  });
  if (warnings.length === 0) {
    await interaction.reply(ephemeral(`${user.tag} has no active warnings.`));
    return;
  }
  const lines = warnings.map((w) => {
    const ts = `<t:${Math.floor(w.createdAt.getTime() / 1000)}:R>`;
    return `${ts}${w.ruleId ? ` • rule #${w.ruleId}` : ''} — ${truncate(w.reason, 150)}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0xfaa61a)
    .setTitle(`Active warnings for ${user.tag}`)
    .setDescription(truncate(lines.join('\n'), 4000))
    .setFooter({ text: `${warnings.length} shown` });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleClearWarnings(interaction: ChatInputCommandInteraction): Promise<void> {
  if (lacksPermission(interaction, PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply(ephemeral('You need the "Moderate Members" permission.'));
    return;
  }
  const user = interaction.options.getUser('user', true);
  const guildId = interaction.guildId!;
  const res = await prisma.warning.updateMany({
    where: { guildId, userId: user.id, active: true },
    data: { active: false },
  });
  await postActionLog(interaction, 'clearwarnings', user.id, `Cleared ${res.count} warning(s)`);
  await interaction.reply(ephemeral(`🧹 Cleared ${res.count} active warning(s) for ${user.tag}.`));
}

async function handleTimeout(interaction: ChatInputCommandInteraction): Promise<void> {
  if (lacksPermission(interaction, PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply(ephemeral('You need the "Moderate Members" permission.'));
    return;
  }
  const member = await fetchTarget(interaction);
  if (!member) {
    await interaction.reply(ephemeral('That user is not a member of this server.'));
    return;
  }
  const refuse = protectTarget(interaction, member);
  if (refuse) {
    await interaction.reply(ephemeral(refuse));
    return;
  }
  const durationStr = interaction.options.getString('duration', true);
  const seconds = parseHumanDuration(durationStr);
  if (seconds === null) {
    await interaction.reply(ephemeral('Invalid duration. Try e.g. `30m`, `1h`, `1d`, `45s`, `1w`.'));
    return;
  }
  const reason = interaction.options.getString('reason') ?? 'No reason provided';
  const res = await timeoutMember(member, seconds, reason);
  if (res.ok) {
    await postActionLog(interaction, 'timeout', member.id, reason, `Duration: ${formatDuration(seconds)}`);
    await interaction.reply(ephemeral(`🔇 Timed out ${member.user.tag} for ${formatDuration(seconds)}.`));
  } else {
    await interaction.reply(ephemeral(res.message));
  }
}

async function handleUntimeout(interaction: ChatInputCommandInteraction): Promise<void> {
  if (lacksPermission(interaction, PermissionFlagsBits.ModerateMembers)) {
    await interaction.reply(ephemeral('You need the "Moderate Members" permission.'));
    return;
  }
  const member = await fetchTarget(interaction);
  if (!member) {
    await interaction.reply(ephemeral('That user is not a member of this server.'));
    return;
  }
  const reason = interaction.options.getString('reason') ?? 'Timeout removed by moderator';
  const res = await removeTimeout(member, reason);
  if (res.ok) {
    await postActionLog(interaction, 'untimeout', member.id, reason);
    await interaction.reply(ephemeral(`🔈 Removed timeout from ${member.user.tag}.`));
  } else {
    await interaction.reply(ephemeral(res.message));
  }
}

async function handleKick(interaction: ChatInputCommandInteraction): Promise<void> {
  if (lacksPermission(interaction, PermissionFlagsBits.KickMembers)) {
    await interaction.reply(ephemeral('You need the "Kick Members" permission.'));
    return;
  }
  const member = await fetchTarget(interaction);
  if (!member) {
    await interaction.reply(ephemeral('That user is not a member of this server.'));
    return;
  }
  const refuse = protectTarget(interaction, member);
  if (refuse) {
    await interaction.reply(ephemeral(refuse));
    return;
  }
  const reason = interaction.options.getString('reason') ?? 'No reason provided';
  const res = await kickMember(member, reason);
  if (res.ok) {
    await postActionLog(interaction, 'kick', member.id, reason);
    await interaction.reply(ephemeral(`👢 Kicked ${member.user.tag}.`));
  } else {
    await interaction.reply(ephemeral(res.message));
  }
}

async function handleBan(interaction: ChatInputCommandInteraction): Promise<void> {
  if (lacksPermission(interaction, PermissionFlagsBits.BanMembers)) {
    await interaction.reply(ephemeral('You need the "Ban Members" permission.'));
    return;
  }
  const user = interaction.options.getUser('user', true);
  if (user.id === interaction.user.id) {
    await interaction.reply(ephemeral('You cannot ban yourself.'));
    return;
  }
  if (user.id === interaction.guild!.ownerId) {
    await interaction.reply(ephemeral('You cannot ban the server owner.'));
    return;
  }
  const reason = interaction.options.getString('reason') ?? 'No reason provided';
  const deleteDays = interaction.options.getInteger('delete-days') ?? 0;
  const res = await banMember(interaction.guild!, user.id, reason, deleteDays * 86400);
  if (res.ok) {
    await postActionLog(interaction, 'ban', user.id, reason, deleteDays ? `Deleted ${deleteDays}d of messages` : undefined);
    await interaction.reply(ephemeral(`🔨 Banned ${user.tag}.`));
  } else {
    await interaction.reply(ephemeral(res.message));
  }
}

async function handleUnban(interaction: ChatInputCommandInteraction): Promise<void> {
  if (lacksPermission(interaction, PermissionFlagsBits.BanMembers)) {
    await interaction.reply(ephemeral('You need the "Ban Members" permission.'));
    return;
  }
  const userId = interaction.options.getString('user-id', true).trim();
  if (!/^\d{17,20}$/.test(userId)) {
    await interaction.reply(ephemeral('That does not look like a valid user ID.'));
    return;
  }
  const reason = interaction.options.getString('reason') ?? 'Unbanned by moderator';
  const res = await unbanUser(interaction.guild!, userId, reason);
  if (res.ok) {
    await postActionLog(interaction, 'unban', userId, reason);
    await interaction.reply(ephemeral(`✅ Unbanned <@${userId}> (${userId}).`));
  } else {
    await interaction.reply(ephemeral(res.message));
  }
}

async function handlePurge(interaction: ChatInputCommandInteraction): Promise<void> {
  if (lacksPermission(interaction, PermissionFlagsBits.ManageMessages)) {
    await interaction.reply(ephemeral('You need the "Manage Messages" permission.'));
    return;
  }
  const channel = interaction.channel;
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    await interaction.reply(ephemeral('This command must be used in a server text channel.'));
    return;
  }
  const amount = interaction.options.getInteger('amount', true);
  const user = interaction.options.getUser('user');

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const textChannel = channel as GuildTextBasedChannel;

  let deleted = 0;
  try {
    if (user) {
      // Fetch a window of recent messages and delete up to `amount` from user.
      const recent = await textChannel.messages.fetch({ limit: 100 });
      const mine = [...recent.values()].filter((m) => m.author.id === user.id).slice(0, amount);
      const result = await textChannel.bulkDelete(mine, true);
      deleted = result.size;
    } else {
      const result = await textChannel.bulkDelete(amount, true);
      deleted = result.size;
    }
  } catch (err) {
    logger.warn('Purge failed:', err instanceof Error ? err.message : err);
    await interaction.editReply('Failed to purge (messages older than 14 days cannot be bulk-deleted).');
    return;
  }

  await postActionLog(
    interaction,
    'purge',
    user?.id ?? interaction.user.id,
    `Purged ${deleted} message(s) in #${textChannel.name}`,
    user ? `Filtered to ${user.tag}` : undefined,
  );
  await interaction.editReply(`🧽 Deleted ${deleted} message(s)${user ? ` from ${user.tag}` : ''}.`);
}

async function handleRules(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const rules = await listRules(guildId);
  if (rules.length === 0) {
    await interaction.reply(ephemeral('No rules have been configured on this server yet.'));
    return;
  }
  const isOwner = interaction.guild?.ownerId === interaction.user.id;
  const lines = rules.map((r, i) => {
    const meta = isOwner
      ? ` _(#${r.id}${r.punishmentType ? `, ${r.punishmentType}` : ''})_`
      : '';
    return `**${i + 1}.** ${truncate(r.rawText, 180)}${meta}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`${interaction.guild!.name} — rules`)
    .setDescription(truncate(lines.join('\n'), 4000))
    .setFooter({ text: `${rules.length} rule(s)` });
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
