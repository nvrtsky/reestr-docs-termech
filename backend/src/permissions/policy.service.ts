import { and, eq } from 'drizzle-orm';

import type { Database } from '../db/database.js';
import { registryRolePolicies, registrySections } from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';

export type RegistryPolicy = Awaited<ReturnType<typeof loadRegistryPolicy>>;

export function isMoneyHidden(policy: RegistryPolicy) {
  return policy.hideMoney
    || policy.hiddenFields.includes('amount')
    || policy.hiddenFields.includes('currency');
}

export function isDocumentFieldHidden(
  policy: RegistryPolicy,
  field: { key: string; dataType: string },
) {
  return policy.hiddenFields.includes(field.key)
    || (isMoneyHidden(policy) && field.dataType === 'money');
}

export async function loadRegistryPolicy(
  database: Database,
  context: RegistryContext,
) {
  const [policy] = await database
    .select({
      roleCode: registryRolePolicies.roleCode,
      roleName: registryRolePolicies.roleName,
      visibleSectionCodes: registryRolePolicies.visibleSectionCodes,
      visibleTypeCodes: registryRolePolicies.visibleTypeCodes,
      hiddenFields: registryRolePolicies.hiddenFields,
      permissions: registryRolePolicies.permissions,
      hideMoney: registryRolePolicies.hideMoney,
    })
    .from(registryRolePolicies)
    .where(
      and(
        eq(registryRolePolicies.portalUrl, context.portalUrl),
        eq(registryRolePolicies.roleCode, context.roleCode),
        eq(registryRolePolicies.isActive, true),
      ),
    )
    .limit(1);

  if (!policy) {
    throw new ApiError(
      403,
      'role_policy_not_found',
      `No active policy exists for role ${context.roleCode}.`,
    );
  }

  if (context.roleCode === 'admin') {
    const sections = await database
      .select({ code: registrySections.code })
      .from(registrySections)
      .where(
        and(
          eq(registrySections.portalUrl, context.portalUrl),
          eq(registrySections.isActive, true),
        ),
      )
      .orderBy(registrySections.sortOrder);
    return {
      ...policy,
      roleName: 'Администратор',
      visibleSectionCodes: sections.map((section) => section.code),
      visibleTypeCodes: null,
      hiddenFields: [],
      permissions: {
        create: true,
        editOwn: true,
        editAny: true,
        transitionOwn: true,
        transitionAny: true,
        softDelete: true,
        restore: true,
        export: true,
        administer: true,
      },
      hideMoney: false,
    };
  }

  return policy;
}

export function assertSectionVisible(
  policy: RegistryPolicy,
  sectionCode: string,
) {
  if (!policy.visibleSectionCodes.includes(sectionCode)) {
    throw new ApiError(
      403,
      'section_access_denied',
      `Role ${policy.roleCode} cannot access section ${sectionCode}.`,
    );
  }
}

export function assertTypeVisible(policy: RegistryPolicy, typeCode: string) {
  if (policy.visibleTypeCodes && !policy.visibleTypeCodes.includes(typeCode)) {
    throw new ApiError(
      403,
      'type_access_denied',
      `Role ${policy.roleCode} cannot access document type ${typeCode}.`,
    );
  }
}
