import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import type { AppConfig } from '../config.js';
import * as schema from './schema/index.js';

export function createDatabase(config: AppConfig) {
  const client = postgres(config.DATABASE_URL, {
    max: config.NODE_ENV === 'production' ? 10 : 3,
    idle_timeout: 20,
    connect_timeout: 10,
  });
  const db = drizzle(client, { schema });

  return {
    client,
    db,
    async checkConnection() {
      await db.execute(sql`select 1`);
    },
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}

export type Database = ReturnType<typeof createDatabase>['db'];
