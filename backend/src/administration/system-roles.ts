export interface RolePolicyCapabilities {
  isSystem: boolean;
  canEditPolicy: boolean;
  canEditName: boolean;
  canDelete: boolean;
  fixedName: string | null;
  systemNote: string | null;
}

const customRoleCapabilities: RolePolicyCapabilities = {
  isSystem: false,
  canEditPolicy: true,
  canEditName: true,
  canDelete: true,
  fixedName: null,
  systemNote: null,
};

const systemRoles: Record<string, RolePolicyCapabilities> = {
  admin: {
    isSystem: true,
    canEditPolicy: false,
    canEditName: false,
    canDelete: false,
    fixedName: 'Администратор',
    systemNote: 'Администраторы Bitrix24 получают полный доступ автоматически. Права роли фиксированы.',
  },
  sales: {
    isSystem: true,
    canEditPolicy: true,
    canEditName: false,
    canDelete: false,
    fixedName: 'Менеджер продаж',
    systemNote: 'Менеджер видит назначенные ему документы. После закрытия всех доступных связанных сделок карточка и файлы остаются доступны для чтения, а изменения блокируются.',
  },
};

export function rolePolicyCapabilities(roleCode: string): RolePolicyCapabilities {
  return systemRoles[roleCode] ?? customRoleCapabilities;
}
