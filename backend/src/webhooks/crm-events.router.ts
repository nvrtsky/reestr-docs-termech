import { Router } from 'express';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
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
}: {
  config: AppConfig;
  database: Database;
  bitrix: BitrixApiClient;
}) {
  const router = Router();
  const events = new CrmEventsService(database, bitrix);

  router.post('/', async (request, response, next) => {
    try {
      const event = crmEventSchema.parse(request.body);
      const domain = bitrix.normalizeDomain(event.auth.domain);
      const portalUrl = `https://${domain}`;
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
