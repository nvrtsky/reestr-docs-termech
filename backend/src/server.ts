import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabase } from './db/database.js';
import { logger } from './logger.js';

const config = loadConfig();
const database = createDatabase(config);
const app = createApp({
  config,
  database: database.db,
  readinessCheck: database.checkConnection,
});

const server = app.listen(config.API_PORT, config.API_HOST, () => {
  logger.info(
    { host: config.API_HOST, port: config.API_PORT },
    'Registry API is listening',
  );
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutting down registry API');
  server.close(async () => {
    await database.close();
    process.exit(0);
  });
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
