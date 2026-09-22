import { createHash, timingSafeEqual } from 'node:crypto';

import { Router, json } from 'express';

import type { AppConfig } from '../config.js';
import { ApiError } from '../http/api-error.js';
import { documentReleaseSchema } from './document-releases.schemas.js';
import { canonicalPortalUrl, DocumentReleasesService } from './document-releases.service.js';

export function createDocumentReleasesRouter({
  config,
  releases,
}: {
  config: AppConfig;
  releases: DocumentReleasesService;
}) {
  const router = Router();
  const bodyLimit = Math.ceil(config.DOCUMENT_RELEASE_MAX_PDF_BYTES * 4 / 3) + 1024 * 1024;

  router.use((request, response, next) => {
    try {
      response.locals.releasePortalUrl = authorizeDocumentRelease(
        request.header('x-registry-portal'),
        request.header('authorization'),
        config.DOCUMENT_RELEASE_TOKENS_JSON,
      );
      next();
    } catch (error) {
      next(error);
    }
  });
  router.use(json({ limit: bodyLimit }));
  router.post('/', async (request, response, next) => {
    try {
      const input = documentReleaseSchema.parse(request.body);
      const portalUrl = canonicalPortalUrl(input.portalUrl);
      if (portalUrl !== response.locals.releasePortalUrl) {
        throw new ApiError(
          403,
          'document_release_portal_mismatch',
          'The service token is not valid for this portal.',
        );
      }
      const result = await releases.receive({ ...input, portalUrl });
      response.status(result.status === 'replayed' ? 200 : 201).json(result);
    } catch (error) {
      next(error);
    }
  });
  return router;
}

export function authorizeDocumentRelease(
  portalHeader: string | undefined,
  authorization: string | undefined,
  configuredTokens: Record<string, string>,
) {
  if (!portalHeader) {
    throw new ApiError(401, 'document_release_auth_required', 'A release service token is required.');
  }
  const portalUrl = canonicalPortalUrl(portalHeader);
  const expected = configuredTokens[portalUrl];
  const match = /^Bearer\s+(.{32,4096})$/i.exec(authorization || '');
  if (!expected || !match || !safeTokenMatch(match[1], expected)) {
    throw new ApiError(401, 'document_release_auth_invalid', 'The release service token is invalid.');
  }
  return portalUrl;
}

function safeTokenMatch(actual: string, expected: string) {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}
