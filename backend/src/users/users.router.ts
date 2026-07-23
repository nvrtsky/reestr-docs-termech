import { Router } from 'express';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import { requireRegistryContext } from '../http/registry-context.js';
import { listBitrixUsers } from './bitrix-users.service.js';

export function createUsersRouter({ bitrix }: { bitrix: BitrixApiClient }) {
  const router = Router();

  router.get('/', async (request, response, next) => {
    try {
      response.json({
        items: await listBitrixUsers(requireRegistryContext(request), bitrix),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
