import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { disconnectDb } from './db.js';
import * as readyEvent from './events/ready.js';
import * as messageCreateEvent from './events/messageCreate.js';
import * as interactionCreateEvent from './events/interactionCreate.js';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.MessageContent, // privileged — enable in the Dev Portal
  ],
  partials: [Partials.Channel],
});

// Wire up events.
client.once(readyEvent.name, (...args) => void readyEvent.execute(args[0]));
client.on(messageCreateEvent.name, (...args) => void messageCreateEvent.execute(args[0]));
client.on(interactionCreateEvent.name, (...args) => void interactionCreateEvent.execute(args[0]));

client.on('error', (err) => logger.error('Client error:', err.message));
client.on('warn', (info) => logger.warn('Client warning:', info));

async function shutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down…`);
  try {
    await client.destroy();
    await disconnectDb();
  } catch (err) {
    logger.error('Error during shutdown:', err instanceof Error ? err.message : err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) =>
  logger.error('Unhandled rejection:', reason instanceof Error ? reason.stack ?? reason.message : reason),
);

client.login(config.discordToken).catch((err) => {
  logger.error('Failed to log in. Check DISCORD_TOKEN.', err instanceof Error ? err.message : err);
  process.exit(1);
});
