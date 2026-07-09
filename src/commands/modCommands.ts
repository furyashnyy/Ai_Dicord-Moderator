import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

/**
 * Manual moderation slash commands for the mod team (used directly, alongside
 * the automatic rule-based moderation). Each command is gated in code by the
 * matching Discord permission; `setDefaultMemberPermissions` also hides it from
 * members who lack that permission.
 */

const warn = new SlashCommandBuilder()
  .setName('warn')
  .setDescription('Warn a member (feeds the escalation ladder)')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('user').setDescription('Member to warn').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason').setRequired(true));

const warnings = new SlashCommandBuilder()
  .setName('warnings')
  .setDescription("Show a member's active warnings")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true));

const clearwarnings = new SlashCommandBuilder()
  .setName('clearwarnings')
  .setDescription("Clear a member's active warnings")
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true));

const timeout = new SlashCommandBuilder()
  .setName('timeout')
  .setDescription('Time out (mute) a member')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('user').setDescription('Member to time out').setRequired(true))
  .addStringOption((o) =>
    o.setName('duration').setDescription('e.g. 30m, 1h, 1d, 45s, 1w (bare number = minutes)').setRequired(true),
  )
  .addStringOption((o) => o.setName('reason').setDescription('Reason'));

const untimeout = new SlashCommandBuilder()
  .setName('untimeout')
  .setDescription('Remove a timeout from a member')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption((o) => o.setName('user').setDescription('Member').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason'));

const kick = new SlashCommandBuilder()
  .setName('kick')
  .setDescription('Kick a member')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
  .addUserOption((o) => o.setName('user').setDescription('Member to kick').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason'));

const ban = new SlashCommandBuilder()
  .setName('ban')
  .setDescription('Ban a member')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addUserOption((o) => o.setName('user').setDescription('Member to ban').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason'))
  .addIntegerOption((o) =>
    o.setName('delete-days').setDescription('Delete this many days of their messages (0-7)').setMinValue(0).setMaxValue(7),
  );

const unban = new SlashCommandBuilder()
  .setName('unban')
  .setDescription('Unban a user by ID')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addStringOption((o) => o.setName('user-id').setDescription('User ID to unban').setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Reason'));

const purge = new SlashCommandBuilder()
  .setName('purge')
  .setDescription('Bulk-delete recent messages in this channel')
  .setDMPermission(false)
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addIntegerOption((o) =>
    o.setName('amount').setDescription('How many messages (1-100)').setRequired(true).setMinValue(1).setMaxValue(100),
  )
  .addUserOption((o) => o.setName('user').setDescription('Only delete messages from this user'));

const rules = new SlashCommandBuilder()
  .setName('rules')
  .setDescription("Show this server's parsed moderation rules")
  .setDMPermission(false);

export const modCommands = [
  warn,
  warnings,
  clearwarnings,
  timeout,
  untimeout,
  kick,
  ban,
  unban,
  purge,
  rules,
].map((c) => c.toJSON());

export const modCommandNames = new Set([
  'warn',
  'warnings',
  'clearwarnings',
  'timeout',
  'untimeout',
  'kick',
  'ban',
  'unban',
  'purge',
  'rules',
]);
