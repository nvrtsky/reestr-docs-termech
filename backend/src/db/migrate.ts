import { migrate } from 'drizzle-orm/postgres-js/migrator';

import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { createDatabase } from './database.js';

const database = createDatabase(loadConfig());

try {
  await migrate(database.db, { migrationsFolder: './drizzle' });
  logger.info('Database migrations completed');
} finally {
  await database.close();
}
