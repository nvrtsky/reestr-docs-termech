import {
  bigint,
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
    numberFormat: text('number_format'),
    numberAutoGenerate: boolean('number_auto_generate').notNull().default(false),
    numberUniquenessEnabled: boolean('number_uniqueness_enabled').notNull().default(false),
    contentRequired: boolean('content_required').notNull().default(true),
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

export const registryDocumentTypeSections = pgTable(
  'registry_document_type_sections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => registryDocumentTypes.id, { onDelete: 'cascade' }),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => registrySections.id, { onDelete: 'restrict' }),
    sortOrder: integer('sort_order').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('registry_document_type_sections_scope_uidx').on(
      table.portalUrl,
      table.typeId,
      table.sectionId,
    ),
    index('registry_document_type_sections_portal_section_idx').on(
      table.portalUrl,
      table.sectionId,
      table.sortOrder,
    ),
  ],
);

export const registryNumberSequences = pgTable(
  'registry_number_sequences',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => registryDocumentTypes.id, { onDelete: 'cascade' }),
    companyScope: bigint('company_scope', { mode: 'number' }).notNull().default(0),
    lastValue: integer('last_value').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('registry_number_sequences_scope_uidx').on(
      table.portalUrl,
      table.typeId,
      table.companyScope,
    ),
  ],
);
