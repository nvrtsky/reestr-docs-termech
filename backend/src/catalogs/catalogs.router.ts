import { randomUUID } from 'node:crypto';

import { and, asc, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import { Router } from 'express';

import type { Database } from '../db/database.js';
import {
  registryDocuments,
  registryDocumentTypeSections,
  registryDocumentTypes,
  registryFieldDefinitions,
  registryLifecycles,
  registrySections,
  registryTypeFields,
} from '../db/schema/index.js';
import { requireRegistryContext } from '../http/registry-context.js';
import { ApiError } from '../http/api-error.js';
import {
  documentNumberUniquenessKey,
  lockDocumentNumberingScope,
  validateNumberingConfiguration,
} from '../documents/document-numbering.service.js';
import {
  isDocumentFieldHidden,
  isTypePermissionAllowed,
  loadRegistryPolicy,
} from '../permissions/policy.service.js';
import {
  createDocumentTypeSchema,
  documentTypeSectionCodes,
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
      const [policy, sections, types, typeSections, typeFields, documentCounts] = await Promise.all([
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
            code: registryDocumentTypes.code,
            name: registryDocumentTypes.name,
            description: registryDocumentTypes.description,
            isFinancial: registryDocumentTypes.isFinancial,
            numberFormat: registryDocumentTypes.numberFormat,
            numberAutoGenerate: registryDocumentTypes.numberAutoGenerate,
            numberUniquenessEnabled: registryDocumentTypes.numberUniquenessEnabled,
            contentRequired: registryDocumentTypes.contentRequired,
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
            typeId: registryDocumentTypeSections.typeId,
            sectionId: registryDocumentTypeSections.sectionId,
          })
          .from(registryDocumentTypeSections)
          .where(eq(registryDocumentTypeSections.portalUrl, context.portalUrl))
          .orderBy(asc(registryDocumentTypeSections.sortOrder)),
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
      const visibleTypes = types.filter(
        (type) =>
          (!policy.visibleTypeCodes || policy.visibleTypeCodes.includes(type.code)) &&
          isTypePermissionAllowed(policy, type.code, 'view'),
      );
      const visibleTypeById = new Map(visibleTypes.map((type) => [type.id, type]));
      const visibleSectionIds = new Set(visibleSections.map((section) => section.id));
      const typesBySection = new Map<string, typeof visibleTypes>();
      for (const association of typeSections) {
        const type = visibleTypeById.get(association.typeId);
        if (!type || !visibleSectionIds.has(association.sectionId)) continue;
        const current = typesBySection.get(association.sectionId) ?? [];
        current.push(type);
        typesBySection.set(association.sectionId, current);
      }
      const countsBySection = new Map(
        documentCounts.map((item) => [item.sectionId, item.value]),
      );
      const typeCodeById = new Map(types.map((type) => [type.id, type.code]));
      const fieldsByType = new Map<string, typeof typeFields>();
      for (const field of typeFields) {
        if (isDocumentFieldHidden(policy, field, typeCodeById.get(field.typeId))) continue;
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
            numberFormat: type.numberFormat,
            numberAutoGenerate: type.numberAutoGenerate,
            numberUniquenessEnabled: type.numberUniquenessEnabled,
            contentRequired: type.contentRequired,
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
      const [policy, types, typeSections, typeFields] = await Promise.all([
        loadRegistryPolicy(database, context),
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
            sortOrder: registryDocumentTypes.sortOrder,
            lifecycleCode: registryLifecycles.code,
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
            typeId: registryDocumentTypeSections.typeId,
            code: registrySections.code,
            name: registrySections.name,
            color: registrySections.color,
          })
          .from(registryDocumentTypeSections)
          .innerJoin(registrySections, eq(registryDocumentTypeSections.sectionId, registrySections.id))
          .where(and(
            eq(registryDocumentTypeSections.portalUrl, context.portalUrl),
            eq(registrySections.portalUrl, context.portalUrl),
            eq(registrySections.isActive, true),
          ))
          .orderBy(asc(registryDocumentTypeSections.sortOrder), asc(registrySections.sortOrder)),
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
      const typeCodeById = new Map(types.map((type) => [type.id, type.code]));
      const sectionsByType = new Map<string, Array<{ code: string; name: string; color: string | null }>>();
      for (const section of typeSections) {
        const current = sectionsByType.get(section.typeId) ?? [];
        current.push({ code: section.code, name: section.name, color: section.color });
        sectionsByType.set(section.typeId, current);
      }
      const fieldsByType = new Map<string, typeof typeFields>();
      for (const field of typeFields) {
        if (isDocumentFieldHidden(policy, field, typeCodeById.get(field.typeId))) continue;
        const current = fieldsByType.get(field.typeId) ?? [];
        current.push(field);
        fieldsByType.set(field.typeId, current);
      }
      response.json({
        items: types
          .filter((type) =>
            (sectionsByType.get(type.id) ?? []).some((section) =>
              policy.visibleSectionCodes.includes(section.code)) &&
            (!policy.visibleTypeCodes || policy.visibleTypeCodes.includes(type.code)) &&
            isTypePermissionAllowed(policy, type.code, 'view'),
          )
          .map((type) => {
            const sections = (sectionsByType.get(type.id) ?? []).filter(section =>
              policy.visibleSectionCodes.includes(section.code));
            return {
              code: type.code,
              name: type.name,
              description: type.description,
              isFinancial: type.isFinancial,
              numberFormat: type.numberFormat,
              numberAutoGenerate: type.numberAutoGenerate,
              numberUniquenessEnabled: type.numberUniquenessEnabled,
              contentRequired: type.contentRequired,
              sortOrder: type.sortOrder,
              section: sections[0] ?? null,
              sections,
              sectionCodes: sections.map((section) => section.code),
              lifecycleCode: type.lifecycleCode,
              fields: (fieldsByType.get(type.id) ?? []).map((field) => ({
                key: field.key,
                label: field.labelOverride || field.label,
                dataType: field.dataType,
                options: field.optionsOverride || field.options,
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

  router.post('/types', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const input = createDocumentTypeSchema.parse(request.body);
      const sectionCodes = documentTypeSectionCodes(input);
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

      const [sections, lifecycle] = await Promise.all([
        database
          .select({ id: registrySections.id, code: registrySections.code })
          .from(registrySections)
          .where(
            and(
              eq(registrySections.portalUrl, context.portalUrl),
              inArray(registrySections.code, sectionCodes),
              eq(registrySections.isActive, true),
            ),
          ),
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
      if (sections.length !== sectionCodes.length) {
        throw new ApiError(400, 'section_not_found', 'Document section was not found.');
      }
      if (!lifecycle) throw new ApiError(400, 'lifecycle_not_found', 'Lifecycle was not found.');
      const sectionByCode = new Map(sections.map((section) => [section.code, section]));
      const orderedSections = sectionCodes.map((code) => sectionByCode.get(code)!);
      const primarySection = orderedSections[0];
      const [duplicate] = await database
        .select({ id: registryDocumentTypes.id })
        .from(registryDocumentTypes)
        .where(
          and(
            eq(registryDocumentTypes.portalUrl, context.portalUrl),
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
              eq(registryDocumentTypes.sectionId, primarySection.id),
            ),
          );
        const [documentType] = await transaction
          .insert(registryDocumentTypes)
          .values({
            portalUrl: context.portalUrl,
            sectionId: primarySection.id,
            lifecycleId: lifecycle.id,
            code: `custom_${randomUUID().replaceAll('-', '')}`,
            name: input.name,
            isFinancial: input.fields.some((field) => field.dataType === 'money'),
            numberFormat: input.numberFormat,
            numberAutoGenerate: input.numberAutoGenerate,
            numberUniquenessEnabled: input.numberUniquenessEnabled,
            contentRequired: input.contentRequired,
            sortOrder: (typeCount?.value ?? 0) * 10 + 100,
          })
          .returning({ id: registryDocumentTypes.id, code: registryDocumentTypes.code });

        await transaction.insert(registryDocumentTypeSections).values(
          orderedSections.map((section, index) => ({
            portalUrl: context.portalUrl,
            typeId: documentType.id,
            sectionId: section.id,
            sortOrder: (index + 1) * 100,
          })),
        );

        const attachedFields: Array<{
          key: string;
          name: string;
          dataType: string;
          isRequired: boolean;
          options?: string[];
        }> = [];
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
                options: field.dataType === 'select' ? field.options : null,
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
            optionsOverride: field.dataType === 'select' ? field.options : null,
          });
          attachedFields.push({
            key: definition.key,
            name: definition.label,
            dataType: definition.dataType,
            isRequired: field.isRequired,
            ...(field.dataType === 'select' ? { options: field.options } : {}),
          });
        }
        return {
          code: documentType.code,
          name: input.name,
          sectionCode: sectionCodes[0],
          sectionCodes,
          numberFormat: input.numberFormat,
          numberAutoGenerate: input.numberAutoGenerate,
          numberUniquenessEnabled: input.numberUniquenessEnabled,
          contentRequired: input.contentRequired,
          fields: attachedFields,
        };
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
      const sectionCodes = documentTypeSectionCodes(input);
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

      const [documentType, sections, lifecycle, definitions] = await Promise.all([
        database
          .select({
            id: registryDocumentTypes.id,
            description: registryDocumentTypes.description,
            sortOrder: registryDocumentTypes.sortOrder,
            isActive: registryDocumentTypes.isActive,
            numberFormat: registryDocumentTypes.numberFormat,
            numberAutoGenerate: registryDocumentTypes.numberAutoGenerate,
            numberUniquenessEnabled: registryDocumentTypes.numberUniquenessEnabled,
            contentRequired: registryDocumentTypes.contentRequired,
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
          .select({ id: registrySections.id, code: registrySections.code })
          .from(registrySections)
          .where(
            and(
              eq(registrySections.portalUrl, context.portalUrl),
              inArray(registrySections.code, sectionCodes),
              eq(registrySections.isActive, true),
            ),
          ),
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
      if (sections.length !== sectionCodes.length) {
        throw new ApiError(400, 'section_not_found', 'Document section was not found.');
      }
      if (!lifecycle) throw new ApiError(400, 'lifecycle_not_found', 'Lifecycle was not found.');
      const sectionByCode = new Map(sections.map((section) => [section.code, section]));
      const orderedSections = sectionCodes.map((code) => sectionByCode.get(code)!);
      const primarySection = orderedSections[0];

      const numbering = {
        numberFormat: input.numberFormat === undefined
          ? documentType.numberFormat
          : input.numberFormat,
        numberAutoGenerate: input.numberAutoGenerate === undefined
          ? documentType.numberAutoGenerate
          : input.numberAutoGenerate,
        numberUniquenessEnabled: input.numberUniquenessEnabled === undefined
          ? documentType.numberUniquenessEnabled
          : input.numberUniquenessEnabled,
        contentRequired: input.contentRequired === undefined
          ? documentType.contentRequired
          : input.contentRequired,
      };
      const numberingError = validateNumberingConfiguration(numbering);
      if (numberingError) {
        throw new ApiError(400, 'document_number_format_configuration_invalid', numberingError);
      }

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
        const transactionalDatabase = transaction as unknown as Database;
        await lockDocumentNumberingScope(
          transactionalDatabase,
          context.portalUrl,
          documentType.id,
        );
        const documentsForNumbering = numbering.numberUniquenessEnabled
          ? await transaction
              .select({
                id: registryDocuments.id,
                number: registryDocuments.number,
                counterpartyId: registryDocuments.counterpartyId,
              })
              .from(registryDocuments)
              .where(and(
                eq(registryDocuments.portalUrl, context.portalUrl),
                eq(registryDocuments.typeId, documentType.id),
              ))
          : [];
        const uniquenessKeys = new Map<string, string>();
        for (const document of documentsForNumbering) {
          if (!document.number) continue;
          const key = documentNumberUniquenessKey(document.number, document.counterpartyId);
          const duplicateId = uniquenessKeys.get(key);
          if (duplicateId) {
            throw new ApiError(
              409,
              'document_number_duplicates_exist',
              'Нельзя включить уникальность: уже есть документы с одинаковым номером для этого типа и компании.',
              { documentIds: [duplicateId, document.id], number: document.number },
            );
          }
          uniquenessKeys.set(key, document.id);
        }

        await transaction
          .update(registryDocumentTypes)
          .set({
            sectionId: primarySection.id,
            lifecycleId: lifecycle.id,
            name: input.name,
            description: input.description === undefined
              ? documentType.description
              : input.description,
            isFinancial: input.fields.some((field) => field.dataType === 'money'),
            numberFormat: numbering.numberFormat,
            numberAutoGenerate: numbering.numberAutoGenerate,
            numberUniquenessEnabled: numbering.numberUniquenessEnabled,
            contentRequired: numbering.contentRequired,
            isActive,
            sortOrder: input.sortOrder ?? documentType.sortOrder,
            updatedAt: new Date(),
          })
          .where(eq(registryDocumentTypes.id, documentType.id));

        await transaction
          .delete(registryDocumentTypeSections)
          .where(and(
            eq(registryDocumentTypeSections.portalUrl, context.portalUrl),
            eq(registryDocumentTypeSections.typeId, documentType.id),
          ));
        await transaction.insert(registryDocumentTypeSections).values(
          orderedSections.map((section, index) => ({
            portalUrl: context.portalUrl,
            typeId: documentType.id,
            sectionId: section.id,
            sortOrder: (index + 1) * 100,
          })),
        );

        await transaction
          .update(registryDocuments)
          .set({ numberUniquenessKey: null })
          .where(and(
            eq(registryDocuments.portalUrl, context.portalUrl),
            eq(registryDocuments.typeId, documentType.id),
          ));
        for (const document of documentsForNumbering) {
          if (!document.number) continue;
          await transaction
            .update(registryDocuments)
            .set({
              numberUniquenessKey: documentNumberUniquenessKey(
                document.number,
                document.counterpartyId,
              ),
            })
            .where(eq(registryDocuments.id, document.id));
        }

        await transaction
          .delete(registryTypeFields)
          .where(eq(registryTypeFields.typeId, documentType.id));

        const attachedFields: Array<{
          key: string;
          name: string;
          dataType: string;
          isRequired: boolean;
          options?: string[];
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
                options: field.dataType === 'select' ? field.options : null,
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
            optionsOverride: field.dataType === 'select' ? field.options : null,
          });
          attachedFields.push({
            key: definition.key,
            name: field.name,
            dataType: definition.dataType,
            isRequired: field.isRequired,
            ...(field.dataType === 'select' ? { options: field.options } : {}),
          });
        }
        return {
          code: typeCode,
          name: input.name,
          sectionCode: sectionCodes[0],
          sectionCodes,
          lifecycleCode: input.lifecycleCode,
          ...numbering,
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
        roleSource: context.roleSource,
        roleDepartmentId: context.roleDepartmentId ?? null,
        departmentIds: context.departmentIds,
        ...policy,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
