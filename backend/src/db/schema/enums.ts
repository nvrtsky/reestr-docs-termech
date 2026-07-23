import { pgEnum } from 'drizzle-orm/pg-core';

export const attachmentKindEnum = pgEnum('registry_attachment_kind', [
  'file',
  'link',
]);

export const entityTypeEnum = pgEnum('registry_entity_type', [
  'deal',
  'company',
]);

export const fieldDataTypeEnum = pgEnum('registry_field_data_type', [
  'text',
  'number',
  'date',
  'money',
  'select',
  'boolean',
  'file',
]);
