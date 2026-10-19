// Read-only synthetic fixture for browser verification and original help recordings.
const typePermissions = { view: true, create: true, edit: true, transition: true, archive: true, export: true, finance: true };
const permissions = {
  create: true, editOwn: true, editAny: true, transitionOwn: true, transitionAny: true,
  softDelete: true, restore: true, export: true, administer: false,
  byType: { supplier_contract: typePermissions, client_contract: typePermissions },
};
const sections = [
  { code: 'client', name: 'Клиентские', color: '#6366f1', sortOrder: 10, isActive: true },
  { code: 'supplier', name: 'Поставщик', color: '#0d9488', sortOrder: 20, isActive: true },
];
const types = [
  { code: 'client_contract', sectionCode: 'client', sectionName: 'Клиентские', name: 'Договор', lifecycleCode: 'simple', contentRequirement: 'required', fields: [], sortOrder: 10, isActive: true },
  { code: 'supplier_contract', sectionCode: 'supplier', sectionName: 'Поставщик', name: 'Договор поставщика', lifecycleCode: 'simple', contentRequirement: 'required', fields: [{ key: 'supplier_reference', label: 'Номер договора поставщика', dataType: 'text', options: [], isRequired: true, sortOrder: 10 }], sortOrder: 10, isActive: true },
];
const lifecycle = {
  code: 'simple', name: 'Простой', isActive: true,
  config: {
    initialStatus: 'draft',
    states: [{ code: 'draft', label: 'Черновик', color: '#71717a' }, { code: 'active', label: 'Активен', color: '#15803d', terminal: true }],
    transitions: [{ from: 'draft', to: 'active', roles: ['sales'] }],
  },
};
const salesPolicy = {
  roleCode: 'sales', roleName: 'Менеджер продаж', visibleSectionCodes: ['client', 'supplier'], visibleTypeCodes: null,
  hiddenFields: [], permissions, hideMoney: false, isActive: true,
};

const demoDocuments = [
  { id: 'demo-client-101', number: 'ДЕМО-101', title: 'Синтетический договор клиента', section: sections[0], type: types[0], status: 'draft', counterpartyName: 'Демо-компания А', responsibleId: 1, responsibleName: 'Демонстрационный администратор', documentDate: '2026-10-05', createdBy: 1, amount: '12000', currency: 'RUB', attachments: [], links: [], fields: [], history: [] },
  { id: 'demo-supplier-102', number: 'ДЕМО-102', title: 'Синтетический договор поставщика', section: sections[1], type: types[1], status: 'active', counterpartyName: 'Демо-компания Б', responsibleId: 1, responsibleName: 'Демонстрационный администратор', documentDate: '2026-10-04', createdBy: 1, amount: '8500', currency: 'RUB', attachments: [], links: [], fields: [], history: [] },
  { id: 'demo-client-103', number: 'ДЕМО-103', title: 'Синтетический договор: новый этап', section: sections[0], type: types[0], status: 'active', counterpartyName: 'Демо-компания В', responsibleId: 1, responsibleName: 'Демонстрационный администратор', documentDate: '2026-10-03', createdBy: 1, amount: '4600', currency: 'RUB', attachments: [], links: [], fields: [], history: [] },
];
export function registryOnboardingPayload(url) {
  const parsed = new URL(url);
  const path = parsed.pathname;
  if (path.endsWith('/me/policy')) return { ...salesPolicy, roleCode: 'admin', roleName: 'Демонстрационная роль', userId: 1, permissions: { ...permissions, administer: true } };
  if (path.endsWith('/admin/sections')) return { items: sections };
  if (path.endsWith('/admin/types')) return { items: types };
  if (path.endsWith('/admin/lifecycles')) return { items: [lifecycle] };
  if (path.endsWith('/admin/role-policies')) return { items: [salesPolicy] };
  if (path.endsWith('/admin/user-roles')) return { users: [{ id: 1, name: 'Демонстрационный администратор', isBitrixAdmin: true }], items: [] };
  if (path.endsWith('/sections')) return { items: sections.map(section => ({ ...section, types: types.filter(type => type.sectionCode === section.code) })) };
  if (path.endsWith('/lifecycles')) return { items: [lifecycle] };
  if (path.endsWith('/users')) return { items: [{ id: 1, name: 'Демонстрационный администратор' }] };
  if (path.endsWith('/saved-views')) return { items: [] };
  if (path.endsWith('/documents/options')) return { scopeTotal: 3, archiveTotal: 0, sections: { client: 2, supplier: 1 }, views: { all: 3, mine: 3, work: 2, draft: 1 }, responsibles: [{ id: 1, name: 'Демонстрационный администратор' }] };
  if (path.endsWith('/documents')) {
    const term = (parsed.searchParams.get('search') || '').toLowerCase();
    const items = demoDocuments.filter(doc => !term || [doc.number, doc.title, doc.counterpartyName].join(' ').toLowerCase().includes(term));
    return { items, meta: { total: items.length, limit: 50, offset: 0 } };
  }
  return {};
}

export async function installRegistryOnboardingFixture(page) {
  await page.route("**/api/v1/registry/**", async route => {
    if (route.request().method() !== "GET") throw new Error("Onboarding must not write API data");
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(registryOnboardingPayload(route.request().url())) });
  });
}
