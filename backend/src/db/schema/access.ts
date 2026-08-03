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

export interface TypePermissions {
  view: boolean;
  create: boolean;
  edit: boolean;
  transition: boolean;
  archive: boolean;
  export: boolean;
  finance: boolean;
}

export interface RolePermissions {
  create: boolean;
  editOwn: boolean;
  editAny: boolean;
  transitionOwn: boolean;
  transitionAny: boolean;
  softDelete: boolean;
  restore: boolean;
  export: boolean;
  administer: boolean;
  byType?: Record<string, TypePermissions>;
}

export const registryRolePolicies = pgTable(
  'registry_role_policies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    roleCode: text('role_code').notNull(),
    roleName: text('role_name').notNull(),
    visibleSectionCodes: jsonb('visible_section_codes').$type<string[]>().notNull(),
    visibleTypeCodes: jsonb('visible_type_codes').$type<string[]>(),
    hiddenFields: jsonb('hidden_fields').$type<string[]>().notNull(),
    permissions: jsonb('permissions').$type<RolePermissions>().notNull(),
    hideMoney: boolean('hide_money').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('registry_role_policies_portal_role_uidx').on(
      table.portalUrl,
      table.roleCode,
    ),
  ],
);

export const registryDepartmentRoles = pgTable(
  'registry_department_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    departmentId: bigint('department_id', { mode: 'number' }).notNull(),
    roleCode: text('role_code').notNull(),
    priority: integer('priority').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('registry_department_roles_portal_department_role_uidx').on(
      table.portalUrl,
      table.departmentId,
      table.roleCode,
    ),
  ],
);

export const registryUserRoles = pgTable(
  'registry_user_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    userName: text('user_name'),
    roleCode: text('role_code').notNull(),
    assignedBy: bigint('assigned_by', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('registry_user_roles_portal_user_uidx').on(
      table.portalUrl,
      table.userId,
    ),
    index('registry_user_roles_portal_role_idx').on(
      table.portalUrl,
      table.roleCode,
    ),
  ],
);

export const registrySavedViews = pgTable(
  'registry_saved_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    ownerUserId: bigint('owner_user_id', { mode: 'number' }),
    name: text('name').notNull(),
    filters: jsonb('filters').$type<Record<string, unknown>>().notNull(),
    columns: jsonb('columns').$type<string[]>().notNull(),
    isShared: boolean('is_shared').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(100),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('registry_saved_views_owner_idx').on(
      table.portalUrl,
      table.ownerUserId,
      table.sortOrder,
    ),
  ],
);

export const registrySettings = pgTable(
  'registry_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    portalUrl: text('portal_url').notNull(),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('registry_settings_portal_key_uidx').on(
      table.portalUrl,
      table.key,
    ),
  ],
);
