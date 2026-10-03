/** User scope versions are nested: full and basic include the minimal profile fields. */
export const BITRIX_SCOPE_ALIASES: Record<string, readonly string[]> = {
  user_brief: ['user_basic', 'user'],
  task: ['tasks'],
  tasks: ['task'],
};

export function hasBitrixScope(granted: readonly string[], required: string): boolean {
  return [required, ...(BITRIX_SCOPE_ALIASES[required] || [])]
    .some(scope => granted.includes(scope));
}
