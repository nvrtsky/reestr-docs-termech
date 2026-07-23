import { randomUUID } from 'node:crypto';

import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { pinoHttp } from 'pino-http';

import { createAdminCatalogsRouter } from './administration/admin-catalogs.router.js';
import { createAdministrationRouter } from './administration/administration.router.js';
import {
  BitrixSessionService,
  type BitrixSessionResolver,
} from './auth/bitrix-session.service.js';
import { BitrixClient, type BitrixApiClient } from './bitrix/bitrix-client.js';
import { createCatalogsRouter } from './catalogs/catalogs.router.js';
import type { AppConfig } from './config.js';
import { createCrmContextRouter } from './crm-context/crm-context.router.js';
import type { Database } from './db/database.js';
import { createDocumentsRouter } from './documents/documents.router.js';
import { ApiError } from './http/api-error.js';
import {
  localizedApiErrorMessage,
  localizedValidationDetails,
} from './http/error-localization.js';
import { createRegistryContextMiddleware } from './http/registry-context.js';
import { logger } from './logger.js';
import { createSavedViewsRouter } from './saved-views/saved-views.router.js';
import { createUsersRouter } from './users/users.router.js';
import { createCrmEventsRouter } from './webhooks/crm-events.router.js';

interface AppDependencies {
  config?: AppConfig;
  database?: Database;
  readinessCheck?: () => Promise<void>;
  bitrixSessionResolver?: BitrixSessionResolver;
  bitrixClient?: BitrixApiClient;
}

export function createApp({
  config,
  database,
  readinessCheck = async () => {},
  bitrixSessionResolver,
  bitrixClient,
}: AppDependencies = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));
  app.use(
    pinoHttp({
      logger,
      redact: {
        paths: ['req.headers.authorization'],
        censor: '[Redacted]',
      },
      genReqId: (request, response) => {
        const incomingId = request.headers['x-request-id'];
        const requestId = typeof incomingId === 'string' ? incomingId : randomUUID();
        response.setHeader('x-request-id', requestId);
        return requestId;
      },
    }),
  );

  app.get('/api/v1/health/live', (_request, response) => {
    response.json({ status: 'ok' });
  });

  app.get('/api/v1/health/ready', async (_request, response) => {
    try {
      await readinessCheck();
      response.json({ status: 'ready' });
    } catch (error) {
      logger.warn({ error }, 'Readiness check failed');
      response.status(503).json({ status: 'not_ready' });
    }
  });

  if (config && database) {
    const bitrix = bitrixClient ?? new BitrixClient(
      config.BITRIX_ALLOWED_DOMAINS,
      config.BITRIX_REQUEST_TIMEOUT_MS,
      config.BITRIX_UPLOAD_TIMEOUT_MS,
    );
    const sessions = bitrixSessionResolver ?? new BitrixSessionService(
      database,
      bitrix,
    );
    app.use(
      '/api/v1/bitrix/events',
      createCrmEventsRouter({ config, database, bitrix }),
    );
    const registryRouter = express.Router();
    registryRouter.use(createRegistryContextMiddleware(config, sessions));
    registryRouter.use('/admin', createAdminCatalogsRouter({ database }));
    registryRouter.use('/admin', createAdministrationRouter({ database, bitrix }));
    registryRouter.use(createCatalogsRouter({ database }));
    registryRouter.use('/users', createUsersRouter({ bitrix }));
    registryRouter.use('/saved-views', createSavedViewsRouter({ database }));
    registryRouter.use(createCrmContextRouter({ database, bitrix }));
    registryRouter.use('/documents', createDocumentsRouter({ database, bitrix }));
    app.use('/api/v1/registry', registryRouter);
  }

  app.use((request: Request, response: Response) => {
    response.status(404).json({
      error: {
        code: 'not_found',
        message: 'Запрошенный адрес API не найден.',
      },
    });
  });

  const errorHandler: ErrorRequestHandler = (
    error: unknown,
    _request: Request,
    response: Response,
    _next: NextFunction,
  ) => {
    if (error instanceof ApiError) {
      response.status(error.status).json({
        error: {
          code: error.code,
          message: localizedApiErrorMessage(error),
          details: error.details,
        },
      });
      return;
    }

    if (error && typeof error === 'object' && 'issues' in error) {
      response.status(400).json({
        error: {
          code: 'validation_error',
          message: 'Проверьте заполнение полей.',
          details: localizedValidationDetails((error as { issues: unknown }).issues),
        },
      });
      return;
    }

    logger.error({ error }, 'Unhandled request error');
    response.status(500).json({
      error: {
        code: 'internal_error',
        message: 'Внутренняя ошибка сервера.',
      },
    });
  };

  app.use(errorHandler);

  return app;
}
