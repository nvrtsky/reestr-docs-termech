export interface SelectedCrmEntity {
  entityType: 'deal' | 'company';
  entityId: number;
  entityTitle: string;
}

interface SelectCrmItem {
  id?: string | number;
  ID?: string | number;
  entityId?: string | number;
  entity_id?: string | number;
  title?: string;
  TITLE?: string;
  entityTitle?: string;
  name?: string;
}

interface SelectCrmResult {
  deal?: unknown;
  company?: unknown;
}

interface ClassicBx24 {
  init(callback: () => void): void;
  selectCRM(
    options: {
      entityType: Array<'deal' | 'company'>;
      multiple: boolean;
      value: { deal: number[]; company: number[] };
    },
    callback: (result: SelectCrmResult) => void,
  ): void;
  openPath(path: string, callback?: (result: unknown) => void): void;
}

declare global {
  interface Window {
    BX24?: ClassicBx24;
  }
}

let sdkPromise: Promise<ClassicBx24> | null = null;

export async function selectCrmEntities(value: {
  deal: number[];
  company: number[];
}, entityTypes: Array<'deal' | 'company'> = ['deal', 'company'], multiple = true): Promise<SelectedCrmEntity[]> {
  const bx24 = await loadClassicSdk();
  await initializeClassicSdk(bx24);
  const result = await new Promise<SelectCrmResult>((resolve) => {
    bx24.selectCRM(
      { entityType: entityTypes, multiple, value },
      (selection) => resolve(selection || {}),
    );
  });
  const selected = normalizeSelection(result)
    .filter((item) => entityTypes.includes(item.entityType));
  return constrainCrmSelection(selected, value, multiple);
}

export async function openBitrixPath(path: string) {
  const bx24 = await loadClassicSdk();
  await initializeClassicSdk(bx24);
  bx24.openPath(path);
}

function loadClassicSdk() {
  if (window.BX24) return Promise.resolve(window.BX24);
  if (window.self === window.top) {
    return Promise.reject(new Error('Bitrix24 CRM selector is available only inside Bitrix24.'));
  }
  if (!sdkPromise) {
    sdkPromise = new Promise<ClassicBx24>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://api.bitrix24.tech/api/v1/';
      script.async = true;
      script.onload = () => window.BX24
        ? resolve(window.BX24)
        : reject(new Error('Bitrix24 JS SDK did not initialize.'));
      script.onerror = () => reject(new Error('Bitrix24 JS SDK could not be loaded.'));
      document.head.appendChild(script);
    });
  }
  return sdkPromise;
}

function initializeClassicSdk(bx24: ClassicBx24) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(
      () => reject(new Error('Bitrix24 JS SDK initialization timed out.')),
      15_000,
    );
    bx24.init(() => {
      window.clearTimeout(timeout);
      resolve();
    });
  });
}

export function normalizeSelection(result: SelectCrmResult) {
  const items: SelectedCrmEntity[] = [];
  for (const entityType of ['deal', 'company'] as const) {
    for (const item of selectionItems(result[entityType])) {
      const entityId = positiveId(item.id ?? item.ID ?? item.entityId ?? item.entity_id);
      const rawTitle = item.title ?? item.TITLE ?? item.entityTitle ?? item.name;
      const entityTitle = typeof rawTitle === 'string' ? rawTitle.trim().slice(0, 500) : '';
      if (!entityId || !entityTitle) continue;
      items.push({ entityType, entityId, entityTitle });
    }
  }
  return [...new Map(
    items.map((item) => [`${item.entityType}:${item.entityId}`, item]),
  ).values()];
}

export function constrainCrmSelection(
  items: SelectedCrmEntity[],
  currentValue: { deal: number[]; company: number[] },
  multiple: boolean,
) {
  if (multiple || items.length <= 1) return items;

  const currentKeys = new Set<string>();
  for (const entityType of ['deal', 'company'] as const) {
    for (const rawId of currentValue[entityType] || []) {
      const entityId = positiveId(rawId);
      if (entityId) currentKeys.add(`${entityType}:${entityId}`);
    }
  }
  const replacements = items.filter(
    (item) => !currentKeys.has(`${item.entityType}:${item.entityId}`),
  );
  const selected = replacements[replacements.length - 1] || items[items.length - 1];
  return selected ? [selected] : [];
}

function selectionItems(value: unknown, visited = new Set<object>()): SelectCrmItem[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => selectionItems(item, visited));
  }
  if (!value || typeof value !== 'object') return [];
  if (visited.has(value)) return [];
  visited.add(value);

  const item = value as SelectCrmItem & Record<string, unknown>;
  if (
    item.id !== undefined
    || item.ID !== undefined
    || item.entityId !== undefined
    || item.entity_id !== undefined
  ) {
    return [item];
  }
  return Object.values(item).flatMap((entry) => selectionItems(entry, visited));
}

function positiveId(value: unknown) {
  const match = String(value ?? '').match(/(\d+)$/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
