import { initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk';

export interface RegistryBitrixContext {
  deepLinkDocumentId: string | null;
  auth: {
    accessToken: string;
    domain: string;
    memberId: string;
  } | null;
  application: {
    id: string;
    code: string;
  } | null;
  placement: {
    code: string;
    title: string;
    options: unknown;
    entityId: string | null;
    isSliderMode: boolean;
  } | null;
}

let framePromise: Promise<B24Frame | null> | null = null;
let validationPromise: Promise<void> | null = null;
let appInfoPromise: Promise<BitrixAppInfo> | null = null;

const REQUIRED_SCOPES = ['crm', 'placement', 'user', 'department', 'disk', 'im', 'task'];
const SCOPE_ALIASES: Record<string, string[]> = {
  task: ['tasks'],
};

interface BitrixAppInfo {
  ID?: string | number;
  CODE?: string;
}

async function getFrame() {
  if (window.self === window.top) return null;
  if (!framePromise) {
    framePromise = initializeB24Frame().catch((error) => {
      framePromise = null;
      throw error;
    });
  }
  return framePromise;
}

export function validateRegistryBitrixApplication() {
  if (!validationPromise) {
    validationPromise = validateBitrixApplication().catch((error) => {
      validationPromise = null;
      throw error;
    });
  }
  return validationPromise;
}

async function validateBitrixApplication() {
  const frame = await getFrame();
  if (!frame) return;
  await frame.auth.refreshAuth();
  const auth = frame.auth.getAuthData();
  if (!auth) throw new Error('Bitrix24 не передал авторизацию приложения.');

  const appInfo = await getApplicationInfo(frame);
  const expectedAppCode = import.meta.env.VITE_BITRIX_APP_CODE?.trim();
  const actualAppCode = String(appInfo?.CODE || '').trim();
  if (expectedAppCode && actualAppCode !== expectedAppCode) {
    throw new Error(
      `Открыт старый пункт реестра (${actualAppCode || 'код не определён'}). `
      + `Нужно открыть приложение ${expectedAppCode}.`,
    );
  }

  const scopes = await callFrame<string[]>(frame, 'scope');
  const normalizedScopes = Array.isArray(scopes)
    ? scopes.map((scope) => String(scope).toLowerCase())
    : [];
  const missingScopes = REQUIRED_SCOPES.filter(
    (scope) => ![scope, ...(SCOPE_ALIASES[scope] || [])]
      .some((candidate) => normalizedScopes.includes(candidate)),
  );
  if (missingScopes.length) {
    throw new Error(
      `Bitrix24 не передал приложению ${actualAppCode || expectedAppCode || ''} права: `
      + `${missingScopes.join(', ')}. Получены: ${normalizedScopes.join(', ')}.`,
    );
  }
}

async function callFrame<T>(frame: B24Frame, method: string, params: object = {}) {
  const result = await frame.callMethod(method, params);
  const data = result.getData();
  if (!result.isSuccess || !data) {
    throw new Error(result.getErrorMessages().join('; ') || `Bitrix24: ${method}`);
  }
  return data.result as T;
}

export async function getRegistryBitrixContext(refresh = false): Promise<RegistryBitrixContext> {
  const frame = await getFrame();
  if (!frame) {
    return {
      deepLinkDocumentId: extractDeepLinkDocumentId({
        search: window.location.search,
        referrer: document.referrer,
      }),
      auth: null,
      application: null,
      placement: null,
    };
  }
  if (refresh) await frame.auth.refreshAuth();
  const auth = frame.auth.getAuthData();
  const appInfo = await getApplicationInfo(frame);
  const appId = positiveEntityId(appInfo.ID);
  return {
    deepLinkDocumentId: extractDeepLinkDocumentId({
      search: window.location.search,
      referrer: document.referrer,
      placementOptions: frame.placement.options,
    }),
    auth: auth
      ? {
          accessToken: auth.access_token,
          domain: normalizeBitrixDomain(auth.domain),
          memberId: auth.member_id,
        }
      : null,
    application: appId
      ? {
          id: appId,
          code: String(appInfo.CODE || '').trim(),
        }
      : null,
    placement: {
      code: frame.placement.placement,
      title: frame.placement.title,
      options: frame.placement.options,
      entityId: extractPlacementEntityId(frame.placement.options),
      isSliderMode: frame.placement.isSliderMode,
    },
  };
}

export function extractDeepLinkDocumentId({
  search = '',
  referrer = '',
  placementOptions,
}: {
  search?: string;
  referrer?: string;
  placementOptions?: unknown;
}) {
  return documentIdFromQuery(search)
    || documentIdFromUrl(referrer)
    || documentIdFromPlacementOptions(placementOptions)
    || null;
}

function getApplicationInfo(frame: B24Frame) {
  if (!appInfoPromise) {
    appInfoPromise = callFrame<BitrixAppInfo>(frame, 'app.info').catch((error) => {
      appInfoPromise = null;
      throw error;
    });
  }
  return appInfoPromise;
}

function extractPlacementEntityId(value: unknown): string | null {
  const parsed = parseJsonValue(value);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const entityId = extractPlacementEntityId(item);
      if (entityId) return entityId;
    }
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return positiveEntityId(parsed);

  const record = parsed as Record<string, unknown>;
  for (const key of [
    'ID',
    'id',
    'ENTITY_ID',
    'entityId',
    'entity_id',
    'ENTITY_VALUE_ID',
  ]) {
    const entityId = positiveEntityId(record[key]);
    if (entityId) return entityId;
  }

  for (const key of ['PLACEMENT_OPTIONS', 'placementOptions', 'options']) {
    const entityId = extractPlacementEntityId(record[key]);
    if (entityId) return entityId;
  }
  return null;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const DOCUMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOCUMENT_QUERY_KEYS = ['document', 'documentId', 'document_id', 'DOCUMENT_ID'];

function documentIdFromQuery(value: string) {
  const source = value.trim().replace(/^\?/, '');
  if (!source) return null;
  try {
    const params = new URLSearchParams(source);
    for (const key of DOCUMENT_QUERY_KEYS) {
      const candidate = params.get(key)?.trim();
      if (candidate && DOCUMENT_ID_PATTERN.test(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
}

function documentIdFromUrl(value: string) {
  if (!value.trim()) return null;
  try {
    const url = new URL(value);
    return documentIdFromQuery(url.search)
      || documentIdFromQuery(url.hash.replace(/^#/, ''));
  } catch {
    return documentIdFromQuery(value);
  }
}

function documentIdFromPlacementOptions(value: unknown, depth = 0): string | null {
  if (depth > 5 || value === null || value === undefined) return null;
  const parsed = parseJsonValue(value);
  if (typeof parsed === 'string') return documentIdFromUrl(parsed);
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const id = documentIdFromPlacementOptions(item, depth + 1);
      if (id) return id;
    }
    return null;
  }
  if (typeof parsed !== 'object') return null;

  const record = parsed as Record<string, unknown>;
  for (const key of DOCUMENT_QUERY_KEYS) {
    const candidate = String(record[key] || '').trim();
    if (DOCUMENT_ID_PATTERN.test(candidate)) return candidate;
  }
  for (const key of [
    'PLACEMENT_OPTIONS',
    'placementOptions',
    'options',
    'PARAMS',
    'params',
    'APP_PARAMS',
    'appParams',
  ]) {
    const id = documentIdFromPlacementOptions(record[key], depth + 1);
    if (id) return id;
  }
  return null;
}

function positiveEntityId(value: unknown): string | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

function normalizeBitrixDomain(value: unknown) {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return url.hostname.toLowerCase();
  } catch {
    return raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').toLowerCase();
  }
}
