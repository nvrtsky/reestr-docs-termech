import { createHash, timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
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
      if (!config.BITRIX_EVENT_APPLICATION_TOKEN) {
        throw new ApiError(
          503,
          'bitrix_event_token_not_configured',
          'Bitrix24 event token is not configured.',
        );
      }
      if (!safeTokenEqual(
        event.auth.application_token,
        config.BITRIX_EVENT_APPLICATION_TOKEN,
      )) {
        throw new ApiError(401, 'bitrix_event_token_invalid', 'Invalid Bitrix24 event token.');
      }
      const domain = bitrix.normalizeDomain(event.auth.domain);
      response.json(await events.process(event, domain));
    } catch (error) {
      next(error);
    }
  });

  return router;
}

function safeTokenEqual(actual: string, expected: string) {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}
