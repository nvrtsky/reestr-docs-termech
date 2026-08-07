export const REQUIRED_BITRIX_SCOPES = [
  'crm',
  'placement',
  'user',
  'department',
  'disk',
  'im',
  'task',
] as const;

export type RequiredBitrixScope = typeof REQUIRED_BITRIX_SCOPES[number];

const SCOPE_ALIASES: Partial<Record<RequiredBitrixScope, readonly string[]>> = {
  // Bitrix24 may return the REST 3.0 task permission as `tasks`, while the
  // legacy tasks.task.* methods and older portals expose it as `task`.
  task: ['tasks'],
};

export function normalizeBitrixScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((scope) => String(scope).trim().toLowerCase())
      .filter(Boolean),
  )];
}

export function hasRequiredBitrixScope(
  scopes: readonly string[],
  requiredScope: RequiredBitrixScope,
) {
  if (scopes.includes(requiredScope)) return true;
  return (SCOPE_ALIASES[requiredScope] ?? []).some((scope) => scopes.includes(scope));
}

export function missingRequiredBitrixScopes(scopes: readonly string[]) {
  return REQUIRED_BITRIX_SCOPES.filter(
    (scope) => !hasRequiredBitrixScope(scopes, scope),
  );
}

export function bitrixScopeAliases() {
  return SCOPE_ALIASES;
}
