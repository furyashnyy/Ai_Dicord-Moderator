import {
  ActionRowBuilder,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import { prisma, getGuildConfig } from '../db.js';
import { logger } from '../logger.js';
import { isGuildOwner } from '../util/permissions.js';
import { truncate } from '../util/text.js';
import { modelStatus } from '../ai/modelManager.js';
import {
  syncRules,
  listRules,
  getRule,
  updateRule,
  removeRule,
  invalidateRuleCache,
} from '../rules/ruleService.js';
import type { PunishmentType } from '../rules/parser.js';

const PUNISHMENTS = new Set<PunishmentType>(['warn', 'mute', 'kick', 'ban', 'delete']);

function ephemeral(content: string) {
  return { content, flags: MessageFlags.Ephemeral as const };
}

/** Entry point for the /moderation command. */
export async function handleModerationCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guild) {
    await interaction.reply(ephemeral('This command can only be used in a server.'));
    return;
  }
  if (!isGuildOwner(interaction)) {
    await interaction.reply(ephemeral('Only the server owner can use moderation commands.'));
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  try {
    if (group === 'rules') return await handleRules(interaction, sub);
    if (group === 'default-action') return await handleDefaultAction(interaction);
    if (group === 'escalation') return await handleEscalation(interaction, sub);
    if (group === 'whitelist') return await handleWhitelist(interaction, sub);

    switch (sub) {
      case 'setup':
        return await handleSetup(interaction);
      case 'set-rules-channel':
        return await handleSetRulesChannel(interaction);
      case 'sync-rules':
        return await handleSyncRules(interaction);
      case 'status':
        return await handleStatus(interaction);
      case 'logs':
        return await handleLogs(interaction);
      default:
        await interaction.reply(ephemeral(`Unknown subcommand: ${sub}`));
    }
  } catch (err) {
    logger.error('Command handler error:', err instanceof Error ? err.stack ?? err.message : err);
    const msg = ephemeral('An error occurred while processing the command. Check the bot logs.');
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(msg).catch(() => {});
    } else {
      await interaction.reply(msg).catch(() => {});
    }
  }
}

// ── setup ───────────────────────────────────────────────────────────────────
async function handleSetup(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  await getGuildConfig(guildId);

  const logChannel = interaction.options.getChannel('log-channel');
  const rulesChannel = interaction.options.getChannel('rules-channel');
  const enabled = interaction.options.getBoolean('enabled');

  const data: Record<string, unknown> = {};
  if (logChannel) data.logChannelId = logChannel.id;
  if (rulesChannel) data.rulesChannelId = rulesChannel.id;
  if (enabled !== null) data.enabled = enabled;

  if (Object.keys(data).length === 0) {
    const cfg = await getGuildConfig(guildId);
    await interaction.reply(
      ephemeral(
        [
          '**Current setup**',
          `• Enabled: ${cfg.enabled ? 'yes' : 'no'}`,
          `• Log channel: ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : '—'}`,
          `• Rules channel: ${cfg.rulesChannelId ? `<#${cfg.rulesChannelId}>` : '—'}`,
          `• Default action: ${cfg.defaultAction}`,
          '',
          'Pass options to `/moderation setup` to change these.',
        ].join('\n'),
      ),
    );
    return;
  }

  await prisma.guildConfig.update({ where: { id: guildId }, data });
  const cfg = await getGuildConfig(guildId);
  await interaction.reply(
    ephemeral(
      [
        '✅ Setup updated.',
        `• Enabled: ${cfg.enabled ? 'yes' : 'no'}`,
        `• Log channel: ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : '—'}`,
        `• Rules channel: ${cfg.rulesChannelId ? `<#${cfg.rulesChannelId}>` : '—'}`,
        cfg.rulesChannelId ? '\nRun `/moderation sync-rules` to import the rules.' : '',
      ].join('\n'),
    ),
  );
}

// ── set-rules-channel ────────────────────────────────────────────────────────
async function handleSetRulesChannel(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  await getGuildConfig(guildId);
  const channel = interaction.options.getChannel('channel', true);
  await prisma.guildConfig.update({ where: { id: guildId }, data: { rulesChannelId: channel.id } });
  await interaction.reply(
    ephemeral(`✅ Rules channel set to <#${channel.id}>. Run \`/moderation sync-rules\` to import.`),
  );
}

// ── sync-rules ───────────────────────────────────────────────────────────────
async function handleSyncRules(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const cfg = await getGuildConfig(guildId);
  if (!cfg.rulesChannelId) {
    await interaction.reply(ephemeral('No rules channel set. Use `/moderation set-rules-channel` first.'));
    return;
  }
  const channel = await interaction.guild!.channels.fetch(cfg.rulesChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) {
    await interaction.reply(ephemeral('The configured rules channel is missing or not a text channel.'));
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const result = await syncRules(guildId, channel);
  await interaction.editReply(
    [
      '✅ **Rules synced.**',
      `• Parsed rules: ${result.parsed}`,
      `• With explicit keywords: ${result.withKeywords}`,
      `• With explicit punishment: ${result.withPunishment}`,
      `• With semantic embedding: ${result.embedded}`,
      '',
      'Use `/moderation rules list` to review, `/moderation rules edit <id>` to fix any mis-parses.',
    ].join('\n'),
  );
}

// ── rules group ──────────────────────────────────────────────────────────────
async function handleRules(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  const guildId = interaction.guildId!;
  if (sub === 'list') {
    const rules = await listRules(guildId);
    if (rules.length === 0) {
      await interaction.reply(ephemeral('No rules parsed yet. Set a rules channel and run `/moderation sync-rules`.'));
      return;
    }
    const embed = new EmbedBuilder().setTitle('Parsed rules').setColor(0x5865f2);
    // Discord embeds allow up to 25 fields; paginate description otherwise.
    const lines = rules.map((r) => {
      const kw = r.keywords.length ? ` — kw: ${truncate(r.keywords.join(', '), 60)}` : '';
      const pun = r.punishmentType
        ? ` — ${r.punishmentType}${r.punishmentDuration ? `(${r.punishmentDuration}s)` : ''}`
        : ' — (default)';
      return `**#${r.id}** ${truncate(r.rawText, 90)}${kw}${pun}`;
    });
    embed.setDescription(truncate(lines.join('\n'), 4000));
    embed.setFooter({ text: `${rules.length} rule(s)` });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    return;
  }

  if (sub === 'remove') {
    const id = interaction.options.getInteger('id', true);
    const ok = await removeRule(guildId, id);
    await interaction.reply(ephemeral(ok ? `🗑️ Removed rule #${id}.` : `No rule #${id} found.`));
    return;
  }

  if (sub === 'edit') {
    const id = interaction.options.getInteger('id', true);
    const rule = await getRule(guildId, id);
    if (!rule) {
      await interaction.reply(ephemeral(`No rule #${id} found.`));
      return;
    }
    const modal = new ModalBuilder().setCustomId(`rule-edit:${id}`).setTitle(`Edit rule #${id}`);

    const keywordsInput = new TextInputBuilder()
      .setCustomId('keywords')
      .setLabel('Keywords (comma-separated)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setValue(truncate(rule.keywords.join(', '), 4000));

    const punishmentInput = new TextInputBuilder()
      .setCustomId('punishment')
      .setLabel('Punishment: warn/mute/kick/ban/delete/blank')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setValue(rule.punishmentType ?? '');

    const durationInput = new TextInputBuilder()
      .setCustomId('duration')
      .setLabel('Mute duration in seconds (blank = default)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setValue(rule.punishmentDuration != null ? String(rule.punishmentDuration) : '');

    const similarityInput = new TextInputBuilder()
      .setCustomId('similarity')
      .setLabel('Similarity threshold 0..1 (blank = guild default)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false)
      .setValue(rule.similarityThreshold != null ? String(rule.similarityThreshold) : '');

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(keywordsInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(punishmentInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(durationInput),
      new ActionRowBuilder<TextInputBuilder>().addComponents(similarityInput),
    );
    await interaction.showModal(modal);
    return;
  }

  await interaction.reply(ephemeral(`Unknown rules subcommand: ${sub}`));
}

/** Handle submission of the rule-edit modal. */
export async function handleRuleEditModal(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.inGuild() || !interaction.guildId) return;
  const guildId = interaction.guildId;
  const id = Number(interaction.customId.split(':')[1]);
  if (!Number.isInteger(id)) {
    await interaction.reply(ephemeral('Invalid rule id.'));
    return;
  }

  const keywordsRaw = interaction.fields.getTextInputValue('keywords');
  const punishmentRaw = interaction.fields.getTextInputValue('punishment').trim().toLowerCase();
  const durationRaw = interaction.fields.getTextInputValue('duration').trim();
  const similarityRaw = interaction.fields.getTextInputValue('similarity').trim();

  const keywords = keywordsRaw
    .split(/[,\n]/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  let punishmentType: PunishmentType | null = null;
  if (punishmentRaw.length > 0) {
    if (!PUNISHMENTS.has(punishmentRaw as PunishmentType)) {
      await interaction.reply(ephemeral(`Invalid punishment "${punishmentRaw}". Use warn/mute/kick/ban/delete or leave blank.`));
      return;
    }
    punishmentType = punishmentRaw as PunishmentType;
  }

  let punishmentDuration: number | null = null;
  if (durationRaw.length > 0) {
    const d = parseInt(durationRaw, 10);
    if (!Number.isFinite(d) || d <= 0) {
      await interaction.reply(ephemeral('Duration must be a positive integer (seconds) or blank.'));
      return;
    }
    punishmentDuration = d;
  }

  let similarityThreshold: number | null = null;
  if (similarityRaw.length > 0) {
    const s = Number(similarityRaw);
    if (!Number.isFinite(s) || s < 0 || s > 1) {
      await interaction.reply(ephemeral('Similarity threshold must be between 0 and 1, or blank.'));
      return;
    }
    similarityThreshold = s;
  }

  const updated = await updateRule(guildId, id, {
    keywords,
    punishmentType,
    punishmentDuration,
    similarityThreshold,
  });
  if (!updated) {
    await interaction.reply(ephemeral(`No rule #${id} found.`));
    return;
  }

  await interaction.reply(
    ephemeral(
      [
        `✅ Updated rule #${id}.`,
        `• Keywords: ${updated.keywords.length ? updated.keywords.join(', ') : '—'}`,
        `• Punishment: ${updated.punishmentType ?? '(default)'}${updated.punishmentDuration ? ` (${updated.punishmentDuration}s)` : ''}`,
        `• Similarity: ${updated.similarityThreshold ?? '(guild default)'}`,
      ].join('\n'),
    ),
  );
}

// ── default-action group ─────────────────────────────────────────────────────
async function handleDefaultAction(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  await getGuildConfig(guildId);
  const action = interaction.options.getString('action', true);
  const threshold = interaction.options.getNumber('toxicity-threshold');
  const data: Record<string, unknown> = { defaultAction: action };
  if (threshold !== null) data.toxicityThreshold = threshold;
  await prisma.guildConfig.update({ where: { id: guildId }, data });
  await interaction.reply(
    ephemeral(
      `✅ Default action set to **${action}**${threshold !== null ? ` (toxicity threshold ${threshold})` : ''}.`,
    ),
  );
}

// ── escalation group ─────────────────────────────────────────────────────────
async function handleEscalation(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  const guildId = interaction.guildId!;
  await getGuildConfig(guildId);

  if (sub === 'set') {
    const threshold = interaction.options.getInteger('warnings', true);
    const action = interaction.options.getString('action', true);
    const duration = interaction.options.getInteger('duration-seconds');
    await prisma.escalationStep.upsert({
      where: { guildId_threshold: { guildId, threshold } },
      create: { guildId, threshold, action, duration: duration ?? null },
      update: { action, duration: duration ?? null },
    });
    await interaction.reply(
      ephemeral(
        `✅ Escalation: at **${threshold}** warning(s) → **${action}**${action === 'mute' && duration ? ` for ${duration}s` : ''}.`,
      ),
    );
    return;
  }

  if (sub === 'remove') {
    const threshold = interaction.options.getInteger('warnings', true);
    const existing = await prisma.escalationStep.findUnique({
      where: { guildId_threshold: { guildId, threshold } },
    });
    if (!existing) {
      await interaction.reply(ephemeral(`No escalation step at ${threshold} warning(s).`));
      return;
    }
    await prisma.escalationStep.delete({ where: { guildId_threshold: { guildId, threshold } } });
    await interaction.reply(ephemeral(`🗑️ Removed escalation step at ${threshold} warning(s).`));
    return;
  }

  // list
  const steps = await prisma.escalationStep.findMany({ where: { guildId }, orderBy: { threshold: 'asc' } });
  if (steps.length === 0) {
    await interaction.reply(ephemeral('No escalation steps configured. Use `/moderation escalation set`.'));
    return;
  }
  const lines = steps.map(
    (s) => `• ${s.threshold} warning(s) → ${s.action}${s.action === 'mute' && s.duration ? ` (${s.duration}s)` : ''}`,
  );
  await interaction.reply(ephemeral(['**Escalation ladder**', ...lines].join('\n')));
}

// ── whitelist group ──────────────────────────────────────────────────────────
async function handleWhitelist(interaction: ChatInputCommandInteraction, sub: string): Promise<void> {
  const guildId = interaction.guildId!;
  await getGuildConfig(guildId);

  switch (sub) {
    case 'add-role': {
      const role = interaction.options.getRole('role', true);
      await prisma.whitelistRole.upsert({
        where: { guildId_roleId: { guildId, roleId: role.id } },
        create: { guildId, roleId: role.id },
        update: {},
      });
      await interaction.reply(ephemeral(`✅ Role <@&${role.id}> is now exempt from moderation.`));
      return;
    }
    case 'add-channel': {
      const channel = interaction.options.getChannel('channel', true);
      await prisma.whitelistChannel.upsert({
        where: { guildId_channelId: { guildId, channelId: channel.id } },
        create: { guildId, channelId: channel.id },
        update: {},
      });
      await interaction.reply(ephemeral(`✅ Channel <#${channel.id}> is now exempt from moderation.`));
      return;
    }
    case 'remove-role': {
      const role = interaction.options.getRole('role', true);
      await prisma.whitelistRole
        .delete({ where: { guildId_roleId: { guildId, roleId: role.id } } })
        .catch(() => null);
      invalidateRuleCache(guildId);
      await interaction.reply(ephemeral(`Removed role <@&${role.id}> from the whitelist.`));
      return;
    }
    case 'remove-channel': {
      const channel = interaction.options.getChannel('channel', true);
      await prisma.whitelistChannel
        .delete({ where: { guildId_channelId: { guildId, channelId: channel.id } } })
        .catch(() => null);
      await interaction.reply(ephemeral(`Removed channel <#${channel.id}> from the whitelist.`));
      return;
    }
    case 'list': {
      const [roles, channels] = await Promise.all([
        prisma.whitelistRole.findMany({ where: { guildId } }),
        prisma.whitelistChannel.findMany({ where: { guildId } }),
      ]);
      const roleStr = roles.length ? roles.map((r) => `<@&${r.roleId}>`).join(', ') : '—';
      const chanStr = channels.length ? channels.map((c) => `<#${c.channelId}>`).join(', ') : '—';
      await interaction.reply(ephemeral(`**Whitelisted roles:** ${roleStr}\n**Whitelisted channels:** ${chanStr}`));
      return;
    }
    default:
      await interaction.reply(ephemeral(`Unknown whitelist subcommand: ${sub}`));
  }
}

// ── status ───────────────────────────────────────────────────────────────────
async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const cfg = await getGuildConfig(guildId);
  const [ruleCount, warnCount, logCount] = await Promise.all([
    prisma.guildRule.count({ where: { guildId } }),
    prisma.warning.count({ where: { guildId, active: true } }),
    prisma.moderationLog.count({ where: { guildId } }),
  ]);
  const models = modelStatus();
  const mem = process.memoryUsage();
  const rssMb = (mem.rss / 1024 / 1024).toFixed(0);
  const heapMb = (mem.heapUsed / 1024 / 1024).toFixed(0);

  const modelLine = (enabled: boolean, loaded: boolean, failed: boolean): string => {
    if (!enabled) return 'disabled';
    if (failed) return 'failed (fallback active)';
    return loaded ? 'loaded' : 'not loaded yet';
  };

  const embed = new EmbedBuilder()
    .setTitle('Moderation status')
    .setColor(cfg.enabled ? 0x57f287 : 0xed4245)
    .addFields(
      { name: 'Enabled', value: cfg.enabled ? 'yes' : 'no', inline: true },
      { name: 'Rules', value: String(ruleCount), inline: true },
      { name: 'Active warnings', value: String(warnCount), inline: true },
      { name: 'Rules channel', value: cfg.rulesChannelId ? `<#${cfg.rulesChannelId}>` : '—', inline: true },
      { name: 'Log channel', value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : '—', inline: true },
      { name: 'Default action', value: cfg.defaultAction, inline: true },
      {
        name: 'Toxicity model',
        value: modelLine(models.toxicityEnabled, models.toxicityLoaded, models.toxicityFailed),
        inline: true,
      },
      {
        name: 'Embedding model',
        value: modelLine(models.embeddingsEnabled, models.embeddingsLoaded, models.embeddingsFailed),
        inline: true,
      },
      { name: 'Memory (RSS / heap)', value: `${rssMb} MB / ${heapMb} MB`, inline: true },
      {
        name: 'Thresholds',
        value: `similarity ${cfg.similarityThreshold}, toxicity ${cfg.toxicityThreshold}`,
        inline: true,
      },
      { name: 'Log entries', value: String(logCount), inline: true },
      {
        name: 'Last sync',
        value: cfg.lastSyncAt ? `<t:${Math.floor(cfg.lastSyncAt.getTime() / 1000)}:R>` : 'never',
        inline: true,
      },
    );

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

// ── logs ─────────────────────────────────────────────────────────────────────
async function handleLogs(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const user = interaction.options.getUser('user');
  const limit = interaction.options.getInteger('limit') ?? 10;

  const logs = await prisma.moderationLog.findMany({
    where: { guildId, ...(user ? { userId: user.id } : {}) },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  if (logs.length === 0) {
    await interaction.reply(ephemeral('No moderation logs yet.'));
    return;
  }
  const lines = logs.map((l) => {
    const ts = `<t:${Math.floor(l.createdAt.getTime() / 1000)}:R>`;
    return `${ts} • **${l.action}** • <@${l.userId}>${l.ruleId ? ` • rule #${l.ruleId}` : ''}\n  ↳ ${truncate(l.reason, 120)}`;
  });
  const embed = new EmbedBuilder()
    .setTitle(`Recent moderation${user ? ` for ${user.tag}` : ''}`)
    .setColor(0x5865f2)
    .setDescription(truncate(lines.join('\n'), 4000));
  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}
