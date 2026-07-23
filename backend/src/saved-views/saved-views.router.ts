import { and, asc, eq, or } from 'drizzle-orm';
import { Router } from 'express';

import type { Database } from '../db/database.js';
import { registrySavedViews } from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import { requireRegistryContext } from '../http/registry-context.js';
import { loadRegistryPolicy } from '../permissions/policy.service.js';
import {
  createSavedViewSchema,
  updateSavedViewSchema,
  type CreateSavedViewInput,
} from './saved-views.schemas.js';

interface SavedViewsRouterDependencies {
  database: Database;
}

function responseItem(
  item: typeof registrySavedViews.$inferSelect,
  userId: number,
  administer: boolean,
) {
  return {
    id: item.id,
    name: item.name,
    filters: item.filters,
    columns: item.columns,
    isShared: item.isShared,
    isOwner: item.ownerUserId === userId,
    canManage: item.ownerUserId === userId || administer,
  };
}

function assertSharedAllowed(input: CreateSavedViewInput, administer: boolean) {
  if (input.isShared && !administer) {
    throw new ApiError(
      403,
      'shared_saved_view_access_denied',
      'Only a registry administrator can manage shared views.',
    );
  }
}

export function createSavedViewsRouter({ database }: SavedViewsRouterDependencies) {
  const router = Router();

  router.get('/', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const policy = await loadRegistryPolicy(database, context);
      const items = await database
        .select()
        .from(registrySavedViews)
        .where(
          and(
            eq(registrySavedViews.portalUrl, context.portalUrl),
            or(
              eq(registrySavedViews.ownerUserId, context.userId),
              eq(registrySavedViews.isShared, true),
            ),
          ),
        )
        .orderBy(asc(registrySavedViews.sortOrder), asc(registrySavedViews.name));
      response.json({
        items: items.map((item) =>
          responseItem(item, context.userId, policy.permissions.administer)),
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const policy = await loadRegistryPolicy(database, context);
      const input = createSavedViewSchema.parse(request.body);
      assertSharedAllowed(input, policy.permissions.administer);
      const [created] = await database
        .insert(registrySavedViews)
        .values({
          portalUrl: context.portalUrl,
          ownerUserId: context.userId,
          name: input.name,
          filters: input.filters,
          columns: input.columns,
          isShared: input.isShared,
        })
        .returning();
      response.status(201).json(
        responseItem(created, context.userId, policy.permissions.administer),
      );
    } catch (error) {
      next(error);
    }
  });

  router.put('/:id', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const policy = await loadRegistryPolicy(database, context);
      const input = updateSavedViewSchema.parse(request.body);
      assertSharedAllowed(input, policy.permissions.administer);
      const [current] = await database
        .select()
        .from(registrySavedViews)
        .where(
          and(
            eq(registrySavedViews.id, request.params.id),
            eq(registrySavedViews.portalUrl, context.portalUrl),
          ),
        )
        .limit(1);
      if (!current) throw new ApiError(404, 'saved_view_not_found', 'Saved view was not found.');
      if (current.ownerUserId !== context.userId && !policy.permissions.administer) {
        throw new ApiError(403, 'saved_view_access_denied', 'The saved view cannot be changed.');
      }
      const [updated] = await database
        .update(registrySavedViews)
        .set({
          name: input.name,
          filters: input.filters,
          columns: input.columns,
          isShared: input.isShared,
          updatedAt: new Date(),
        })
        .where(eq(registrySavedViews.id, current.id))
        .returning();
      response.json(responseItem(updated, context.userId, policy.permissions.administer));
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id', async (request, response, next) => {
    try {
      const context = requireRegistryContext(request);
      const policy = await loadRegistryPolicy(database, context);
      const [current] = await database
        .select()
        .from(registrySavedViews)
        .where(
          and(
            eq(registrySavedViews.id, request.params.id),
            eq(registrySavedViews.portalUrl, context.portalUrl),
          ),
        )
        .limit(1);
      if (!current) throw new ApiError(404, 'saved_view_not_found', 'Saved view was not found.');
      if (current.ownerUserId !== context.userId && !policy.permissions.administer) {
        throw new ApiError(403, 'saved_view_access_denied', 'The saved view cannot be deleted.');
      }
      await database.delete(registrySavedViews).where(eq(registrySavedViews.id, current.id));
      response.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
