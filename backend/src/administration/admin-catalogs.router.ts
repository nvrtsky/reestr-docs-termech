import { randomUUID } from 'node:crypto';

import { and, asc, count, eq, ne, or } from 'drizzle-orm';
import { Router } from 'express';

import type { Database } from '../db/database.js';
import {
  registryDocuments,
  registryDocumentTypeSections,
  registryDocumentTypes,
  registryFieldDefinitions,
  registryLifecycles,
  registryRolePolicies,
  registrySavedViews,
  registrySections,
  registryTypeFields,
} from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import {
  createLifecycleSchema,
  createSectionSchema,
  updateLifecycleSchema,
  updateSectionSchema,
} from './administration.schemas.js';
import { requireAdministrator } from './administration.router.js';

interface AdminCatalogsRouterDependencies {
  database: Database;
}

async function assertLifecycleRolesExist(
  database: Database,
  portalUrl: string,
  roleCodes: string[],
) {
  const uniqueRoleCodes = [...new Set(roleCodes)];
  if (!uniqueRoleCodes.length) return;
  const policies = await database
    .select({ roleCode: registryRolePolicies.roleCode })
    .from(registryRolePolicies)
    .where(
      and(
        eq(registryRolePolicies.portalUrl, portalUrl),
        eq(registryRolePolicies.isActive, true),
      ),
    );
  const knownRoleCodes = new Set(policies.map((policy) => policy.roleCode));
  for (const roleCode of uniqueRoleCodes) {
    if (!knownRoleCodes.has(roleCode)) {
      throw new ApiError(400, 'role_policy_not_found', `Active role ${roleCode} was not found.`);
    }
  }
}

export function createAdminCatalogsRouter({ database }: AdminCatalogsRouterDependencies) {
  const router = Router();

  router.get('/sections', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const [sections, usage] = await Promise.all([
        database
          .select({
            code: registrySections.code,
            name: registrySections.name,
            description: registrySections.description,
            color: registrySections.color,
            sortOrder: registrySections.sortOrder,
            isActive: registrySections.isActive,
          })
          .from(registrySections)
          .where(eq(registrySections.portalUrl, context.portalUrl))
          .orderBy(asc(registrySections.sortOrder), asc(registrySections.name)),
        database
          .select({ sectionId: registryDocumentTypeSections.sectionId, value: count(registryDocumentTypeSections.typeId) })
          .from(registryDocumentTypeSections)
          .where(eq(registryDocumentTypeSections.portalUrl, context.portalUrl))
          .groupBy(registryDocumentTypeSections.sectionId),
      ]);
      const sectionIds = await database
        .select({ id: registrySections.id, code: registrySections.code })
        .from(registrySections)
        .where(eq(registrySections.portalUrl, context.portalUrl));
      const codeById = new Map(sectionIds.map((section) => [section.id, section.code]));
      const usageByCode = new Map(
        usage.map((item) => [codeById.get(item.sectionId), item.value]),
      );
      response.json({
        items: sections.map((section) => ({
          ...section,
          typeCount: usageByCode.get(section.code) ?? 0,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/types', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const [types, typeSections, fields, fieldLibrary] = await Promise.all([
        database
          .select({
            id: registryDocumentTypes.id,
            code: registryDocumentTypes.code,
            name: registryDocumentTypes.name,
            description: registryDocumentTypes.description,
            isFinancial: registryDocumentTypes.isFinancial,
            numberFormat: registryDocumentTypes.numberFormat,
            numberAutoGenerate: registryDocumentTypes.numberAutoGenerate,
            numberUniquenessEnabled: registryDocumentTypes.numberUniquenessEnabled,
            contentRequired: registryDocumentTypes.contentRequired,
            isActive: registryDocumentTypes.isActive,
            sortOrder: registryDocumentTypes.sortOrder,
            lifecycleCode: registryLifecycles.code,
          })
          .from(registryDocumentTypes)
          .leftJoin(registryLifecycles, eq(registryDocumentTypes.lifecycleId, registryLifecycles.id))
          .where(
            eq(registryDocumentTypes.portalUrl, context.portalUrl),
          )
          .orderBy(
            asc(registryDocumentTypes.sortOrder),
            asc(registryDocumentTypes.name),
          ),
        database
          .select({
            typeId: registryDocumentTypeSections.typeId,
            sectionCode: registrySections.code,
            sectionName: registrySections.name,
            sectionColor: registrySections.color,
          })
          .from(registryDocumentTypeSections)
          .innerJoin(registrySections, eq(registryDocumentTypeSections.sectionId, registrySections.id))
          .where(and(
            eq(registryDocumentTypeSections.portalUrl, context.portalUrl),
            eq(registrySections.portalUrl, context.portalUrl),
          ))
          .orderBy(asc(registryDocumentTypeSections.sortOrder), asc(registrySections.sortOrder)),
        database
          .select({
            typeId: registryTypeFields.typeId,
            key: registryFieldDefinitions.key,
            name: registryFieldDefinitions.label,
            labelOverride: registryTypeFields.labelOverride,
            dataType: registryFieldDefinitions.dataType,
            isRequired: registryTypeFields.isRequired,
            sortOrder: registryTypeFields.sortOrder,
          })
          .from(registryTypeFields)
          .innerJoin(
            registryFieldDefinitions,
            eq(registryTypeFields.fieldDefinitionId, registryFieldDefinitions.id),
          )
          .where(
            and(
              eq(registryTypeFields.portalUrl, context.portalUrl),
              eq(registryFieldDefinitions.portalUrl, context.portalUrl),
            ),
          )
          .orderBy(asc(registryTypeFields.sortOrder)),
        database
          .select({
            key: registryFieldDefinitions.key,
            name: registryFieldDefinitions.label,
            dataType: registryFieldDefinitions.dataType,
            options: registryFieldDefinitions.options,
          })
          .from(registryFieldDefinitions)
          .where(and(
            eq(registryFieldDefinitions.portalUrl, context.portalUrl),
            eq(registryFieldDefinitions.isActive, true),
          ))
          .orderBy(asc(registryFieldDefinitions.label)),
      ]);
      const fieldsByType = new Map<string, typeof fields>();
      for (const field of fields) {
        const current = fieldsByType.get(field.typeId) ?? [];
        current.push(field);
        fieldsByType.set(field.typeId, current);
      }
      const sectionsByType = new Map<string, typeof typeSections>();
      for (const section of typeSections) {
        const current = sectionsByType.get(section.typeId) ?? [];
        current.push(section);
        sectionsByType.set(section.typeId, current);
      }
      response.json({
        fieldLibrary,
        items: types.map(({ id, ...type }) => {
          const sections = sectionsByType.get(id) ?? [];
          return {
            ...type,
            sectionCode: sections[0]?.sectionCode ?? null,
            sectionName: sections[0]?.sectionName ?? null,
            sectionColor: sections[0]?.sectionColor ?? null,
            sectionCodes: sections.map((section) => section.sectionCode),
            sectionNames: sections.map((section) => section.sectionName),
            sections: sections.map(({ typeId: _typeId, ...section }) => section),
            fields: (fieldsByType.get(id) ?? []).map((field) => ({
              key: field.key,
              name: field.labelOverride || field.name,
              dataType: field.dataType,
              isRequired: field.isRequired,
              sortOrder: field.sortOrder,
            })),
          };
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/sections', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const input = createSectionSchema.parse(request.body);
      const code = input.code ?? `custom_${randomUUID().replaceAll('-', '')}`;
      const [duplicate] = await database
        .select({ id: registrySections.id })
        .from(registrySections)
        .where(
          and(
            eq(registrySections.portalUrl, context.portalUrl),
            or(eq(registrySections.code, code), eq(registrySections.name, input.name)),
          ),
        )
        .limit(1);
      if (duplicate) throw new ApiError(409, 'section_exists', 'A section with this code or name already exists.');
      const [created] = await database
        .insert(registrySections)
        .values({
          portalUrl: context.portalUrl,
          code,
          name: input.name,
          description: input.description,
          color: input.color,
          sortOrder: input.sortOrder,
        })
        .returning({
          code: registrySections.code,
          name: registrySections.name,
          description: registrySections.description,
          color: registrySections.color,
          sortOrder: registrySections.sortOrder,
          isActive: registrySections.isActive,
        });
      response.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  router.put('/sections/:code', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const code = request.params.code?.trim();
      if (!code) throw new ApiError(400, 'section_code_required', 'Section code is required.');
      const input = updateSectionSchema.parse(request.body);
      const [section] = await database
        .select({ id: registrySections.id, isActive: registrySections.isActive })
        .from(registrySections)
        .where(
          and(
            eq(registrySections.portalUrl, context.portalUrl),
            eq(registrySections.code, code),
          ),
        )
        .limit(1);
      if (!section) throw new ApiError(404, 'section_not_found', 'Document section was not found.');
      const [duplicate] = await database
        .select({ id: registrySections.id })
        .from(registrySections)
        .where(
          and(
            eq(registrySections.portalUrl, context.portalUrl),
            eq(registrySections.name, input.name),
            ne(registrySections.id, section.id),
          ),
        )
        .limit(1);
      if (duplicate) throw new ApiError(409, 'section_exists', 'A section with this name already exists.');
      if (!input.isActive && section.isActive) {
        const [usage] = await database
          .select({ value: count(registryDocumentTypeSections.typeId) })
          .from(registryDocumentTypeSections)
          .innerJoin(registryDocumentTypes, eq(registryDocumentTypeSections.typeId, registryDocumentTypes.id))
          .where(
            and(
              eq(registryDocumentTypeSections.portalUrl, context.portalUrl),
              eq(registryDocumentTypeSections.sectionId, section.id),
              eq(registryDocumentTypes.isActive, true),
            ),
          );
        if ((usage?.value ?? 0) > 0) {
          throw new ApiError(409, 'section_in_use', 'A section with active document types cannot be deactivated.');
        }
      }
      const [updated] = await database
        .update(registrySections)
        .set({
          name: input.name,
          description: input.description,
          color: input.color,
          sortOrder: input.sortOrder,
          isActive: input.isActive,
          updatedAt: new Date(),
        })
        .where(eq(registrySections.id, section.id))
        .returning({
          code: registrySections.code,
          name: registrySections.name,
          description: registrySections.description,
          color: registrySections.color,
          sortOrder: registrySections.sortOrder,
          isActive: registrySections.isActive,
        });
      response.json(updated);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/sections/:code', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const code = request.params.code?.trim();
      if (!code) throw new ApiError(400, 'section_code_required', 'Section code is required.');
      const section = await database
        .select({ id: registrySections.id })
        .from(registrySections)
        .where(
          and(
            eq(registrySections.portalUrl, context.portalUrl),
            eq(registrySections.code, code),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      if (!section) throw new ApiError(404, 'section_not_found', 'Document section was not found.');
      const usage = await database
        .select({ value: count(registryDocumentTypeSections.typeId) })
        .from(registryDocumentTypeSections)
        .where(
          and(
            eq(registryDocumentTypeSections.portalUrl, context.portalUrl),
            eq(registryDocumentTypeSections.sectionId, section.id),
          ),
        )
        .then((rows) => rows[0]);
      if ((usage?.value ?? 0) > 0) {
        throw new ApiError(
          409,
          'section_in_use',
          'Нельзя удалить раздел, пока в нём есть типы документов.',
        );
      }

      const [policies, savedViews] = await Promise.all([
        database
          .select({
            id: registryRolePolicies.id,
            visibleSectionCodes: registryRolePolicies.visibleSectionCodes,
          })
          .from(registryRolePolicies)
          .where(eq(registryRolePolicies.portalUrl, context.portalUrl)),
        database
          .select({ id: registrySavedViews.id, filters: registrySavedViews.filters })
          .from(registrySavedViews)
          .where(eq(registrySavedViews.portalUrl, context.portalUrl)),
      ]);
      await database.transaction(async (transaction) => {
        for (const policy of policies) {
          if (!policy.visibleSectionCodes.includes(code)) continue;
          await transaction
            .update(registryRolePolicies)
            .set({
              visibleSectionCodes: policy.visibleSectionCodes.filter((item) => item !== code),
              updatedAt: new Date(),
            })
            .where(eq(registryRolePolicies.id, policy.id));
        }
        for (const view of savedViews) {
          const currentSections = view.filters.sections;
          if (!Array.isArray(currentSections)) continue;
          const sections = currentSections.filter((item) => item !== code);
          if (sections.length === currentSections.length) continue;
          await transaction
            .update(registrySavedViews)
            .set({
              filters: { ...view.filters, sections },
              updatedAt: new Date(),
            })
            .where(eq(registrySavedViews.id, view.id));
        }
        await transaction
          .delete(registrySections)
          .where(eq(registrySections.id, section.id));
      });
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.delete('/types/:code', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const code = request.params.code?.trim();
      if (!code) throw new ApiError(400, 'document_type_code_required', 'Document type code is required.');
      const documentType = await database
        .select({ id: registryDocumentTypes.id })
        .from(registryDocumentTypes)
        .where(
          and(
            eq(registryDocumentTypes.portalUrl, context.portalUrl),
            eq(registryDocumentTypes.code, code),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      if (!documentType) throw new ApiError(404, 'document_type_not_found', 'Document type was not found.');
      const usage = await database
        .select({ value: count(registryDocuments.id) })
        .from(registryDocuments)
        .where(
          and(
            eq(registryDocuments.portalUrl, context.portalUrl),
            eq(registryDocuments.typeId, documentType.id),
          ),
        )
        .then((rows) => rows[0]);
      if ((usage?.value ?? 0) > 0) {
        throw new ApiError(
          409,
          'document_type_in_use',
          'Нельзя удалить тип, пока к нему относятся документы.',
        );
      }

      const [policies, savedViews] = await Promise.all([
        database
          .select({
            id: registryRolePolicies.id,
            visibleTypeCodes: registryRolePolicies.visibleTypeCodes,
          })
          .from(registryRolePolicies)
          .where(eq(registryRolePolicies.portalUrl, context.portalUrl)),
        database
          .select({ id: registrySavedViews.id, filters: registrySavedViews.filters })
          .from(registrySavedViews)
          .where(eq(registrySavedViews.portalUrl, context.portalUrl)),
      ]);
      await database.transaction(async (transaction) => {
        for (const policy of policies) {
          if (!policy.visibleTypeCodes?.includes(code)) continue;
          await transaction
            .update(registryRolePolicies)
            .set({
              visibleTypeCodes: policy.visibleTypeCodes.filter((item) => item !== code),
              updatedAt: new Date(),
            })
            .where(eq(registryRolePolicies.id, policy.id));
        }
        for (const view of savedViews) {
          if (view.filters.type !== code) continue;
          await transaction
            .update(registrySavedViews)
            .set({
              filters: { ...view.filters, type: null },
              updatedAt: new Date(),
            })
            .where(eq(registrySavedViews.id, view.id));
        }
        await transaction
          .delete(registryDocumentTypes)
          .where(eq(registryDocumentTypes.id, documentType.id));
      });
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get('/lifecycles', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const [lifecycles, usage] = await Promise.all([
        database
          .select({
            id: registryLifecycles.id,
            code: registryLifecycles.code,
            name: registryLifecycles.name,
            config: registryLifecycles.config,
            isActive: registryLifecycles.isActive,
          })
          .from(registryLifecycles)
          .where(eq(registryLifecycles.portalUrl, context.portalUrl))
          .orderBy(asc(registryLifecycles.name)),
        database
          .select({ lifecycleId: registryDocumentTypes.lifecycleId, value: count(registryDocumentTypes.id) })
          .from(registryDocumentTypes)
          .where(eq(registryDocumentTypes.portalUrl, context.portalUrl))
          .groupBy(registryDocumentTypes.lifecycleId),
      ]);
      const usageById = new Map(usage.map((item) => [item.lifecycleId, item.value]));
      response.json({
        items: lifecycles.map(({ id, ...lifecycle }) => ({
          ...lifecycle,
          typeCount: usageById.get(id) ?? 0,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/lifecycles', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const input = createLifecycleSchema.parse(request.body);
      const code = input.code ?? `custom_${randomUUID().replaceAll('-', '')}`;
      await assertLifecycleRolesExist(
        database,
        context.portalUrl,
        input.config.transitions.flatMap((transition) => transition.roles ?? []),
      );
      const [duplicate] = await database
        .select({ id: registryLifecycles.id })
        .from(registryLifecycles)
        .where(
          and(
            eq(registryLifecycles.portalUrl, context.portalUrl),
            or(eq(registryLifecycles.code, code), eq(registryLifecycles.name, input.name)),
          ),
        )
        .limit(1);
      if (duplicate) throw new ApiError(409, 'lifecycle_exists', 'A lifecycle with this code or name already exists.');
      const [created] = await database
        .insert(registryLifecycles)
        .values({
          portalUrl: context.portalUrl,
          code,
          name: input.name,
          config: input.config,
        })
        .returning({
          code: registryLifecycles.code,
          name: registryLifecycles.name,
          config: registryLifecycles.config,
          isActive: registryLifecycles.isActive,
        });
      response.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  router.put('/lifecycles/:code', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const code = request.params.code?.trim();
      if (!code) throw new ApiError(400, 'lifecycle_code_required', 'Lifecycle code is required.');
      const input = updateLifecycleSchema.parse(request.body);
      await assertLifecycleRolesExist(
        database,
        context.portalUrl,
        input.config.transitions.flatMap((transition) => transition.roles ?? []),
      );
      const [lifecycle] = await database
        .select({ id: registryLifecycles.id, isActive: registryLifecycles.isActive })
        .from(registryLifecycles)
        .where(
          and(
            eq(registryLifecycles.portalUrl, context.portalUrl),
            eq(registryLifecycles.code, code),
          ),
        )
        .limit(1);
      if (!lifecycle) throw new ApiError(404, 'lifecycle_not_found', 'Lifecycle was not found.');
      const [duplicate, typeUsage, usedStatuses] = await Promise.all([
        database
          .select({ id: registryLifecycles.id })
          .from(registryLifecycles)
          .where(
            and(
              eq(registryLifecycles.portalUrl, context.portalUrl),
              eq(registryLifecycles.name, input.name),
              ne(registryLifecycles.id, lifecycle.id),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]),
        database
          .select({ value: count(registryDocumentTypes.id) })
          .from(registryDocumentTypes)
          .where(
            and(
              eq(registryDocumentTypes.portalUrl, context.portalUrl),
              eq(registryDocumentTypes.lifecycleId, lifecycle.id),
              eq(registryDocumentTypes.isActive, true),
            ),
          )
          .then((rows) => rows[0]),
        database
          .selectDistinct({ status: registryDocuments.status })
          .from(registryDocuments)
          .innerJoin(
            registryDocumentTypes,
            eq(registryDocuments.typeId, registryDocumentTypes.id),
          )
          .where(
            and(
              eq(registryDocuments.portalUrl, context.portalUrl),
              eq(registryDocumentTypes.lifecycleId, lifecycle.id),
            ),
          ),
      ]);
      if (duplicate) throw new ApiError(409, 'lifecycle_exists', 'A lifecycle with this name already exists.');
      if (!input.isActive && lifecycle.isActive && (typeUsage?.value ?? 0) > 0) {
        throw new ApiError(409, 'lifecycle_in_use', 'A lifecycle used by active document types cannot be deactivated.');
      }
      const newStateCodes = new Set(input.config.states.map((state) => state.code));
      const removedUsedStatus = usedStatuses.find((item) => !newStateCodes.has(item.status));
      if (removedUsedStatus) {
        throw new ApiError(
          409,
          'lifecycle_status_in_use',
          `Status ${removedUsedStatus.status} is used by existing documents and cannot be removed.`,
        );
      }
      const [updated] = await database
        .update(registryLifecycles)
        .set({
          name: input.name,
          config: input.config,
          isActive: input.isActive,
          updatedAt: new Date(),
        })
        .where(eq(registryLifecycles.id, lifecycle.id))
        .returning({
          code: registryLifecycles.code,
          name: registryLifecycles.name,
          config: registryLifecycles.config,
          isActive: registryLifecycles.isActive,
        });
      response.json(updated);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/lifecycles/:code', async (request, response, next) => {
    try {
      const { context } = await requireAdministrator(database, request);
      const code = request.params.code?.trim();
      if (!code) throw new ApiError(400, 'lifecycle_code_required', 'Lifecycle code is required.');
      const lifecycle = await database
        .select({ id: registryLifecycles.id })
        .from(registryLifecycles)
        .where(
          and(
            eq(registryLifecycles.portalUrl, context.portalUrl),
            eq(registryLifecycles.code, code),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);
      if (!lifecycle) throw new ApiError(404, 'lifecycle_not_found', 'Lifecycle was not found.');
      const usage = await database
        .select({ value: count(registryDocumentTypes.id) })
        .from(registryDocumentTypes)
        .where(
          and(
            eq(registryDocumentTypes.portalUrl, context.portalUrl),
            eq(registryDocumentTypes.lifecycleId, lifecycle.id),
          ),
        )
        .then((rows) => rows[0]);
      if ((usage?.value ?? 0) > 0) {
        throw new ApiError(
          409,
          'lifecycle_in_use',
          'Нельзя удалить жизненный цикл, пока он назначен типам документов.',
        );
      }
      await database
        .delete(registryLifecycles)
        .where(eq(registryLifecycles.id, lifecycle.id));
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
