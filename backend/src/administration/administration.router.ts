import { randomUUID } from 'node:crypto';

import { and, asc, count, eq } from 'drizzle-orm';
import { Router } from 'express';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import { loadKnownBitrixAdminIds } from '../bitrix/bitrix-admin-users.repository.js';
import { loadBitrixEventTokenHash } from '../bitrix/bitrix-event-token.repository.js';
import type { Database } from '../db/database.js';
import {
  registryDocumentTypeSections,
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
import { listBitrixDepartments } from '../users/bitrix-departments.service.js';
import { listBitrixUsers } from '../users/bitrix-users.service.js';
import {
  replaceDepartmentRolesSchema,
  replaceUserRolesSchema,
  updateRolePolicySchema,
  type UpdateRolePolicyInput,
} from './administration.schemas.js';
import { BitrixIntegrationsService } from './bitrix-integrations.service.js';

interface AdministrationRouterDependencies {
  database: Database;
  bitrix: BitrixApiClient;
  bitrixEventHandlerUrl: string;
  bitrixPlacementHandlerUrl: string;
  bitrixEventTokenConfigured: boolean;
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
      .innerJoin(
        registryDocumentTypeSections,
        eq(registryDocumentTypes.id, registryDocumentTypeSections.typeId),
      )
      .innerJoin(registrySections, eq(registryDocumentTypeSections.sectionId, registrySections.id))
      .where(
        and(
          eq(registryDocumentTypes.portalUrl, portalUrl),
          eq(registryDocumentTypeSections.portalUrl, portalUrl),
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
  const typeSectionsByCode = new Map<string, Set<string>>();
  for (const type of types) {
    const sectionCodes = typeSectionsByCode.get(type.code) ?? new Set<string>();
    sectionCodes.add(type.sectionCode);
    typeSectionsByCode.set(type.code, sectionCodes);
  }
  const visibleSections = new Set(input.visibleSectionCodes);
  for (const sectionCode of input.visibleSectionCodes) {
    if (!knownSections.has(sectionCode)) {
      throw new ApiError(400, 'section_not_found', `Section ${sectionCode} was not found.`);
    }
  }
  if (input.visibleTypeCodes) {
    for (const typeCode of input.visibleTypeCodes) {
      const typeSections = typeSectionsByCode.get(typeCode);
      if (!typeSections) throw new ApiError(400, 'document_type_not_found', `Type ${typeCode} was not found.`);
      if (![...typeSections].some((sectionCode) => visibleSections.has(sectionCode))) {
        throw new ApiError(
          400,
          'type_section_not_visible',
          `Type ${typeCode} is not connected to a visible section.`,
        );
      }
    }
  }
  for (const typeCode of Object.keys(input.permissions.byType)) {
    const typeSections = typeSectionsByCode.get(typeCode);
    if (!typeSections) {
      throw new ApiError(400, 'document_type_not_found', `Type ${typeCode} was not found.`);
    }
    if (![...typeSections].some((sectionCode) => visibleSections.has(sectionCode))) {
      throw new ApiError(
        400,
        'type_section_not_visible',
        `Type ${typeCode} is not connected to a visible section.`,
      );
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

export function createAdministrationRouter({
  database,
  bitrix,
  bitrixEventHandlerUrl,
  bitrixPlacementHandlerUrl,
  bitrixEventTokenConfigured,
}: AdministrationRouterDependencies) {
  const router = Router();
  const integrations = new BitrixIntegrationsService(
    bitrix,
    bitrixEventHandlerUrl,
    bitrixPlacementHandlerUrl,
  );

  router.get('/integrations', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const [status, storedTokenHash] = await Promise.all([
        integrations.status(context),
        loadBitrixEventTokenHash(database, context.portalUrl),
      ]);
      response.json({
        ...status,
        eventTokenConfigured: bitrixEventTokenConfigured || !!storedTokenHash,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/integrations/ensure', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const storedTokenHash = await loadBitrixEventTokenHash(database, context.portalUrl);
      if (!bitrixEventTokenConfigured && !storedTokenHash) {
        throw new ApiError(
          503,
          'bitrix_event_token_not_configured',
          'Bitrix24 event token is not configured.',
        );
      }
      response.json(await integrations.ensure(context));
    } catch (error) {
      next(error);
    }
  });

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
        const { byType, ...basePermissions } = input.permissions;
        const hasAllPermissions = Object.values(basePermissions).every(Boolean)
          && Object.keys(byType).length === 0;
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
      const [items, loadedUsers, knownBitrixAdminIds] = await Promise.all([
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
        loadKnownBitrixAdminIds(database, context.portalUrl),
      ]);
      const users = loadedUsers.map((user) => ({
        ...user,
        isBitrixAdmin: user.isBitrixAdmin || knownBitrixAdminIds.has(user.id),
      }));
      response.json({ items, users });
    } catch (error) {
      next(error);
    }
  });

  router.put('/user-roles', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const input = replaceUserRolesSchema.parse(request.body);
      const [activePolicies, users, knownBitrixAdminIds] = await Promise.all([
        database
          .select({ roleCode: registryRolePolicies.roleCode })
          .from(registryRolePolicies)
          .where(
            and(
              eq(registryRolePolicies.portalUrl, context.portalUrl),
              eq(registryRolePolicies.isActive, true),
            ),
          ),
        listBitrixUsers(context, bitrix),
        loadKnownBitrixAdminIds(database, context.portalUrl),
      ]);
      const activeRoleCodes = new Set(
        activePolicies.map((policy) => policy.roleCode).filter((roleCode) => roleCode !== 'admin'),
      );
      const bitrixAdminIds = new Set(
        users
          .filter((user) => user.isBitrixAdmin || knownBitrixAdminIds.has(user.id))
          .map((user) => user.id),
      );
      for (const item of input.items) {
        if (bitrixAdminIds.has(item.userId)) {
          throw new ApiError(
            400,
            'bitrix_admin_role_fixed',
            'Администратору Bitrix24 нельзя назначить другую роль: полный доступ к реестру предоставляется автоматически.',
          );
        }
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

  router.get('/department-roles', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const [items, loadedDepartments] = await Promise.all([
        database
          .select({
            departmentId: registryDepartmentRoles.departmentId,
            roleCode: registryDepartmentRoles.roleCode,
            priority: registryDepartmentRoles.priority,
          })
          .from(registryDepartmentRoles)
          .where(eq(registryDepartmentRoles.portalUrl, context.portalUrl))
          .orderBy(
            asc(registryDepartmentRoles.priority),
            asc(registryDepartmentRoles.departmentId),
          ),
        listBitrixDepartments(context, bitrix),
      ]);
      const departments = new Map(
        loadedDepartments.map((department) => [department.id, department]),
      );
      for (const item of items) {
        if (departments.has(item.departmentId)) continue;
        departments.set(item.departmentId, {
          id: item.departmentId,
          name: `Подразделение #${item.departmentId}`,
          path: `Подразделение #${item.departmentId} (не найдено в Bitrix24)`,
          parentId: null,
          headId: null,
          sortOrder: 500,
        });
      }
      response.json({ items, departments: [...departments.values()] });
    } catch (error) {
      next(error);
    }
  });

  router.put('/department-roles', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const input = replaceDepartmentRolesSchema.parse(request.body);
      const [activePolicies, departments] = await Promise.all([
        database
          .select({ roleCode: registryRolePolicies.roleCode })
          .from(registryRolePolicies)
          .where(
            and(
              eq(registryRolePolicies.portalUrl, context.portalUrl),
              eq(registryRolePolicies.isActive, true),
            ),
          ),
        listBitrixDepartments(context, bitrix),
      ]);
      const activeRoleCodes = new Set(
        activePolicies
          .map((policy) => policy.roleCode)
          .filter((roleCode) => roleCode !== 'admin'),
      );
      const knownDepartmentIds = new Set(departments.map((department) => department.id));
      for (const item of input.items) {
        if (!activeRoleCodes.has(item.roleCode)) {
          throw new ApiError(
            400,
            'role_policy_not_found',
            `Active role ${item.roleCode} was not found.`,
          );
        }
        if (context.source === 'bitrix' && !knownDepartmentIds.has(item.departmentId)) {
          throw new ApiError(
            400,
            'bitrix_department_not_found',
            `Department ${item.departmentId} was not found in Bitrix24.`,
          );
        }
      }

      await database.transaction(async (transaction) => {
        await transaction
          .delete(registryDepartmentRoles)
          .where(eq(registryDepartmentRoles.portalUrl, context.portalUrl));
        if (input.items.length) {
          await transaction.insert(registryDepartmentRoles).values(
            input.items.map((item) => ({
              portalUrl: context.portalUrl,
              departmentId: item.departmentId,
              roleCode: item.roleCode,
              priority: item.priority,
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
