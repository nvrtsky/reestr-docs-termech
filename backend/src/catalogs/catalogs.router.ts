import { randomUUID } from 'node:crypto';

import { and, asc, count, eq, isNull, ne } from 'drizzle-orm';
import { Router } from 'express';

import type { Database } from '../db/database.js';
import {
  registryDocuments,
  registryDocumentTypes,
  registryFieldDefinitions,
  registryLifecycles,
  registrySections,
  registryTypeFields,
} from '../db/schema/index.js';
import { requireRegistryContext } from '../http/registry-context.js';
import { ApiError } from '../http/api-error.js';
import {
  isDocumentFieldHidden,
  loadRegistryPolicy,
} from '../permissions/policy.service.js';
import {
  createDocumentTypeSchema,
  updateDocumentTypeSchema,
} from './catalogs.schemas.js';

interface CatalogsRouterDependencies {
  database: Database;
}

function fieldDataTypeLabel(dataType: string) {
  return {
    text: 'Текст',
    number: 'Число',
    date: 'Дата',
    money: 'Сумма',
    select: 'Список',
    boolean: 'Да/Нет',
    file: 'Файл',
  }[dataType] || 'Неизвестный тип';
}

export function createCatalogsRouter({ database }: CatalogsRouterDependencies) {
  const router = Router();

  router.get('/sections', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const [policy, sections, types, typeFields, documentCounts] = await Promise.all([
        loadRegistryPolicy(database, context),
        database
          .select({
            id: registrySections.id,
            code: registrySections.code,
            name: registrySections.name,
            description: registrySections.description,
            color: registrySections.color,
            sortOrder: registrySections.sortOrder,
          })
          .from(registrySections)
          .where(
            and(
              eq(registrySections.portalUrl, context.portalUrl),
              eq(registrySections.isActive, true),
            ),
          )
          .orderBy(asc(registrySections.sortOrder), asc(registrySections.name)),
        database
          .select({
            id: registryDocumentTypes.id,
            sectionId: registryDocumentTypes.sectionId,
            code: registryDocumentTypes.code,
            name: registryDocumentTypes.name,
            description: registryDocumentTypes.description,
            isFinancial: registryDocumentTypes.isFinancial,
            lifecycleCode: registryLifecycles.code,
            sortOrder: registryDocumentTypes.sortOrder,
          })
          .from(registryDocumentTypes)
          .leftJoin(
            registryLifecycles,
            eq(registryDocumentTypes.lifecycleId, registryLifecycles.id),
          )
          .where(
            and(
              eq(registryDocumentTypes.portalUrl, context.portalUrl),
              eq(registryDocumentTypes.isActive, true),
            ),
          )
          .orderBy(
            asc(registryDocumentTypes.sortOrder),
            asc(registryDocumentTypes.name),
          ),
        database
          .select({
            typeId: registryTypeFields.typeId,
            key: registryFieldDefinitions.key,
            label: registryFieldDefinitions.label,
            dataType: registryFieldDefinitions.dataType,
            options: registryFieldDefinitions.options,
            labelOverride: registryTypeFields.labelOverride,
            optionsOverride: registryTypeFields.optionsOverride,
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
              eq(registryFieldDefinitions.isActive, true),
            ),
          )
          .orderBy(asc(registryTypeFields.sortOrder)),
        database
          .select({
            sectionId: registryDocuments.sectionId,
            value: count(registryDocuments.id),
          })
          .from(registryDocuments)
          .where(
            and(
              eq(registryDocuments.portalUrl, context.portalUrl),
              isNull(registryDocuments.deletedAt),
            ),
          )
          .groupBy(registryDocuments.sectionId),
      ]);

      const visibleSections = sections.filter((section) =>
        policy.visibleSectionCodes.includes(section.code),
      );
      const visibleSectionIds = new Set(visibleSections.map((section) => section.id));
      const visibleTypes = types.filter(
        (type) =>
          visibleSectionIds.has(type.sectionId) &&
          (!policy.visibleTypeCodes || policy.visibleTypeCodes.includes(type.code)),
      );
      const typesBySection = new Map<string, typeof visibleTypes>();
      for (const type of visibleTypes) {
        const current = typesBySection.get(type.sectionId) ?? [];
        current.push(type);
        typesBySection.set(type.sectionId, current);
      }
      const countsBySection = new Map(
        documentCounts.map((item) => [item.sectionId, item.value]),
      );
      const fieldsByType = new Map<string, typeof typeFields>();
      for (const field of typeFields) {
        if (isDocumentFieldHidden(policy, field)) continue;
        const current = fieldsByType.get(field.typeId) ?? [];
        current.push(field);
        fieldsByType.set(field.typeId, current);
      }

      response.json({
        items: visibleSections.map((section) => ({
          code: section.code,
          name: section.name,
          description: section.description,
          color: section.color,
          sortOrder: section.sortOrder,
          documentCount: countsBySection.get(section.id) ?? 0,
          types: (typesBySection.get(section.id) ?? []).map((type) => ({
            code: type.code,
            name: type.name,
            description: type.description,
            isFinancial: type.isFinancial,
            lifecycleCode: type.lifecycleCode,
            sortOrder: type.sortOrder,
            fields: (fieldsByType.get(type.id) ?? []).map((field) => ({
              key: field.key,
              label: field.labelOverride || field.label,
              dataType: field.dataType,
              options: field.optionsOverride || field.options,
              isRequired: field.isRequired,
              sortOrder: field.sortOrder,
            })),
          })),
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/lifecycles', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const items = await database
        .select({
          code: registryLifecycles.code,
          name: registryLifecycles.name,
          config: registryLifecycles.config,
        })
        .from(registryLifecycles)
        .where(
          and(
            eq(registryLifecycles.portalUrl, context.portalUrl),
            eq(registryLifecycles.isActive, true),
          ),
        )
        .orderBy(asc(registryLifecycles.name));
      response.json({ items });
    } catch (error) {
      next(error);
    }
  });

  router.get('/types', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const [policy, types, typeFields] = await Promise.all([
        loadRegistryPolicy(database, context),
        database
          .select({
            id: registryDocumentTypes.id,
            code: registryDocumentTypes.code,
            name: registryDocumentTypes.name,
            description: registryDocumentTypes.description,
            isFinancial: registryDocumentTypes.isFinancial,
            sortOrder: registryDocumentTypes.sortOrder,
            sectionCode: registrySections.code,
            sectionName: registrySections.name,
            sectionColor: registrySections.color,
            lifecycleCode: registryLifecycles.code,
          })
          .from(registryDocumentTypes)
          .innerJoin(
            registrySections,
            eq(registryDocumentTypes.sectionId, registrySections.id),
          )
          .leftJoin(
            registryLifecycles,
            eq(registryDocumentTypes.lifecycleId, registryLifecycles.id),
          )
          .where(
            and(
              eq(registryDocumentTypes.portalUrl, context.portalUrl),
              eq(registryDocumentTypes.isActive, true),
              eq(registrySections.portalUrl, context.portalUrl),
              eq(registrySections.isActive, true),
            ),
          )
          .orderBy(
            asc(registrySections.sortOrder),
            asc(registryDocumentTypes.sortOrder),
            asc(registryDocumentTypes.name),
          ),
        database
          .select({
            typeId: registryTypeFields.typeId,
            key: registryFieldDefinitions.key,
            label: registryFieldDefinitions.label,
            dataType: registryFieldDefinitions.dataType,
            options: registryFieldDefinitions.options,
            labelOverride: registryTypeFields.labelOverride,
            optionsOverride: registryTypeFields.optionsOverride,
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
              eq(registryFieldDefinitions.isActive, true),
            ),
          )
          .orderBy(asc(registryTypeFields.sortOrder)),
      ]);
      const fieldsByType = new Map<string, typeof typeFields>();
      for (const field of typeFields) {
        if (isDocumentFieldHidden(policy, field)) continue;
        const current = fieldsByType.get(field.typeId) ?? [];
        current.push(field);
        fieldsByType.set(field.typeId, current);
      }
      response.json({
        items: types
          .filter((type) =>
            policy.visibleSectionCodes.includes(type.sectionCode) &&
            (!policy.visibleTypeCodes || policy.visibleTypeCodes.includes(type.code)),
          )
          .map((type) => ({
            code: type.code,
            name: type.name,
            description: type.description,
            isFinancial: type.isFinancial,
            sortOrder: type.sortOrder,
            section: {
              code: type.sectionCode,
              name: type.sectionName,
              color: type.sectionColor,
            },
            lifecycleCode: type.lifecycleCode,
            fields: (fieldsByType.get(type.id) ?? []).map((field) => ({
              key: field.key,
              label: field.labelOverride || field.label,
              dataType: field.dataType,
              options: field.optionsOverride || field.options,
              isRequired: field.isRequired,
              sortOrder: field.sortOrder,
            })),
          })),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/types', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const input = createDocumentTypeSchema.parse(request.body);
      const policy = await loadRegistryPolicy(database, context);
      if (!policy.permissions.administer) {
        throw new ApiError(403, 'registry_admin_required', 'Registry administrator access is required.');
      }
      const normalizedFieldNames = new Set<string>();
      for (const field of input.fields) {
        const key = field.name.toLocaleLowerCase('ru');
        if (normalizedFieldNames.has(key)) {
          throw new ApiError(400, 'duplicate_type_field', `Field ${field.name} is duplicated.`);
        }
        normalizedFieldNames.add(key);
      }

      const [section, lifecycle] = await Promise.all([
        database
          .select({ id: registrySections.id })
          .from(registrySections)
          .where(
            and(
              eq(registrySections.portalUrl, context.portalUrl),
              eq(registrySections.code, input.sectionCode),
              eq(registrySections.isActive, true),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]),
        database
          .select({ id: registryLifecycles.id })
          .from(registryLifecycles)
          .where(
            and(
              eq(registryLifecycles.portalUrl, context.portalUrl),
              eq(registryLifecycles.code, input.lifecycleCode),
              eq(registryLifecycles.isActive, true),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]),
      ]);
      if (!section) throw new ApiError(400, 'section_not_found', 'Document section was not found.');
      if (!lifecycle) throw new ApiError(400, 'lifecycle_not_found', 'Lifecycle was not found.');
      const [duplicate] = await database
        .select({ id: registryDocumentTypes.id })
        .from(registryDocumentTypes)
        .where(
          and(
            eq(registryDocumentTypes.portalUrl, context.portalUrl),
            eq(registryDocumentTypes.sectionId, section.id),
            eq(registryDocumentTypes.name, input.name),
            eq(registryDocumentTypes.isActive, true),
          ),
        )
        .limit(1);
      if (duplicate) {
        throw new ApiError(409, 'document_type_exists', 'Активный тип документа с таким названием уже существует.');
      }

      const definitions = await database
        .select({
          id: registryFieldDefinitions.id,
          key: registryFieldDefinitions.key,
          label: registryFieldDefinitions.label,
          dataType: registryFieldDefinitions.dataType,
        })
        .from(registryFieldDefinitions)
        .where(
          and(
            eq(registryFieldDefinitions.portalUrl, context.portalUrl),
            eq(registryFieldDefinitions.isActive, true),
          ),
        );
      const definitionByLabel = new Map(
        definitions.map((definition) => [definition.label.toLocaleLowerCase('ru'), definition]),
      );
      for (const field of input.fields) {
        const definition = definitionByLabel.get(field.name.toLocaleLowerCase('ru'));
        if (definition && definition.dataType !== field.dataType) {
          throw new ApiError(
            409,
            'field_definition_type_conflict',
            `Поле «${field.name}» уже существует с типом «${fieldDataTypeLabel(definition.dataType)}». Используйте существующее поле или укажите другое название.`,
          );
        }
      }

      const created = await database.transaction(async (transaction) => {
        const [typeCount] = await transaction
          .select({ value: count(registryDocumentTypes.id) })
          .from(registryDocumentTypes)
          .where(
            and(
              eq(registryDocumentTypes.portalUrl, context.portalUrl),
              eq(registryDocumentTypes.sectionId, section.id),
            ),
          );
        const [documentType] = await transaction
          .insert(registryDocumentTypes)
          .values({
            portalUrl: context.portalUrl,
            sectionId: section.id,
            lifecycleId: lifecycle.id,
            code: `custom_${randomUUID().replaceAll('-', '')}`,
            name: input.name,
            isFinancial: input.fields.some((field) => field.dataType === 'money'),
            sortOrder: (typeCount?.value ?? 0) * 10 + 100,
          })
          .returning({ id: registryDocumentTypes.id, code: registryDocumentTypes.code });

        const attachedFields: Array<{ key: string; name: string; dataType: string; isRequired: boolean }> = [];
        for (const [index, field] of input.fields.entries()) {
          let definition = definitionByLabel.get(field.name.toLocaleLowerCase('ru'));
          if (!definition) {
            const [inserted] = await transaction
              .insert(registryFieldDefinitions)
              .values({
                portalUrl: context.portalUrl,
                key: `custom_${randomUUID().replaceAll('-', '')}`,
                label: field.name,
                dataType: field.dataType,
                options: field.dataType === 'select' ? [] : null,
              })
              .returning({
                id: registryFieldDefinitions.id,
                key: registryFieldDefinitions.key,
                label: registryFieldDefinitions.label,
                dataType: registryFieldDefinitions.dataType,
              });
            definition = inserted;
            definitionByLabel.set(field.name.toLocaleLowerCase('ru'), inserted);
          }
          await transaction.insert(registryTypeFields).values({
            portalUrl: context.portalUrl,
            typeId: documentType.id,
            fieldDefinitionId: definition.id,
            sortOrder: (index + 1) * 100,
            isRequired: field.isRequired,
          });
          attachedFields.push({
            key: definition.key,
            name: definition.label,
            dataType: definition.dataType,
            isRequired: field.isRequired,
          });
        }
        return { code: documentType.code, name: input.name, fields: attachedFields };
      });
      response.status(201).json(created);
    } catch (error) {
      next(error);
    }
  });

  router.put('/types/:code', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const typeCode = request.params.code?.trim();
      if (!typeCode) {
        throw new ApiError(400, 'document_type_code_required', 'Document type code is required.');
      }
      const input = updateDocumentTypeSchema.parse(request.body);
      const policy = await loadRegistryPolicy(database, context);
      if (!policy.permissions.administer) {
        throw new ApiError(403, 'registry_admin_required', 'Registry administrator access is required.');
      }

      const normalizedFieldNames = new Set<string>();
      for (const field of input.fields) {
        const key = field.name.toLocaleLowerCase('ru');
        if (normalizedFieldNames.has(key)) {
          throw new ApiError(400, 'duplicate_type_field', `Field ${field.name} is duplicated.`);
        }
        normalizedFieldNames.add(key);
      }

      const [documentType, section, lifecycle, definitions] = await Promise.all([
        database
          .select({
            id: registryDocumentTypes.id,
            description: registryDocumentTypes.description,
            sortOrder: registryDocumentTypes.sortOrder,
            isActive: registryDocumentTypes.isActive,
          })
          .from(registryDocumentTypes)
          .where(
            and(
              eq(registryDocumentTypes.portalUrl, context.portalUrl),
              eq(registryDocumentTypes.code, typeCode),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]),
        database
          .select({ id: registrySections.id })
          .from(registrySections)
          .where(
            and(
              eq(registrySections.portalUrl, context.portalUrl),
              eq(registrySections.code, input.sectionCode),
              eq(registrySections.isActive, true),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]),
        database
          .select({ id: registryLifecycles.id })
          .from(registryLifecycles)
          .where(
            and(
              eq(registryLifecycles.portalUrl, context.portalUrl),
              eq(registryLifecycles.code, input.lifecycleCode),
              eq(registryLifecycles.isActive, true),
            ),
          )
          .limit(1)
          .then((rows) => rows[0]),
        database
          .select({
            id: registryFieldDefinitions.id,
            key: registryFieldDefinitions.key,
            label: registryFieldDefinitions.label,
            dataType: registryFieldDefinitions.dataType,
          })
          .from(registryFieldDefinitions)
          .where(
            and(
              eq(registryFieldDefinitions.portalUrl, context.portalUrl),
              eq(registryFieldDefinitions.isActive, true),
            ),
          ),
      ]);
      if (!documentType) throw new ApiError(404, 'document_type_not_found', 'Document type was not found.');
      if (!section) throw new ApiError(400, 'section_not_found', 'Document section was not found.');
      if (!lifecycle) throw new ApiError(400, 'lifecycle_not_found', 'Lifecycle was not found.');

      const isActive = input.isActive ?? documentType.isActive;
      if (!isActive && documentType.isActive) {
        const [usage] = await database
          .select({ value: count(registryDocuments.id) })
          .from(registryDocuments)
          .where(
            and(
              eq(registryDocuments.portalUrl, context.portalUrl),
              eq(registryDocuments.typeId, documentType.id),
            ),
          );
        if ((usage?.value ?? 0) > 0) {
          throw new ApiError(
            409,
            'document_type_in_use',
            'A document type with existing documents cannot be deactivated.',
          );
        }
      }
      if (isActive) {
        const [duplicate] = await database
          .select({ id: registryDocumentTypes.id })
          .from(registryDocumentTypes)
          .where(
            and(
              eq(registryDocumentTypes.portalUrl, context.portalUrl),
              eq(registryDocumentTypes.sectionId, section.id),
              eq(registryDocumentTypes.name, input.name),
              eq(registryDocumentTypes.isActive, true),
              ne(registryDocumentTypes.id, documentType.id),
            ),
          )
          .limit(1);
        if (duplicate) {
          throw new ApiError(409, 'document_type_exists', 'Активный тип документа с таким названием уже существует.');
        }
      }

      const definitionByKey = new Map(definitions.map((definition) => [definition.key, definition]));
      const definitionByLabel = new Map(
        definitions.map((definition) => [definition.label.toLocaleLowerCase('ru'), definition]),
      );
      const selectedDefinitionIds = new Set<string>();
      for (const field of input.fields) {
        const definition = field.key
          ? definitionByKey.get(field.key)
          : definitionByLabel.get(field.name.toLocaleLowerCase('ru'));
        if (field.key && !definition) {
          throw new ApiError(400, 'field_definition_not_found', `Field ${field.key} was not found.`);
        }
        if (definition && definition.dataType !== field.dataType) {
          throw new ApiError(
            409,
            'field_definition_type_conflict',
            `Поле «${field.name}» уже существует с типом «${fieldDataTypeLabel(definition.dataType)}». Используйте существующее поле или укажите другое название.`,
          );
        }
        if (definition && selectedDefinitionIds.has(definition.id)) {
          throw new ApiError(400, 'duplicate_type_field', `Field ${field.name} is duplicated.`);
        }
        if (definition) selectedDefinitionIds.add(definition.id);
      }

      const updated = await database.transaction(async (transaction) => {
        await transaction
          .update(registryDocumentTypes)
          .set({
            sectionId: section.id,
            lifecycleId: lifecycle.id,
            name: input.name,
            description: input.description === undefined
              ? documentType.description
              : input.description,
            isFinancial: input.fields.some((field) => field.dataType === 'money'),
            isActive,
            sortOrder: input.sortOrder ?? documentType.sortOrder,
            updatedAt: new Date(),
          })
          .where(eq(registryDocumentTypes.id, documentType.id));

        await transaction
          .delete(registryTypeFields)
          .where(eq(registryTypeFields.typeId, documentType.id));

        const attachedFields: Array<{
          key: string;
          name: string;
          dataType: string;
          isRequired: boolean;
        }> = [];
        for (const [index, field] of input.fields.entries()) {
          let definition = field.key
            ? definitionByKey.get(field.key)
            : definitionByLabel.get(field.name.toLocaleLowerCase('ru'));
          if (!definition) {
            const [inserted] = await transaction
              .insert(registryFieldDefinitions)
              .values({
                portalUrl: context.portalUrl,
                key: `custom_${randomUUID().replaceAll('-', '')}`,
                label: field.name,
                dataType: field.dataType,
                options: field.dataType === 'select' ? [] : null,
              })
              .returning({
                id: registryFieldDefinitions.id,
                key: registryFieldDefinitions.key,
                label: registryFieldDefinitions.label,
                dataType: registryFieldDefinitions.dataType,
              });
            definition = inserted;
            definitionByKey.set(inserted.key, inserted);
            definitionByLabel.set(inserted.label.toLocaleLowerCase('ru'), inserted);
          }
          await transaction.insert(registryTypeFields).values({
            portalUrl: context.portalUrl,
            typeId: documentType.id,
            fieldDefinitionId: definition.id,
            labelOverride: field.name === definition.label ? null : field.name,
            sortOrder: (index + 1) * 100,
            isRequired: field.isRequired,
          });
          attachedFields.push({
            key: definition.key,
            name: field.name,
            dataType: definition.dataType,
            isRequired: field.isRequired,
          });
        }
        return {
          code: typeCode,
          name: input.name,
          sectionCode: input.sectionCode,
          lifecycleCode: input.lifecycleCode,
          isActive,
          fields: attachedFields,
        };
      });
      response.json(updated);
    } catch (error) {
      next(error);
    }
  });

  router.get('/me/policy', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const policy = await loadRegistryPolicy(database, context);

      response.json({
        userId: context.userId,
        source: context.source,
        ...policy,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
