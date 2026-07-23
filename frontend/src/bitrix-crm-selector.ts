interface SelectedCrmEntity {
  entityType: 'deal' | 'company';
  entityId: number;
  entityTitle: string;
}

interface SelectCrmItem {
  id?: string | number;
  title?: string;
}

interface SelectCrmResult {
  deal?: SelectCrmItem[];
  company?: SelectCrmItem[];
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
}): Promise<SelectedCrmEntity[]> {
  const bx24 = await loadClassicSdk();
  await initializeClassicSdk(bx24);
  const result = await new Promise<SelectCrmResult>((resolve) => {
    bx24.selectCRM(
      { entityType: ['deal', 'company'], multiple: true, value },
      (selection) => resolve(selection || {}),
    );
  });
  return normalizeSelection(result);
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

function normalizeSelection(result: SelectCrmResult) {
  const items: SelectedCrmEntity[] = [];
  for (const entityType of ['deal', 'company'] as const) {
    for (const item of result[entityType] || []) {
      const entityId = positiveId(item.id);
      const entityTitle = typeof item.title === 'string' ? item.title.trim().slice(0, 500) : '';
      if (!entityId || !entityTitle) continue;
      items.push({ entityType, entityId, entityTitle });
    }
  }
  return [...new Map(
    items.map((item) => [`${item.entityType}:${item.entityId}`, item]),
  ).values()];
}

function positiveId(value: unknown) {
  const match = String(value ?? '').match(/(\d+)$/);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
