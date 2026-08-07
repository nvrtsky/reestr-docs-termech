import type { NextFunction, Request, Response } from 'express';

import type { AppConfig } from '../config.js';
import type { BitrixSessionResolver } from '../auth/bitrix-session.service.js';
import { ApiError } from './api-error.js';

export interface RegistryContext {
  portalUrl: string;
  userId: number;
  userName?: string;
  roleCode: string;
  roleSource: 'development' | 'bitrix_admin' | 'user' | 'department';
  roleDepartmentId?: number;
  departmentIds: number[];
  source: 'development' | 'bitrix';
  bitrix?: {
    domain: string;
    accessToken: string;
    memberId?: string;
  };
}

declare global {
  namespace Express {
    interface Request {
      registryContext?: RegistryContext;
    }
  }
}

export function createRegistryContextMiddleware(
  config: AppConfig,
  bitrixSessions: BitrixSessionResolver,
) {
  return async (request: Request, _response: Response, next: NextFunction) => {
    try {
      const authorization = request.header('authorization') || '';
      const domain = request.header('x-bitrix-domain') || '';
      const memberId = request.header('x-bitrix-member-id') || undefined;
      const tokenMatch = /^Bearer\s+(.{10,4096})$/i.exec(authorization);

      if (!tokenMatch && !domain && config.NODE_ENV !== 'production') {
        const requestedDevelopmentRole = request
          .header('x-registry-development-role')
          ?.trim();
        request.registryContext = {
          portalUrl: config.DEVELOPMENT_PORTAL_URL.replace(/\/$/, ''),
          userId: config.DEVELOPMENT_USER_ID,
          roleCode: requestedDevelopmentRole && /^[a-z0-9_]{1,100}$/.test(requestedDevelopmentRole)
            ? requestedDevelopmentRole
            : config.DEVELOPMENT_ROLE,
          roleSource: 'development',
          departmentIds: [],
          source: 'development',
        };
        next();
        return;
      }
      if (!tokenMatch || !domain) {
        throw new ApiError(
          401,
          'bitrix_session_required',
          'A verified Bitrix24 session is required.',
        );
      }

      request.registryContext = await bitrixSessions.resolve(
        domain,
        tokenMatch[1],
        memberId,
      );
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireRegistryContext(request: Request): RegistryContext {
  if (!request.registryContext) {
    throw new Error('Registry context middleware was not applied.');
  }

  return request.registryContext;
}
