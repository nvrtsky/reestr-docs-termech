import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export interface LifecycleConfig {
  initialStatus: string;
  states: Array<{
    code: string;
    label: string;
    color?: string;
    terminal?: boolean;
  }>;
  transitions: Array<{
    from: string;
    to: string;
    roles?: string[];
    requiresAttachment?: boolean;
  }>;
}

export const registrySections = pgTable(
  'registry_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    color: text('color'),
    sortOrder: integer('sort_order').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('registry_sections_portal_code_uidx').on(
      table.portalUrl,
      table.code,
    ),
    index('registry_sections_portal_sort_idx').on(
      table.portalUrl,
      table.sortOrder,
    ),
  ],
);

export const registryLifecycles = pgTable(
  'registry_lifecycles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    config: jsonb('config').$type<LifecycleConfig>().notNull(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('registry_lifecycles_portal_code_uidx').on(
      table.portalUrl,
      table.code,
    ),
  ],
);

export const registryDocumentTypes = pgTable(
  'registry_document_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => registrySections.id, { onDelete: 'restrict' }),
    lifecycleId: uuid('lifecycle_id').references(() => registryLifecycles.id, {
      onDelete: 'set null',
    }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isFinancial: boolean('is_financial').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('registry_document_types_portal_code_uidx').on(
      table.portalUrl,
      table.code,
    ),
    index('registry_document_types_portal_section_idx').on(
      table.portalUrl,
      table.sectionId,
      table.sortOrder,
    ),
  ],
);
