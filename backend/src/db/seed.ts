import { loadConfig } from '../config.js';
import { logger } from '../logger.js';
import { and, eq } from 'drizzle-orm';
import { createDatabase } from './database.js';
import {
  registryDocumentTypes,
  registryDepartmentRoles,
  registryFieldDefinitions,
  registryLifecycles,
  registryRolePolicies,
  registrySections,
  registrySettings,
  registryTypeFields,
  registryUserRoles,
  type LifecycleConfig,
  type RolePermissions,
} from './schema/index.js';

const portalUrl = (
  process.env.SEED_PORTAL_URL ?? 'https://thermech.bitrix24.ru'
).replace(/\/$/, '');

const sections = [
  ['client', 'Клиентские', 'Документы по работе с клиентами и продажам', '#6366f1'],
  ['supplier', 'Поставщик', 'Закупка и отношения с поставщиками', '#0f9b8e'],
  ['logistics', 'Логистика', 'Перевозка, экспедирование, страхование', '#d97706'],
  ['customs', 'Таможня', 'Таможенное оформление и разрешения', '#dc2626'],
  ['legal', 'Юридические', 'Доверенности, претензии, переписка', '#7c3aed'],
  ['internal', 'Внутренние', 'Внутренние согласования и контроль', '#64748b'],
] as const;

const lifecycles: Array<[string, string, LifecycleConfig]> = [
  [
    'simple',
    'Простой',
    {
      initialStatus: 'draft',
      states: [
        { code: 'draft', label: 'Черновик', color: '#71717a' },
        { code: 'active', label: 'Активен', color: '#15803d' },
        { code: 'overdue', label: 'Просрочен', color: '#dc2626' },
        { code: 'archived', label: 'В архиве', color: '#64748b', terminal: true },
      ],
      transitions: [
        { from: 'draft', to: 'active' },
        { from: 'active', to: 'overdue' },
        { from: 'overdue', to: 'active' },
        { from: 'active', to: 'archived' },
        { from: 'overdue', to: 'archived' },
      ],
    },
  ],
  [
    'review',
    'С согласованием',
    {
      initialStatus: 'draft',
      states: [
        { code: 'draft', label: 'Черновик', color: '#71717a' },
        { code: 'on_review', label: 'На согласовании', color: '#c2410c' },
        { code: 'signed', label: 'Подписан', color: '#15803d' },
        { code: 'archived', label: 'В архиве', color: '#64748b', terminal: true },
      ],
      transitions: [
        { from: 'draft', to: 'on_review' },
        { from: 'on_review', to: 'draft' },
        { from: 'on_review', to: 'signed', roles: ['lawyer', 'admin'] },
        { from: 'signed', to: 'archived', roles: ['admin'] },
      ],
    },
  ],
  [
    'financial',
    'Финансовый',
    {
      initialStatus: 'draft',
      states: [
        { code: 'draft', label: 'Черновик', color: '#71717a' },
        { code: 'awaiting', label: 'Ожидает оплаты', color: '#2563eb' },
        { code: 'active', label: 'Активен', color: '#15803d' },
        { code: 'overdue', label: 'Просрочен', color: '#dc2626' },
        { code: 'archived', label: 'В архиве', color: '#64748b', terminal: true },
      ],
      transitions: [
        { from: 'draft', to: 'awaiting' },
        { from: 'awaiting', to: 'active', roles: ['accountant', 'admin'] },
        { from: 'awaiting', to: 'overdue' },
        { from: 'overdue', to: 'active', roles: ['accountant', 'admin'] },
        { from: 'active', to: 'archived' },
        { from: 'overdue', to: 'archived' },
      ],
    },
  ],
];

const documentTypes = [
  ['client', 'client_contract', 'Договор', 'review', false],
  ['client', 'client_addendum', 'Доп. соглашение', 'review', false],
  ['client', 'client_appendix', 'Приложение', 'simple', false],
  ['client', 'client_invoice', 'Счёт', 'financial', true],
  ['client', 'client_vat_invoice', 'Счёт-фактура', 'financial', true],
  ['client', 'client_upd', 'УПД', 'financial', true],
  ['client', 'client_act', 'Акт', 'simple', true],
  ['client', 'client_waybill', 'Накладная', 'simple', true],
  ['supplier', 'supplier_contract', 'Договор поставщика', 'review', false],
  ['supplier', 'supplier_specification', 'Спецификация', 'simple', false],
  ['supplier', 'supplier_offer', 'КП поставщика', 'simple', true],
  ['supplier', 'supplier_invoice', 'Инвойс', 'financial', true],
  ['supplier', 'supplier_packing_list', 'Упаковочный лист', 'simple', false],
  ['logistics', 'forwarding_contract', 'Договор экспедирования', 'review', false],
  ['logistics', 'transport_request', 'Заявка на перевозку', 'simple', true],
  ['logistics', 'transport_document', 'Транспортный документ', 'simple', false],
  ['logistics', 'insurance_document', 'Страховой документ', 'simple', true],
  ['customs', 'customs_declaration', 'Декларация', 'simple', false],
  ['customs', 'certificate', 'Сертификат', 'simple', false],
  ['customs', 'permit', 'Разрешительный документ', 'simple', false],
  ['customs', 'broker_document', 'Брокерский документ', 'simple', true],
  ['legal', 'power_of_attorney', 'Доверенность', 'review', false],
  ['legal', 'claim', 'Претензия', 'review', false],
  ['legal', 'response', 'Ответ', 'review', false],
  ['legal', 'letter', 'Письмо', 'simple', false],
  ['legal', 'legal_opinion', 'Юр. заключение', 'review', false],
  ['internal', 'memo', 'Служебная записка', 'review', false],
  ['internal', 'internal_approval', 'Внутреннее согласование', 'review', false],
  ['internal', 'checklist', 'Чек-лист', 'simple', false],
  ['internal', 'protocol', 'Протокол', 'simple', false],
] as const;

const fieldDefinitions = [
  ['payment_due_date', 'Срок оплаты', 'date', null],
  ['payment_terms', 'Условия оплаты', 'text', null],
  ['incoterms', 'Базис поставки', 'select', ['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF']],
  ['vat_rate', 'Ставка НДС', 'select', ['Без НДС', '0%', '10%', '20%']],
  ['customs_declaration_number', '№ ГТД', 'text', null],
  ['delivery_due_date', 'Срок поставки', 'date', null],
  ['contract_subject', 'Предмет договора', 'text', null],
  ['service_period', 'Период оказания услуг', 'text', null],
  ['warranty_months', 'Гарантийный срок, мес.', 'number', null],
] as const;

const typeFieldAssignments = [
  ['client_contract', 'contract_subject', true],
  ['client_contract', 'payment_due_date', false],
  ['client_contract', 'payment_terms', false],
  ['client_invoice', 'payment_due_date', true],
  ['client_invoice', 'vat_rate', false],
  ['client_upd', 'vat_rate', true],
  ['client_upd', 'delivery_due_date', false],
  ['supplier_invoice', 'incoterms', true],
  ['supplier_invoice', 'vat_rate', false],
  ['supplier_specification', 'delivery_due_date', true],
  ['supplier_specification', 'warranty_months', false],
  ['customs_declaration', 'customs_declaration_number', true],
  ['customs_declaration', 'incoterms', false],
  ['client_act', 'service_period', false],
  ['supplier_contract', 'contract_subject', true],
  ['supplier_contract', 'incoterms', false],
  ['supplier_contract', 'payment_terms', false],
] as const;

const allSections = sections.map(([code]) => code);
const fullPermissions: RolePermissions = {
  create: true,
  editOwn: true,
  editAny: true,
  transitionOwn: true,
  transitionAny: true,
  softDelete: true,
  restore: true,
  export: true,
  administer: false,
};

const rolePolicies = [
  {
    roleCode: 'sales',
    roleName: 'Менеджер продаж',
    visibleSectionCodes: ['client', 'internal'],
    hiddenFields: ['amount', 'currency'],
    hideMoney: true,
    permissions: { ...fullPermissions, editAny: false, transitionAny: false, softDelete: false, restore: false, export: false },
  },
  {
    roleCode: 'accountant',
    roleName: 'Бухгалтер',
    visibleSectionCodes: ['client', 'supplier'],
    hiddenFields: [],
    hideMoney: false,
    permissions: { ...fullPermissions, softDelete: false, restore: false },
  },
  {
    roleCode: 'lawyer',
    roleName: 'Юрист',
    visibleSectionCodes: ['client', 'legal'],
    hiddenFields: ['amount', 'currency'],
    hideMoney: true,
    permissions: { ...fullPermissions, transitionAny: false, softDelete: false, restore: false },
  },
  {
    roleCode: 'logistics',
    roleName: 'Закупка / логистика',
    visibleSectionCodes: ['supplier', 'logistics', 'customs'],
    hiddenFields: [],
    hideMoney: false,
    permissions: { ...fullPermissions, softDelete: false, restore: false },
  },
  {
    roleCode: 'admin',
    roleName: 'Администратор',
    visibleSectionCodes: allSections,
    hiddenFields: [],
    hideMoney: false,
    permissions: { ...fullPermissions, administer: true },
  },
];

const database = createDatabase(loadConfig());

try {
  await database.db.transaction(async (transaction) => {
    const sectionIds = new Map<string, string>();
    for (const [index, [code, name, description, color]] of sections.entries()) {
      const [section] = await transaction
        .insert(registrySections)
        .values({ portalUrl, code, name, description, color, sortOrder: (index + 1) * 10 })
        .onConflictDoUpdate({
          target: [registrySections.portalUrl, registrySections.code],
          set: { name, description, color, sortOrder: (index + 1) * 10, isActive: true, updatedAt: new Date() },
        })
        .returning({ id: registrySections.id });
      sectionIds.set(code, section.id);
    }

    const lifecycleIds = new Map<string, string>();
    for (const [code, name, config] of lifecycles) {
      const [lifecycle] = await transaction
        .insert(registryLifecycles)
        .values({ portalUrl, code, name, config })
        .onConflictDoUpdate({
          target: [registryLifecycles.portalUrl, registryLifecycles.code],
          set: { name, config, isActive: true, updatedAt: new Date() },
        })
        .returning({ id: registryLifecycles.id });
      lifecycleIds.set(code, lifecycle.id);
    }

    const typeOrder = new Map<string, number>();
    const typeIds = new Map<string, string>();
    for (const [sectionCode, code, name, lifecycleCode, isFinancial] of documentTypes) {
      const order = (typeOrder.get(sectionCode) ?? 0) + 10;
      typeOrder.set(sectionCode, order);
      const [documentType] = await transaction
        .insert(registryDocumentTypes)
        .values({
          portalUrl,
          sectionId: sectionIds.get(sectionCode)!,
          lifecycleId: lifecycleIds.get(lifecycleCode)!,
          code,
          name,
          isFinancial,
          sortOrder: order,
        })
        .onConflictDoUpdate({
          target: [registryDocumentTypes.portalUrl, registryDocumentTypes.code],
          set: {
            sectionId: sectionIds.get(sectionCode)!,
            lifecycleId: lifecycleIds.get(lifecycleCode)!,
            name,
            isFinancial,
            sortOrder: order,
            isActive: true,
            updatedAt: new Date(),
          },
        })
        .returning({ id: registryDocumentTypes.id });
      typeIds.set(code, documentType.id);
    }

    const fieldIds = new Map<string, string>();
    for (const [key, label, dataType, options] of fieldDefinitions) {
      const [fieldDefinition] = await transaction
        .insert(registryFieldDefinitions)
        .values({ portalUrl, key, label, dataType, options: options ? [...options] : null })
        .onConflictDoUpdate({
          target: [registryFieldDefinitions.portalUrl, registryFieldDefinitions.key],
          set: { label, dataType, options: options ? [...options] : null, isActive: true, updatedAt: new Date() },
        })
        .returning({ id: registryFieldDefinitions.id });
      fieldIds.set(key, fieldDefinition.id);
    }

    const fieldOrder = new Map<string, number>();
    for (const [typeCode, fieldKey, isRequired] of typeFieldAssignments) {
      const sortOrder = (fieldOrder.get(typeCode) ?? 0) + 10;
      fieldOrder.set(typeCode, sortOrder);
      await transaction
        .insert(registryTypeFields)
        .values({
          portalUrl,
          typeId: typeIds.get(typeCode)!,
          fieldDefinitionId: fieldIds.get(fieldKey)!,
          sortOrder,
          isRequired,
        })
        .onConflictDoUpdate({
          target: [
            registryTypeFields.portalUrl,
            registryTypeFields.typeId,
            registryTypeFields.fieldDefinitionId,
          ],
          set: { sortOrder, isRequired },
        });
    }

    for (const policy of rolePolicies) {
      await transaction
        .insert(registryRolePolicies)
        .values({ portalUrl, visibleTypeCodes: null, ...policy })
        .onConflictDoUpdate({
          target: [registryRolePolicies.portalUrl, registryRolePolicies.roleCode],
          set: { ...policy, isActive: true, updatedAt: new Date() },
        });
    }

    await transaction
      .delete(registryUserRoles)
      .where(
        and(
          eq(registryUserRoles.portalUrl, portalUrl),
          eq(registryUserRoles.roleCode, 'manager'),
        ),
      );
    await transaction
      .delete(registryDepartmentRoles)
      .where(
        and(
          eq(registryDepartmentRoles.portalUrl, portalUrl),
          eq(registryDepartmentRoles.roleCode, 'manager'),
        ),
      );
    await transaction
      .delete(registryRolePolicies)
      .where(
        and(
          eq(registryRolePolicies.portalUrl, portalUrl),
          eq(registryRolePolicies.roleCode, 'manager'),
        ),
      );

    await transaction
      .insert(registrySettings)
      .values({ portalUrl, key: 'default_lifecycle_code', value: 'simple' })
      .onConflictDoUpdate({
        target: [registrySettings.portalUrl, registrySettings.key],
        set: { value: 'simple', updatedAt: new Date() },
      });

    await transaction
      .insert(registrySettings)
      .values({ portalUrl, key: 'bitrix_disk_root_folder_id', value: { id: 55384 } })
      .onConflictDoUpdate({
        target: [registrySettings.portalUrl, registrySettings.key],
        set: { value: { id: 55384 }, updatedAt: new Date() },
      });
  });

  logger.info({ portalUrl }, 'Database seed completed');
} finally {
  await database.close();
}
