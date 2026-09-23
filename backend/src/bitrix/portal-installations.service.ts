import { createHash, timingSafeEqual } from 'node:crypto';

import { and, eq, lte, or, sql } from 'drizzle-orm';

import type { AppConfig } from '../config.js';
import type { Database } from '../db/database.js';
import { seedPortal } from '../db/portal-seed.js';
import {
  registryPortalInstallations,
} from '../db/schema/index.js';
import { ApiError } from '../http/api-error.js';
import type { BitrixApiClient } from './bitrix-client.js';
import { TokenCipher } from './token-cipher.js';

interface DiskObject {
  ID?: string | number;
  NAME?: string;
  TYPE?: string;
}

interface DiskStorage {
  ID?: string | number;
  NAME?: string;
  ENTITY_TYPE?: string;
  ROOT_OBJECT_ID?: string | number;
}

interface OAuthResponse {
  access_token?: string;
  refresh_token?: string;
  expires?: number | string;
  expires_in?: number | string;
  domain?: string;
  member_id?: string;
  error?: string;
  error_description?: string;
}

export interface PortalInstallInput {
  memberId: string;
  domain: string;
  accessToken: string;
  refreshToken?: string;
  expiresInSeconds?: number;
  applicationToken: string;
}

export class PortalInstallationsService {
  private readonly cipher: TokenCipher | null;
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(
    private readonly database: Database,
    private readonly bitrix: BitrixApiClient,
    private readonly config: AppConfig,
  ) {
    this.cipher = config.TOKEN_ENCRYPTION_KEY
      ? new TokenCipher(config.TOKEN_ENCRYPTION_KEY)
      : null;
  }

  isMarketplaceEnabled() {
    return this.config.BITRIX_MARKETPLACE_MODE;
  }

  async install(input: PortalInstallInput) {
    const cipher = this.requireCipher();
    const domain = this.bitrix.normalizeDomain(input.domain);
    const portalUrl = `https://${domain}`;
    const now = new Date();
    const expiresAt = input.expiresInSeconds
      ? new Date(now.getTime() + input.expiresInSeconds * 1_000)
      : null;

    await this.database
      .insert(registryPortalInstallations)
      .values({
        memberId: input.memberId,
        domain,
        portalUrl,
        status: 'provisioning',
        accessTokenEncrypted: cipher.encrypt(input.accessToken),
        refreshTokenEncrypted: input.refreshToken
          ? cipher.encrypt(input.refreshToken)
          : null,
        accessTokenExpiresAt: expiresAt,
        applicationTokenHash: hashToken(input.applicationToken),
        installedAt: now,
      })
      .onConflictDoUpdate({
        target: registryPortalInstallations.memberId,
        set: {
          domain,
          portalUrl,
          status: 'provisioning',
          accessTokenEncrypted: cipher.encrypt(input.accessToken),
          refreshTokenEncrypted: input.refreshToken
            ? cipher.encrypt(input.refreshToken)
            : null,
          accessTokenExpiresAt: expiresAt,
          applicationTokenHash: hashToken(input.applicationToken),
          installedAt: now,
          uninstalledAt: null,
          deleteAfter: null,
          updatedAt: now,
        },
      });

    const rootFolderId = await this.ensureDiskRootFolder(domain, input.accessToken);
    await seedPortal(this.database, portalUrl, rootFolderId);
    await this.database
      .update(registryPortalInstallations)
      .set({ status: 'active', diskRootFolderId: rootFolderId, updatedAt: new Date() })
      .where(eq(registryPortalInstallations.memberId, input.memberId));

    return { domain, portalUrl, rootFolderId };
  }

  async assertActive(domainInput: string, memberId?: string) {
    if (!this.config.BITRIX_MARKETPLACE_MODE) return;
    const domain = this.bitrix.normalizeDomain(domainInput);
    const conditions = [
      eq(registryPortalInstallations.domain, domain),
      eq(registryPortalInstallations.status, 'active'),
    ];
    if (memberId) conditions.push(eq(registryPortalInstallations.memberId, memberId));
    const [installation] = await this.database
      .select({ memberId: registryPortalInstallations.memberId })
      .from(registryPortalInstallations)
      .where(and(...conditions))
      .limit(1);
    if (!installation) {
      throw new ApiError(
        403,
        'bitrix_portal_not_installed',
        'This Bitrix24 portal has not installed the application.',
      );
    }
  }

  async accessToken(domainInput: string, memberId?: string) {
    const domain = this.bitrix.normalizeDomain(domainInput);
    const installation = await this.findActive(domain, memberId);
    if (!installation) {
      throw new ApiError(403, 'bitrix_portal_not_installed', 'Application is not installed.');
    }
    if (
      !installation.accessTokenExpiresAt
      || installation.accessTokenExpiresAt.getTime() > Date.now() + 60_000
    ) {
      return this.requireCipher().decrypt(installation.accessTokenEncrypted);
    }
    return this.refreshAccessToken(installation.memberId);
  }

  async verifyEventToken(domainInput: string, memberId: string | undefined, token: string) {
    const domain = this.bitrix.normalizeDomain(domainInput);
    const installation = await this.find(domain, memberId);
    if (!installation) return false;
    return timingSafeHashMatches(token, installation.applicationTokenHash);
  }

  async uninstall({
    domain: domainInput,
    memberId,
    applicationToken,
    clean,
  }: {
    domain: string;
    memberId?: string;
    applicationToken: string;
    clean: boolean;
  }) {
    const domain = this.bitrix.normalizeDomain(domainInput);
    const installation = await this.find(domain, memberId);
    if (!installation || !timingSafeHashMatches(applicationToken, installation.applicationTokenHash)) {
      throw new ApiError(401, 'bitrix_event_token_invalid', 'Invalid Bitrix24 event token.');
    }
    if (clean) {
      await this.purgePortal(installation.portalUrl, installation.memberId);
      return { status: 'deleted' as const };
    }
    const now = new Date();
    const deleteAfter = new Date(
      now.getTime() + this.config.DATA_RETENTION_DAYS * 24 * 60 * 60 * 1_000,
    );
    await this.database
      .update(registryPortalInstallations)
      .set({
        status: 'retained',
        accessTokenEncrypted: this.requireCipher().encrypt('revoked'),
        refreshTokenEncrypted: null,
        accessTokenExpiresAt: null,
        uninstalledAt: now,
        deleteAfter,
        updatedAt: now,
      })
      .where(eq(registryPortalInstallations.id, installation.id));
    return { status: 'retained' as const, deleteAfter };
  }

  async purgeExpired(now = new Date()) {
    const expired = await this.database
      .select({ memberId: registryPortalInstallations.memberId, portalUrl: registryPortalInstallations.portalUrl })
      .from(registryPortalInstallations)
      .where(and(
        eq(registryPortalInstallations.status, 'retained'),
        lte(registryPortalInstallations.deleteAfter, now),
      ));
    for (const installation of expired) {
      await this.purgePortal(installation.portalUrl, installation.memberId);
    }
    return expired.length;
  }

  private async find(domain: string, memberId?: string) {
    const condition = memberId
      ? or(
          eq(registryPortalInstallations.memberId, memberId),
          eq(registryPortalInstallations.domain, domain),
        )
      : eq(registryPortalInstallations.domain, domain);
    const [installation] = await this.database
      .select()
      .from(registryPortalInstallations)
      .where(condition)
      .limit(1);
    if (
      installation
      && (installation.domain !== domain || (memberId && installation.memberId !== memberId))
    ) {
      throw new ApiError(403, 'bitrix_installation_mismatch', 'Bitrix24 installation does not match.');
    }
    return installation;
  }

  private async findActive(domain: string, memberId?: string) {
    const installation = await this.find(domain, memberId);
    return installation?.status === 'active' ? installation : null;
  }

  private refreshAccessToken(memberId: string) {
    const current = this.refreshes.get(memberId);
    if (current) return current;
    const refresh = this.performRefresh(memberId).finally(() => this.refreshes.delete(memberId));
    this.refreshes.set(memberId, refresh);
    return refresh;
  }

  private async performRefresh(memberId: string) {
    const [installation] = await this.database
      .select()
      .from(registryPortalInstallations)
      .where(and(
        eq(registryPortalInstallations.memberId, memberId),
        eq(registryPortalInstallations.status, 'active'),
      ))
      .limit(1);
    if (!installation?.refreshTokenEncrypted) {
      throw new ApiError(401, 'bitrix_refresh_token_missing', 'Bitrix24 refresh token is unavailable.');
    }
    if (!this.config.BITRIX_CLIENT_ID || !this.config.BITRIX_CLIENT_SECRET) {
      throw new ApiError(503, 'bitrix_oauth_not_configured', 'Bitrix24 OAuth is not configured.');
    }
    const cipher = this.requireCipher();
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.BITRIX_CLIENT_ID,
      client_secret: this.config.BITRIX_CLIENT_SECRET,
      refresh_token: cipher.decrypt(installation.refreshTokenEncrypted),
    });
    const response = await fetch(this.config.BITRIX_OAUTH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(this.config.BITRIX_REQUEST_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as OAuthResponse | null;
    if (!response.ok || !payload?.access_token || payload.error) {
      throw new ApiError(502, 'bitrix_oauth_refresh_failed', 'Bitrix24 OAuth refresh failed.', {
        bitrixCode: payload?.error || response.status,
      });
    }
    if (payload.domain && this.bitrix.normalizeDomain(payload.domain) !== installation.domain) {
      throw new ApiError(502, 'bitrix_oauth_domain_mismatch', 'Bitrix24 OAuth returned another portal.');
    }
    if (payload.member_id && payload.member_id !== installation.memberId) {
      throw new ApiError(502, 'bitrix_oauth_member_mismatch', 'Bitrix24 OAuth returned another installation.');
    }
    const expiresIn = positiveNumber(payload.expires_in ?? payload.expires) ?? 3_600;
    await this.database
      .update(registryPortalInstallations)
      .set({
        accessTokenEncrypted: cipher.encrypt(payload.access_token),
        refreshTokenEncrypted: payload.refresh_token
          ? cipher.encrypt(payload.refresh_token)
          : installation.refreshTokenEncrypted,
        accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1_000),
        updatedAt: new Date(),
      })
      .where(eq(registryPortalInstallations.id, installation.id));
    return payload.access_token;
  }

  private async ensureDiskRootFolder(domain: string, accessToken: string) {
    const storages = await this.bitrix.call<DiskStorage[]>(
      domain,
      accessToken,
      'disk.storage.getlist',
    );
    const storage = storages.find((item) => String(item.ENTITY_TYPE).toLowerCase() === 'common')
      ?? storages.find((item) => positiveNumber(item.ROOT_OBJECT_ID));
    const rootId = positiveNumber(storage?.ROOT_OBJECT_ID);
    if (!rootId) {
      throw new ApiError(409, 'bitrix_disk_storage_missing', 'Bitrix24 shared Disk is unavailable.');
    }
    const folderName = 'Реестр документов';
    const children = await this.bitrix.call<DiskObject[]>(
      domain,
      accessToken,
      'disk.folder.getchildren',
      { id: rootId, filter: { NAME: folderName, TYPE: 'folder' } },
    );
    const existingId = positiveNumber(
      children.find((item) => item.TYPE === 'folder' && item.NAME === folderName)?.ID,
    );
    if (existingId) return existingId;
    const folder = await this.bitrix.call<DiskObject>(
      domain,
      accessToken,
      'disk.folder.addsubfolder',
      { id: rootId, data: { NAME: folderName } },
    );
    const folderId = positiveNumber(folder.ID);
    if (!folderId) {
      throw new ApiError(502, 'bitrix_folder_invalid', 'Bitrix24 returned an invalid folder.');
    }
    return folderId;
  }

  private async purgePortal(portalUrl: string, memberId: string) {
    await this.database.transaction(async (transaction) => {
      await transaction.execute(sql`select set_config('registry.portal_to_purge', ${portalUrl}, true)`);
      await transaction.execute(sql`
        DO $$
        DECLARE table_name text;
        BEGIN
          FOREACH table_name IN ARRAY ARRAY[
            'registry_attachment_copies',
            'registry_audit_log',
            'registry_document_field_values',
            'registry_attachments',
            'registry_document_relations',
            'registry_document_links',
            'registry_task_links',
            'registry_bulk_upload_items',
            'registry_documents',
            'registry_type_fields',
            'registry_document_type_sections',
            'registry_number_sequences',
            'registry_document_types',
            'registry_field_definitions',
            'registry_sections',
            'registry_lifecycles',
            'registry_exchange_rates',
            'registry_saved_views',
            'registry_user_roles',
            'registry_department_roles',
            'registry_role_policies',
            'registry_settings_audit',
            'registry_settings'
          ]
          LOOP
            EXECUTE format('DELETE FROM %I WHERE portal_url = $1', table_name)
              USING current_setting('registry.portal_to_purge');
          END LOOP;
        END $$;
      `);
      await transaction
        .delete(registryPortalInstallations)
        .where(eq(registryPortalInstallations.memberId, memberId));
    });
  }

  private requireCipher() {
    if (!this.cipher) {
      throw new ApiError(503, 'bitrix_token_encryption_not_configured', 'Token encryption is not configured.');
    }
    return this.cipher;
  }
}

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function hashToken(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function timingSafeHashMatches(value: string, expectedHash: string) {
  const actual = Buffer.from(hashToken(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseExpirySeconds(value: unknown, nowMs = Date.now()) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  if (parsed > 1_000_000_000) {
    return Math.max(1, Math.floor(parsed - nowMs / 1_000));
  }
  return Math.floor(parsed);
}
