import {
  bigint,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const registryPortalInstallations = pgTable(
  'registry_portal_installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    memberId: text('member_id').notNull(),
    domain: text('domain').notNull(),
    portalUrl: text('portal_url').notNull(),
    status: text('status').notNull().default('active'),
    accessTokenEncrypted: text('access_token_encrypted').notNull(),
    refreshTokenEncrypted: text('refresh_token_encrypted'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    applicationTokenHash: text('application_token_hash').notNull(),
    diskRootFolderId: bigint('disk_root_folder_id', { mode: 'number' }),
    installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
    uninstalledAt: timestamp('uninstalled_at', { withTimezone: true }),
    deleteAfter: timestamp('delete_after', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('registry_portal_installations_member_uidx').on(table.memberId),
    uniqueIndex('registry_portal_installations_domain_uidx').on(table.domain),
    uniqueIndex('registry_portal_installations_url_uidx').on(table.portalUrl),
    index('registry_portal_installations_retention_idx').on(table.status, table.deleteAfter),
  ],
);
