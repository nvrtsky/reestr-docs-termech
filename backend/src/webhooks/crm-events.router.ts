import { Router } from 'express';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { PortalInstallationsService } from '../bitrix/portal-installations.service.js';
import {
  eventTokenMatchesHash,
  hashToken,
  loadBitrixEventTokenHash,
} from '../bitrix/bitrix-event-token.repository.js';
import type { AppConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { ApiError } from '../http/api-error.js';
import { crmEventSchema } from './crm-events.schemas.js';
import { CrmEventsService } from './crm-events.service.js';

export function createCrmEventsRouter({
  config,
  database,
  bitrix,
  installations,
}: {
  config: AppConfig;
  database: Database;
  bitrix: BitrixApiClient;
  installations?: PortalInstallationsService;
}) {
  const router = Router();
  const events = new CrmEventsService(database, bitrix);

  router.post('/', async (request, response, next) => {
    try {
      const rawEvent = String(request.body?.event || request.body?.EVENT || '').toUpperCase();
      if (rawEvent === 'ONAPPUNINSTALL') {
        if (!installations?.isMarketplaceEnabled()) {
          throw new ApiError(404, 'bitrix_uninstall_not_enabled', 'Marketplace lifecycle is disabled.');
        }
        const auth = asRecord(request.body?.auth);
        const data = asRecord(request.body?.data);
        const result = await installations.uninstall({
          domain: readString(auth.domain),
          memberId: optionalString(auth.member_id),
          applicationToken: readString(auth.application_token),
          clean: String(data.CLEAN ?? data.clean ?? '0') === '1',
        });
        response.json(result);
        return;
      }
      const event = crmEventSchema.parse(request.body);
      const domain = bitrix.normalizeDomain(event.auth.domain);
      const portalUrl = `https://${domain}`;
      if (installations?.isMarketplaceEnabled()) {
        const valid = await installations.verifyEventToken(
          domain,
          event.auth.member_id,
          event.auth.application_token,
        );
        if (!valid) {
          throw new ApiError(401, 'bitrix_event_token_invalid', 'Invalid Bitrix24 event token.');
        }
        const accessToken = await installations.accessToken(domain, event.auth.member_id);
        response.json(await events.processTracked({
          ...event,
          auth: { ...event.auth, access_token: accessToken },
        }, domain));
        return;
      }
      const storedTokenHash = await loadBitrixEventTokenHash(database, portalUrl);
      const fallbackTokenHash = config.BITRIX_EVENT_APPLICATION_TOKEN
        ? hashToken(config.BITRIX_EVENT_APPLICATION_TOKEN)
        : null;
      if (!storedTokenHash && !fallbackTokenHash) {
        throw new ApiError(
          503,
          'bitrix_event_token_not_configured',
          'Bitrix24 event token is not configured.',
        );
      }
      const validToken = [storedTokenHash, fallbackTokenHash].some(
        (expectedHash) => expectedHash
          && eventTokenMatchesHash(event.auth.application_token, expectedHash),
      );
      if (!validToken) {
        throw new ApiError(401, 'bitrix_event_token_invalid', 'Invalid Bitrix24 event token.');
      }
      response.json(await events.processTracked(event, domain));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown) {
  const result = String(value || '').trim();
  if (!result) throw new ApiError(400, 'bitrix_event_invalid', 'Bitrix24 event is incomplete.');
  return result;
}

function optionalString(value: unknown) {
  const result = String(value || '').trim();
  return result || undefined;
}
