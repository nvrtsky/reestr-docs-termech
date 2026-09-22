import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { createDatabase } from './database.js';
import { seedPortal } from './portal-seed.js';

const portalUrl = (process.env.SEED_PORTAL_URL ?? 'https://thermech.bitrix24.ru').replace(/\/$/, '');
const folderId = Number(process.env.SEED_DISK_ROOT_FOLDER_ID || 0) || undefined;
const database = createDatabase(loadConfig());

try {
  await seedPortal(database.db, portalUrl, folderId);
  logger.info({ portalUrl }, 'Database seed completed');
} finally {
  await database.close();
}
