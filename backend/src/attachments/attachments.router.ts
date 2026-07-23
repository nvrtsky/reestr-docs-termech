import { Router } from 'express';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { Database } from '../db/database.js';
import { requireRegistryContext } from '../http/registry-context.js';
import { documentIdSchema } from '../documents/documents.schemas.js';
import {
  addExternalLinkSchema,
  attachmentIdSchema,
  initializeFileUploadSchema,
  uploadIdSchema,
} from './attachments.schemas.js';
import { AttachmentsService } from './attachments.service.js';

export function createAttachmentsRouter({
  database,
  bitrix,
}: {
  database: Database;
  bitrix: BitrixApiClient;
}) {
  const router = Router({ mergeParams: true });
  const attachments = new AttachmentsService(database, bitrix);

  router.post('/link', async (request, response, next) => {
    try {
      const documentId = documentIdSchema.parse(
        (request.params as Record<string, string | undefined>).id,
      );
      const input = addExternalLinkSchema.parse(request.body);
      response
        .status(201)
        .json(await attachments.addExternalLink(requireRegistryContext(request), documentId, input));
    } catch (error) {
      next(error);
    }
  });

  router.post('/file/init', async (request, response, next) => {
    try {
      const documentId = documentIdSchema.parse(
        (request.params as Record<string, string | undefined>).id,
      );
      const input = initializeFileUploadSchema.parse(request.body);
      response.json(
        await attachments.initializeFileUpload(
          requireRegistryContext(request),
          documentId,
          input,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.post('/file/:uploadId', async (request, response, next) => {
    try {
      const documentId = documentIdSchema.parse(
        (request.params as Record<string, string | undefined>).id,
      );
      const uploadId = uploadIdSchema.parse(request.params.uploadId);
      const contentType = request.header('content-type') || '';
      if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) {
        response.status(415).json({
          error: {
            code: 'multipart_required',
            message: 'A multipart/form-data request is required.',
          },
        });
        return;
      }
      response.status(201).json(
        await attachments.uploadFile(
          requireRegistryContext(request),
          documentId,
          uploadId,
          request,
          contentType,
          request.header('content-length') || undefined,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.get('/:attachmentId/access', async (request, response, next) => {
    try {
      const documentId = documentIdSchema.parse(
        (request.params as Record<string, string | undefined>).id,
      );
      const attachmentId = attachmentIdSchema.parse(request.params.attachmentId);
      response.json(
        await attachments.getAccess(
          requireRegistryContext(request),
          documentId,
          attachmentId,
        ),
      );
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:attachmentId', async (request, response, next) => {
    try {
      const documentId = documentIdSchema.parse(
        (request.params as Record<string, string | undefined>).id,
      );
      const attachmentId = attachmentIdSchema.parse(request.params.attachmentId);
      await attachments.softDelete(
        requireRegistryContext(request),
        documentId,
        attachmentId,
      );
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
