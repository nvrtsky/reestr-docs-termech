import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

import { registryDocumentTypes, registrySections } from './catalogs.js';
import {
  attachmentKindEnum,
  entityTypeEnum,
  fieldDataTypeEnum,
} from './enums.js';

export const registryDocuments = pgTable(
  'registry_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    sectionId: uuid('section_id')
      .notNull()
      .references(() => registrySections.id, { onDelete: 'restrict' }),
    typeId: uuid('type_id')
      .notNull()
      .references(() => registryDocumentTypes.id, { onDelete: 'restrict' }),
    number: text('number'),
    title: text('title').notNull(),
    documentDate: date('document_date', { mode: 'string' }).notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    amount: numeric('amount', { precision: 18, scale: 2 }),
    currency: varchar('currency', { length: 3 }),
    legalEntityId: bigint('legal_entity_id', { mode: 'number' }),
    legalEntityName: text('legal_entity_name'),
    counterpartyId: bigint('counterparty_id', { mode: 'number' }),
    counterpartyName: text('counterparty_name'),
    dealStageId: text('deal_stage_id'),
    status: text('status').notNull(),
    comment: text('comment'),
    responsibleId: bigint('responsible_id', { mode: 'number' }).notNull(),
    responsibleName: text('responsible_name'),
    createdBy: bigint('created_by', { mode: 'number' }).notNull(),
    updatedBy: bigint('updated_by', { mode: 'number' }),
    supersedesId: uuid('supersedes_id'),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: bigint('deleted_by', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('registry_documents_portal_number_uidx').on(
      table.portalUrl,
      table.typeId,
      table.legalEntityId,
      table.number,
    ),
    index('registry_documents_portal_status_idx').on(
      table.portalUrl,
      table.status,
      table.deletedAt,
    ),
    index('registry_documents_portal_section_idx').on(
      table.portalUrl,
      table.sectionId,
      table.deletedAt,
    ),
    index('registry_documents_portal_type_idx').on(
      table.portalUrl,
      table.typeId,
      table.deletedAt,
    ),
    index('registry_documents_portal_counterparty_idx').on(
      table.portalUrl,
      table.counterpartyId,
      table.deletedAt,
    ),
    index('registry_documents_portal_responsible_idx').on(
      table.portalUrl,
      table.responsibleId,
      table.deletedAt,
    ),
    index('registry_documents_portal_date_idx').on(
      table.portalUrl,
      table.documentDate,
    ),
  ],
);

export const registryDocumentLinks = pgTable(
  'registry_document_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => registryDocuments.id, { onDelete: 'cascade' }),
    entityType: entityTypeEnum('entity_type').notNull(),
    entityId: bigint('entity_id', { mode: 'number' }).notNull(),
    entityTitle: text('entity_title').notNull(),
    linkRole: text('link_role'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('registry_document_links_entity_uidx').on(
      table.portalUrl,
      table.documentId,
      table.entityType,
      table.entityId,
    ),
    index('registry_document_links_lookup_idx').on(
      table.portalUrl,
      table.entityType,
      table.entityId,
    ),
  ],
);

export const registryAttachments = pgTable(
  'registry_attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => registryDocuments.id, { onDelete: 'cascade' }),
    kind: attachmentKindEnum('kind').notNull(),
    name: text('name').notNull(),
    mimeType: text('mime_type'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    diskFileId: bigint('disk_file_id', { mode: 'number' }),
    diskFolderId: bigint('disk_folder_id', { mode: 'number' }),
    url: text('url'),
    version: integer('version').notNull().default(1),
    isPrimary: boolean('is_primary').notNull().default(false),
    isCurrent: boolean('is_current').notNull().default(true),
    replacesAttachmentId: uuid('replaces_attachment_id'),
    createdBy: bigint('created_by', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('registry_attachments_document_idx').on(
      table.portalUrl,
      table.documentId,
      table.isCurrent,
    ),
  ],
);

export const registryFieldDefinitions = pgTable(
  'registry_field_definitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    dataType: fieldDataTypeEnum('data_type').notNull(),
    options: jsonb('options').$type<unknown[]>(),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('registry_field_definitions_portal_key_uidx').on(
      table.portalUrl,
      table.key,
    ),
  ],
);

export const registryTypeFields = pgTable(
  'registry_type_fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    typeId: uuid('type_id')
      .notNull()
      .references(() => registryDocumentTypes.id, { onDelete: 'cascade' }),
    fieldDefinitionId: uuid('field_definition_id')
      .notNull()
      .references(() => registryFieldDefinitions.id, { onDelete: 'restrict' }),
    sortOrder: integer('sort_order').notNull().default(100),
    isRequired: boolean('is_required').notNull().default(false),
    labelOverride: text('label_override'),
    optionsOverride: jsonb('options_override').$type<unknown[]>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('registry_type_fields_type_field_uidx').on(
      table.portalUrl,
      table.typeId,
      table.fieldDefinitionId,
    ),
    index('registry_type_fields_type_sort_idx').on(
      table.portalUrl,
      table.typeId,
      table.sortOrder,
    ),
  ],
);

export const registryDocumentFieldValues = pgTable(
  'registry_document_field_values',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => registryDocuments.id, { onDelete: 'cascade' }),
    fieldDefinitionId: uuid('field_definition_id')
      .notNull()
      .references(() => registryFieldDefinitions.id, { onDelete: 'restrict' }),
    value: jsonb('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('registry_document_field_values_document_field_uidx').on(
      table.portalUrl,
      table.documentId,
      table.fieldDefinitionId,
    ),
  ],
);

export const registryAuditLog = pgTable(
  'registry_audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => registryDocuments.id, { onDelete: 'cascade' }),
    event: text('event').notNull(),
    actorId: bigint('actor_id', { mode: 'number' }),
    actorName: text('actor_name'),
    before: jsonb('before'),
    after: jsonb('after'),
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('registry_audit_log_document_idx').on(
      table.portalUrl,
      table.documentId,
      table.createdAt,
    ),
  ],
);
