import { randomUUID } from 'node:crypto';

import { and, asc, count, eq } from 'drizzle-orm';
import { Router } from 'express';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { Database } from '../db/database.js';
import {
  registryDocumentTypes,
  registryDepartmentRoles,
  registryFieldDefinitions,
  registryLifecycles,
  registryRolePolicies,
  registrySections,
  registryUserRoles,
} from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import { requireRegistryContext } from '../http/registry-context.js';
import { loadRegistryPolicy } from '../permissions/policy.service.js';
import { listBitrixUsers } from '../users/bitrix-users.service.js';
import {
  replaceUserRolesSchema,
  updateRolePolicySchema,
  type UpdateRolePolicyInput,
} from './administration.schemas.js';

interface AdministrationRouterDependencies {
  database: Database;
  bitrix: BitrixApiClient;
}

export async function requireAdministrator(database: Database, request: Parameters<typeof requireRegistryContext>[0]) {
  const context = requireRegistryContext(request);
  const policy = await loadRegistryPolicy(database, context);
  if (!policy.permissions.administer) {
    throw new ApiError(403, 'registry_admin_required', 'Registry administrator access is required.');
  }
  return { context, policy };
}

function assertUnique(values: string[], code: string, label: string) {
  if (new Set(values).size !== values.length) {
    throw new ApiError(400, code, `${label} contains duplicate values.`);
  }
}

async function assertRolePolicyReferences(
  database: Database,
  portalUrl: string,
  input: UpdateRolePolicyInput,
) {
  assertUnique(input.visibleSectionCodes, 'duplicate_visible_section', 'Visible sections');
  if (input.visibleTypeCodes) {
    assertUnique(input.visibleTypeCodes, 'duplicate_visible_type', 'Visible types');
  }
  assertUnique(input.hiddenFields, 'duplicate_hidden_field', 'Hidden fields');

  const [sections, types, fieldDefinitions] = await Promise.all([
    database
      .select({ code: registrySections.code })
      .from(registrySections)
      .where(and(eq(registrySections.portalUrl, portalUrl), eq(registrySections.isActive, true))),
    database
      .select({ code: registryDocumentTypes.code, sectionCode: registrySections.code })
      .from(registryDocumentTypes)
      .innerJoin(registrySections, eq(registryDocumentTypes.sectionId, registrySections.id))
      .where(
        and(
          eq(registryDocumentTypes.portalUrl, portalUrl),
          eq(registryDocumentTypes.isActive, true),
          eq(registrySections.portalUrl, portalUrl),
          eq(registrySections.isActive, true),
        ),
      ),
    database
      .select({ key: registryFieldDefinitions.key })
      .from(registryFieldDefinitions)
      .where(
        and(
          eq(registryFieldDefinitions.portalUrl, portalUrl),
          eq(registryFieldDefinitions.isActive, true),
        ),
      ),
  ]);

  const knownSections = new Set(sections.map((section) => section.code));
  for (const sectionCode of input.visibleSectionCodes) {
    if (!knownSections.has(sectionCode)) {
      throw new ApiError(400, 'section_not_found', `Section ${sectionCode} was not found.`);
    }
  }
  if (input.visibleTypeCodes) {
    const typeByCode = new Map(types.map((type) => [type.code, type]));
    const visibleSections = new Set(input.visibleSectionCodes);
    for (const typeCode of input.visibleTypeCodes) {
      const type = typeByCode.get(typeCode);
      if (!type) throw new ApiError(400, 'document_type_not_found', `Type ${typeCode} was not found.`);
      if (!visibleSections.has(type.sectionCode)) {
        throw new ApiError(
          400,
          'type_section_not_visible',
          `Type ${typeCode} belongs to hidden section ${type.sectionCode}.`,
        );
      }
    }
  }
  const knownFields = new Set(['amount', 'currency', ...fieldDefinitions.map((field) => field.key)]);
  for (const fieldKey of input.hiddenFields) {
    if (!knownFields.has(fieldKey)) {
      throw new ApiError(400, 'field_definition_not_found', `Field ${fieldKey} was not found.`);
    }
  }

  return { knownSections };
}

export function createAdministrationRouter({ database, bitrix }: AdministrationRouterDependencies) {
  const router = Router();

  router.get('/role-policies', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const items = await database
        .select({
          roleCode: registryRolePolicies.roleCode,
          roleName: registryRolePolicies.roleName,
          visibleSectionCodes: registryRolePolicies.visibleSectionCodes,
          visibleTypeCodes: registryRolePolicies.visibleTypeCodes,
          hiddenFields: registryRolePolicies.hiddenFields,
          permissions: registryRolePolicies.permissions,
          hideMoney: registryRolePolicies.hideMoney,
          isActive: registryRolePolicies.isActive,
        })
        .from(registryRolePolicies)
        .where(eq(registryRolePolicies.portalUrl, context.portalUrl))
        .orderBy(asc(registryRolePolicies.roleName));
      response.json({ items });
    } catch (error) {
      next(error);
    }
  });

  router.post('/role-policies', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const input = updateRolePolicySchema.parse(request.body);
      if (input.permissions.administer) {
        throw new ApiError(
          400,
          'custom_role_administration_denied',
          'Administration access is reserved for Bitrix24 administrators.',
        );
      }
      await assertRolePolicyReferences(database, context.portalUrl, input);
      const roleCode = `custom_${randomUUID().replaceAll('-', '')}`;
      const [created] = await database
        .insert(registryRolePolicies)
        .values({
          portalUrl: context.portalUrl,
          roleCode,
          roleName: input.roleName,
          visibleSectionCodes: input.visibleSectionCodes,
          visibleTypeCodes: input.visibleTypeCodes,
          hiddenFields: input.hiddenFields,
          permissions: input.permissions,
          hideMoney: input.hideMoney,
          isActive: input.isActive,
        })
        .returning({
          roleCode: registryRolePolicies.roleCode,
          roleName: registryRolePolicies.roleName,
          visibleSectionCodes: registryRolePolicies.visibleSectionCodes,
          visibleTypeCodes: registryRolePolicies.visibleTypeCodes,
          hiddenFields: registryRolePolicies.hiddenFields,
          permissions: registryRolePolicies.permissions,
          hideMoney: registryRolePolicies.hideMoney,
          isActive: registryRolePolicies.isActive,
        });
      response.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  router.put('/role-policies/:roleCode', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const roleCode = request.params.roleCode?.trim();
      if (!roleCode) throw new ApiError(400, 'role_code_required', 'Role code is required.');
      const input = updateRolePolicySchema.parse(request.body);
      if (roleCode === 'admin' && (!input.isActive || !input.permissions.administer)) {
        throw new ApiError(
          409,
          'cannot_disable_administrator_policy',
          'The Bitrix24 administrator policy must remain active with administration access.',
        );
      }
      if (roleCode !== 'admin' && input.permissions.administer) {
        throw new ApiError(
          400,
          'custom_role_administration_denied',
          'Administration access is reserved for Bitrix24 administrators.',
        );
      }
      const references = await assertRolePolicyReferences(database, context.portalUrl, input);
      if (roleCode === 'admin') {
        const visibleSections = new Set(input.visibleSectionCodes);
        const hasAllSections = visibleSections.size === references.knownSections.size
          && [...references.knownSections].every((code) => visibleSections.has(code));
        const hasAllPermissions = Object.values(input.permissions).every(Boolean);
        if (
          input.roleName !== 'Администратор'
          || !hasAllSections
          || input.visibleTypeCodes !== null
          || input.hiddenFields.length > 0
          || input.hideMoney
          || !hasAllPermissions
        ) {
          throw new ApiError(
            409,
            'administrator_policy_must_be_full',
            'The Bitrix24 administrator policy must keep full registry access.',
          );
        }
      }

      const targetPolicy = await database
        .select({ id: registryRolePolicies.id })
        .from(registryRolePolicies)
        .where(
          and(
            eq(registryRolePolicies.portalUrl, context.portalUrl),
            eq(registryRolePolicies.roleCode, roleCode),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      if (!targetPolicy) throw new ApiError(404, 'role_policy_not_found', 'Role policy was not found.');

      const [updated] = await database
        .update(registryRolePolicies)
        .set({
          roleName: input.roleName,
          visibleSectionCodes: input.visibleSectionCodes,
          visibleTypeCodes: input.visibleTypeCodes,
          hiddenFields: input.hiddenFields,
          permissions: input.permissions,
          hideMoney: input.hideMoney,
          isActive: input.isActive,
          updatedAt: new Date(),
        })
        .where(eq(registryRolePolicies.id, targetPolicy.id))
        .returning({
          roleCode: registryRolePolicies.roleCode,
          roleName: registryRolePolicies.roleName,
          visibleSectionCodes: registryRolePolicies.visibleSectionCodes,
          visibleTypeCodes: registryRolePolicies.visibleTypeCodes,
          hiddenFields: registryRolePolicies.hiddenFields,
          permissions: registryRolePolicies.permissions,
          hideMoney: registryRolePolicies.hideMoney,
          isActive: registryRolePolicies.isActive,
        });
      response.json(updated);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/role-policies/:roleCode', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const roleCode = request.params.roleCode?.trim();
      if (!roleCode) throw new ApiError(400, 'role_code_required', 'Role code is required.');
      if (roleCode === 'admin') {
        throw new ApiError(
          409,
          'cannot_delete_administrator_policy',
          'Роль администратора Bitrix24 удалить нельзя.',
        );
      }
      const policy = await database
        .select({ id: registryRolePolicies.id })
        .from(registryRolePolicies)
        .where(
          and(
            eq(registryRolePolicies.portalUrl, context.portalUrl),
            eq(registryRolePolicies.roleCode, roleCode),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      if (!policy) throw new ApiError(404, 'role_policy_not_found', 'Role policy was not found.');
      const [userUsage, departmentUsage, lifecycles] = await Promise.all([
        database
          .select({ value: count(registryUserRoles.id) })
          .from(registryUserRoles)
          .where(
            and(
              eq(registryUserRoles.portalUrl, context.portalUrl),
              eq(registryUserRoles.roleCode, roleCode),
            ),
          )
          .then((rows) => rows[0]),
        database
          .select({ value: count(registryDepartmentRoles.id) })
          .from(registryDepartmentRoles)
          .where(
            and(
              eq(registryDepartmentRoles.portalUrl, context.portalUrl),
              eq(registryDepartmentRoles.roleCode, roleCode),
            ),
          )
          .then((rows) => rows[0]),
        database
          .select({ name: registryLifecycles.name, config: registryLifecycles.config })
          .from(registryLifecycles)
          .where(eq(registryLifecycles.portalUrl, context.portalUrl)),
      ]);
      if ((userUsage?.value ?? 0) > 0 || (departmentUsage?.value ?? 0) > 0) {
        throw new ApiError(
          409,
          'role_policy_in_use',
          'Нельзя удалить роль, пока она назначена пользователям или подразделениям.',
        );
      }
      const lifecycleUsage = lifecycles.find((lifecycle) =>
        lifecycle.config.transitions.some((transition) =>
          transition.roles?.includes(roleCode)),
      );
      if (lifecycleUsage) {
        throw new ApiError(
          409,
          'role_policy_in_lifecycle',
          `Нельзя удалить роль: она используется в жизненном цикле «${lifecycleUsage.name}».`,
        );
      }
      await database
        .delete(registryRolePolicies)
        .where(eq(registryRolePolicies.id, policy.id));
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get('/user-roles', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const [items, users] = await Promise.all([
        database
          .select({
            userId: registryUserRoles.userId,
            userName: registryUserRoles.userName,
            roleCode: registryUserRoles.roleCode,
          })
          .from(registryUserRoles)
          .where(eq(registryUserRoles.portalUrl, context.portalUrl))
          .orderBy(asc(registryUserRoles.userName), asc(registryUserRoles.userId)),
        listBitrixUsers(context, bitrix),
      ]);
      response.json({ items, users });
    } catch (error) {
      next(error);
    }
  });

  router.put('/user-roles', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const input = replaceUserRolesSchema.parse(request.body);
      const activePolicies = await database
        .select({ roleCode: registryRolePolicies.roleCode })
        .from(registryRolePolicies)
        .where(
          and(
            eq(registryRolePolicies.portalUrl, context.portalUrl),
            eq(registryRolePolicies.isActive, true),
          ),
        );
      const activeRoleCodes = new Set(
        activePolicies.map((policy) => policy.roleCode).filter((roleCode) => roleCode !== 'admin'),
      );
      for (const item of input.items) {
        if (!activeRoleCodes.has(item.roleCode)) {
          throw new ApiError(400, 'role_policy_not_found', `Active role ${item.roleCode} was not found.`);
        }
      }

      await database.transaction(async (transaction) => {
        await transaction
          .delete(registryUserRoles)
          .where(eq(registryUserRoles.portalUrl, context.portalUrl));
        if (input.items.length) {
          await transaction.insert(registryUserRoles).values(
            input.items.map((item) => ({
              portalUrl: context.portalUrl,
              userId: item.userId,
              userName: item.userName ?? null,
              roleCode: item.roleCode,
              assignedBy: context.userId,
            })),
          );
        }
      });
      response.json({ items: input.items });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
