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
import { ApiError } from '../http/api-error.js';
import { previewKind, readDiskFile, preparePreview, PREVIEW_LIMIT, tooLarge } from './attachment-preview.js';
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

  router.get('/:attachmentId/preview', async (request, response, next) => {
    const controller = new AbortController();
    const close = () => controller.abort(); response.on('close', close);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]);
    try {
      const documentId = documentIdSchema.parse((request.params as Record<string,string>).id);
      const attachmentId = attachmentIdSchema.parse(request.params.attachmentId);
      const context = requireRegistryContext(request);
      const access = await attachments.getAccess(context, documentId, attachmentId);
      if(access.kind !== 'file' || !access.downloadUrl || !context.bitrix) throw new ApiError(409,'preview_file_required','Содержимое файла недоступно для предпросмотра.');
      if(!previewKind(access.name)) throw new ApiError(415,'preview_unsupported','Предпросмотр этого формата недоступен. Скачайте оригинал и откройте его на компьютере.');
      if(access.sizeBytes > PREVIEW_LIMIT) throw tooLarge();
      const file = await readDiskFile(access.downloadUrl, context.bitrix.domain, signal);
      const preview = await preparePreview(access.name, file, signal);
      if(!response.destroyed) response.set({
        'Content-Type':preview.mime, 'Cache-Control':'private, no-store',
        'X-Content-Type-Options':'nosniff', 'Content-Disposition':'inline',
        'Content-Security-Policy':"default-src 'none'; sandbox",
      }).send(preview.data);
    } catch(error) {
      if(!response.destroyed) next(error instanceof ApiError ? error : new ApiError(502,'preview_failed','Не удалось загрузить предпросмотр. Повторите попытку или скачайте оригинал.'));
    } finally { response.off('close',close); }
  });

  router.get('/:attachmentId/access', async (request, response, next) => {
    try {
      const documentId = documentIdSchema.parse(
        (request.params as Record<string, string | undefined>).id,
      );
      const attachmentId = attachmentIdSchema.parse(request.params.attachmentId);
      response.set('Cache-Control','private, no-store').json(
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
