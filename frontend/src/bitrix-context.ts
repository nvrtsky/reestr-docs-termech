import { initializeB24Frame, type B24Frame } from '@bitrix24/b24jssdk';

export interface RegistryBitrixContext {
  auth: {
    accessToken: string;
    domain: string;
    memberId: string;
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

const REQUIRED_SCOPES = ['crm', 'placement', 'user', 'department', 'disk', 'im', 'task'];

interface BitrixAppInfo {
  CODE?: string;
}

async function getFrame() {
  if (window.self === window.top) return null;
  if (!framePromise) {
    framePromise = initializeB24Frame().catch(() => null);
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

  const appInfo = await callFrame<BitrixAppInfo>(frame, 'app.info');
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
    (scope) => !normalizedScopes.includes(scope),
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
  if (!frame) return { auth: null, placement: null };
  if (refresh) await frame.auth.refreshAuth();
  const auth = frame.auth.getAuthData();
  return {
    auth: auth
      ? {
          accessToken: auth.access_token,
          domain: auth.domain,
          memberId: auth.member_id,
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

function positiveEntityId(value: unknown): string | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}
