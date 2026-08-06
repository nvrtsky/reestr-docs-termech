import { Router } from 'express';

import type { BitrixApiClient } from './bitrix-client.js';
import { saveBitrixEventTokenHash } from './bitrix-event-token.repository.js';
import {
  bitrixScopeAliases,
  missingRequiredBitrixScopes,
  normalizeBitrixScopes,
  REQUIRED_BITRIX_SCOPES,
} from './bitrix-scopes.js';
import type { Database } from '../db/database.js';
import { ApiError } from '../http/api-error.js';

interface InstallRouterOptions {
  database: Database;
  bitrix: BitrixApiClient;
  webOrigin: string;
}

export function createBitrixInstallRouter({
  database,
  bitrix,
  webOrigin,
}: InstallRouterOptions) {
  const router = Router();

  router.get('/', (_request, response) => {
    response
      .status(200)
      .type('text/plain')
      .send('Установочный обработчик реестра документов доступен.');
  });

  router.post('/', async (request, response, next) => {
    try {
      const payload = {
        ...asRecord(request.query),
        ...asRecord(request.body),
      };
      const auth = asRecord(payload.auth);
      const domain = bitrix.normalizeDomain(readRequired(
        [payload.DOMAIN, payload.domain, auth.domain],
        'bitrix_install_domain_missing',
        'Bitrix24 did not provide the portal domain.',
      ));
      const applicationToken = readRequired(
        [
          payload.APP_SID,
          payload.application_token,
          payload.AUTH_APPLICATION_TOKEN,
          auth.application_token,
        ],
        'bitrix_install_application_token_missing',
        'Bitrix24 did not provide the application token.',
      );
      const accessToken = readRequired(
        [
          payload.AUTH_ID,
          payload.auth_id,
          payload.access_token,
          auth.access_token,
        ],
        'bitrix_install_access_token_missing',
        'Bitrix24 did not provide the access token.',
      );
      const memberId = readOptional([payload.member_id, payload.memberId, auth.member_id]);
      const portalUrl = `https://${domain}`;
      const scopes = await bitrix.call<string[]>(domain, accessToken, 'scope');
      const normalizedScopes = normalizeBitrixScopes(scopes);
      const missingScopes = missingRequiredBitrixScopes(normalizedScopes);
      if (missingScopes.length) {
        throw new ApiError(
          400,
          'bitrix_install_scopes_missing',
          'Bitrix24 application permissions are incomplete.',
          { missingScopes },
        );
      }

      await saveBitrixEventTokenHash(
        database,
        portalUrl,
        applicationToken,
        memberId,
      );

      if (request.is('application/json')) {
        response.status(200).json({ status: 'ready' });
        return;
      }
      response
        .status(200)
        .type('html')
        .send(buildInstallerHtml({
          appUrl: new URL('/registry/', webOrigin).toString(),
          eventHandlerUrl: new URL('/api/v1/bitrix/events', webOrigin).toString(),
        }));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function buildInstallerHtml({
  appUrl,
  eventHandlerUrl,
}: {
  appUrl: string;
  eventHandlerUrl: string;
}) {
  const config = JSON.stringify({
    appUrl,
    eventHandlerUrl,
    scopes: REQUIRED_BITRIX_SCOPES,
    scopeAliases: bitrixScopeAliases(),
    placements: [
      { code: 'CRM_DEAL_DETAIL_TAB', title: 'Документы' },
      { code: 'CRM_COMPANY_DETAIL_TAB', title: 'Документы' },
    ],
    events: [
      'ONCRMDEALUPDATE',
      'ONCRMDEALDELETE',
      'ONCRMCOMPANYUPDATE',
      'ONCRMCOMPANYDELETE',
    ],
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Установка реестра документов</title>
  <script src="https://api.bitrix24.com/api/v1/"></script>
  <style>
    body { margin: 0; background: #f5f7f9; color: #263238; font: 15px/1.5 Arial, sans-serif; }
    main { max-width: 640px; margin: 48px auto; padding: 28px 32px; background: #fff; border-radius: 8px; }
    h1 { margin: 0 0 12px; font-size: 22px; }
    p { margin: 0; }
    .error { color: #b42318; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main>
    <h1>Реестр документов</h1>
    <p id="status">Настраиваем приложение в Bitrix24...</p>
  </main>
  <script>
    const config = ${config};
    const statusNode = document.getElementById('status');
    const normalizeUrl = value => String(value || '').replace(/\\/+$/, '');
    const flatten = value => {
      if (Array.isArray(value)) return value.flatMap(flatten);
      if (!value || typeof value !== 'object') return [];
      const keys = Object.keys(value);
      if (keys.some(key => ['placement', 'PLACEMENT', 'event', 'EVENT', 'handler', 'HANDLER'].includes(key))) {
        return [value];
      }
      return Object.values(value).flatMap(flatten);
    };
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      BX24.callMethod(method, params, result => {
        if (result.error()) {
          reject(new Error(result.error() + ': ' + (result.error_description() || 'ошибка Bitrix24')));
          return;
        }
        resolve(result.data());
      });
    });

    BX24.init(async () => {
      try {
        const scopes = (await call('scope')).map(value => String(value).toLowerCase());
        const missingScopes = config.scopes.filter(scope =>
          ![scope, ...(config.scopeAliases[scope] || [])].some(candidate => scopes.includes(candidate))
        );
        if (missingScopes.length) {
          throw new Error('Не добавлены права приложения: ' + missingScopes.join(', '));
        }

        const placementBindings = flatten(await call('placement.get'));
        for (const placement of config.placements) {
          const registered = placementBindings.some(item =>
            String(item.placement || item.PLACEMENT || '').toUpperCase() === placement.code
            && normalizeUrl(item.handler || item.HANDLER) === normalizeUrl(config.appUrl)
          );
          if (!registered) {
            await call('placement.bind', {
              PLACEMENT: placement.code,
              HANDLER: config.appUrl,
              TITLE: placement.title,
              LANG_ALL: {
                ru: { TITLE: placement.title },
                en: { TITLE: 'Documents' }
              }
            });
          }
        }

        const eventBindings = flatten(await call('event.get'));
        for (const event of config.events) {
          const registered = eventBindings.some(item =>
            String(item.event || item.EVENT || '').toUpperCase() === event
            && normalizeUrl(item.handler || item.HANDLER) === normalizeUrl(config.eventHandlerUrl)
          );
          if (!registered) {
            await call('event.bind', { event, handler: config.eventHandlerUrl });
          }
        }

        statusNode.textContent = 'Установка завершена.';
        BX24.installFinish();
      } catch (error) {
        statusNode.className = 'error';
        statusNode.textContent = 'Не удалось завершить установку: '
          + (error instanceof Error ? error.message : String(error));
      }
    });
  </script>
</body>
</html>`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readRequired(
  values: unknown[],
  code: string,
  message: string,
) {
  const value = readOptional(values);
  if (!value) throw new ApiError(400, code, message);
  return value;
}

function readOptional(values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}
