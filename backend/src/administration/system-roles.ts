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
    systemNote: 'После закрытия всех связанных сделок доступ к карточке и файлам снимается независимо от остальных настроек роли.',
  },
};

export function rolePolicyCapabilities(roleCode: string): RolePolicyCapabilities {
  return systemRoles[roleCode] ?? customRoleCapabilities;
}
