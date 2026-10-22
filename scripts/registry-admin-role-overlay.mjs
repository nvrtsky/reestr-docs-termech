import assert from 'node:assert/strict';

// Applied last so the already released attachment and layout fixes stay intact.
export function registryAdminRoleOverlay(baseline) {
  let html = baseline;
  const replace = (before, after) => {
    assert.equal(html.split(before).length - 1, 1, `Expected one admin-role anchor: ${before}`);
    html = html.replace(before, after);
  };
  replace("adminRoleRows.filter(item => item.code !== 'admin' && item.isActive)", "adminRoleRows.filter(item => item.isActive)");
  replace('Администраторы Bitrix24 получают полный доступ автоматически.</div></div>', 'Роль «Администратор» открывает все разделы и настройки реестра. Назначение не меняет права в Bitrix24. Администраторы Bitrix24 получают полный доступ автоматически.</div></div>');
  replace("systemNote: 'Администраторы Bitrix24 получают полный доступ автоматически. Права роли фиксированы.'", "systemNote: 'Полный доступ к реестру и настройкам. Роль можно назначить сотруднику; права в Bitrix24 не меняются. Права роли фиксированы.'");
  replace("priority: assignment ? String(assignment.priority) : '100',\n        roleOptions: adminRoleOptions,", "priority: assignment ? String(assignment.priority) : '100',\n        roleOptions: adminRoleOptions.filter(item => item.code !== 'admin'),");
  replace("systemNote: capabilities.systemNote || '',", "systemNote: policy.roleCode === 'admin' ? 'Полный доступ к реестру и настройкам. Роль можно назначить сотруднику; права в Bitrix24 не меняются.' : (capabilities.systemNote || ''),");
  return html;
}
