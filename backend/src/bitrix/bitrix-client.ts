import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import { ApiError } from '../http/api-error.js';
import { logger } from '../logger.js';

interface BitrixResponse<T> {
  result?: T;
  error?: string;
  error_description?: string;
}

const RETRYABLE_READ_METHODS = new Set([
  'profile',
  'user.current',
  'user.get',
  'department.get',
  'crm.company.get',
  'crm.company.list',
  'crm.deal.get',
  'crm.deal.list',
  'crm.status.list',
  'crm.item.list',
  'tasks.task.get',
  'tasks.task.list',
  'disk.file.get',
  'disk.folder.getchildren',
  'event.get',
  'scope',
]);

export interface BitrixApiClient {
  normalizeDomain(value: string): string;
  call<T>(
    domainInput: string,
    accessToken: string,
    method: string,
    params?: object,
    apiVersion?: 'legacy' | 'v3',
  ): Promise<T>;
  upload<T>(
    domainInput: string,
    uploadUrlInput: string,
    body: AsyncIterable<Uint8Array>,
    contentType: string,
    contentLength?: string,
  ): Promise<T>;
}

export class BitrixClient implements BitrixApiClient {
  private readonly allowedDomains: Set<string>;

  constructor(
    allowedDomains: string[],
    private readonly timeoutMs: number,
    private readonly uploadTimeoutMs = timeoutMs,
    private readonly marketplaceMode = false,
    private readonly resolveAddresses: (domain: string) => Promise<string[]> = resolveHostAddresses,
  ) {
    this.allowedDomains = new Set(allowedDomains.map((domain) => domain.toLowerCase()));
  }

  normalizeDomain(value: string) {
    const domain = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!isSafeHostname(domain) || (
      !this.allowedDomains.has(domain)
      && !this.marketplaceMode
    )) {
      throw new ApiError(403, 'bitrix_domain_denied', 'Bitrix24 portal is not allowed.');
    }
    return domain;
  }

  async call<T>(
    domainInput: string,
    accessToken: string,
    method: string,
    params: object = {},
    apiVersion: 'legacy' | 'v3' = 'legacy',
  ) {
    const domain = this.normalizeDomain(domainInput);
    await this.assertPublicMarketplaceDomain(domain);
    const startedAt = Date.now();
    const retryableRead = RETRYABLE_READ_METHODS.has(method);
    const attemptTimeouts = retryableRead
      ? [
          Math.min(this.timeoutMs, 1_000),
          Math.min(this.timeoutMs, 1_000),
          Math.min(this.timeoutMs, 1_000),
          this.timeoutMs,
        ]
      : [this.timeoutMs];
    let response: Response | undefined;
    let requestError: unknown;
    for (const timeoutMs of attemptTimeouts) {
      try {
        const restPath = apiVersion === 'v3'
          ? `/rest/api/${method}`
          : `/rest/${method}.json`;
        response = await fetch(`https://${domain}${restPath}`, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ ...params, auth: accessToken }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        break;
      } catch (error) {
        requestError = error;
      }
    }
    if (!response) {
      logger.warn({
        event: 'bitrix_rest',
        domain,
        method,
        apiVersion,
        durationMs: Date.now() - startedAt,
        error: requestError instanceof Error ? requestError.name : 'unknown',
      }, 'Bitrix24 REST request failed');
      throw new ApiError(502, 'bitrix_unavailable', 'Bitrix24 REST API is unavailable.', {
        cause: requestError instanceof Error ? requestError.name : 'unknown',
      });
    }

    const payload = (await response.json().catch(() => null)) as BitrixResponse<T> | null;
    logger.info({
      event: 'bitrix_rest',
      domain,
      method,
      apiVersion,
      status: response.status,
      ok: response.ok && !!payload && !payload.error && payload.result !== undefined,
      durationMs: Date.now() - startedAt,
    }, 'Bitrix24 REST response');
    if (!response.ok || !payload || payload.error || payload.result === undefined) {
      const authError = response.status === 401 || payload?.error === 'expired_token';
      throw new ApiError(
        authError ? 401 : 502,
        authError ? 'bitrix_token_invalid' : 'bitrix_request_failed',
        authError
          ? 'Bitrix24 session has expired.'
          : 'Bitrix24 REST API rejected the request.',
        payload?.error ? { bitrixCode: payload.error } : undefined,
      );
    }
    return payload.result;
  }

  async upload<T>(
    domainInput: string,
    uploadUrlInput: string,
    body: AsyncIterable<Uint8Array>,
    contentType: string,
    contentLength?: string,
  ) {
    const domain = this.normalizeDomain(domainInput);
    await this.assertPublicMarketplaceDomain(domain);
    const startedAt = Date.now();
    let uploadUrl: URL;
    try {
      uploadUrl = new URL(uploadUrlInput);
    } catch {
      throw new ApiError(502, 'bitrix_upload_url_invalid', 'Bitrix24 returned an invalid upload URL.');
    }
    if (
      uploadUrl.protocol !== 'https:' ||
      uploadUrl.hostname.toLowerCase() !== domain ||
      uploadUrl.username ||
      uploadUrl.password ||
      (uploadUrl.port && uploadUrl.port !== '443')
    ) {
      throw new ApiError(502, 'bitrix_upload_url_invalid', 'Bitrix24 returned an invalid upload URL.');
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': contentType,
    };
    if (contentLength && /^\d+$/.test(contentLength)) {
      headers['content-length'] = contentLength;
    }

    let response: Response;
    try {
      response = await fetch(uploadUrl, {
        method: 'POST',
        redirect: 'error',
        headers,
        body: body as unknown as BodyInit,
        duplex: 'half',
        signal: AbortSignal.timeout(this.uploadTimeoutMs),
      } as RequestInit & { duplex: 'half' });
    } catch (error) {
      logger.warn({
        event: 'bitrix_rest',
        domain,
        method: 'disk.upload',
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.name : 'unknown',
      }, 'Bitrix24 Disk upload failed');
      throw new ApiError(502, 'bitrix_upload_failed', 'Could not upload the file to Bitrix24 Disk.', {
        cause: error instanceof Error ? error.name : 'unknown',
      });
    }

    const payload = (await response.json().catch(() => null)) as BitrixResponse<T> | null;
    logger.info({
      event: 'bitrix_rest',
      domain,
      method: 'disk.upload',
      status: response.status,
      ok: response.ok && !!payload && !payload.error && payload.result !== undefined,
      durationMs: Date.now() - startedAt,
    }, 'Bitrix24 Disk upload response');
    if (!response.ok || !payload || payload.error || payload.result === undefined) {
      throw new ApiError(
        502,
        'bitrix_upload_failed',
        'Bitrix24 Disk rejected the file upload.',
        payload?.error ? { bitrixCode: payload.error } : undefined,
      );
    }
    return payload.result;
  }

  private async assertPublicMarketplaceDomain(domain: string) {
    if (
      !this.marketplaceMode
      || this.allowedDomains.has(domain)
      || isBitrixCloudDomain(domain)
    ) return;

    let addresses: string[];
    try {
      addresses = await this.resolveAddresses(domain);
    } catch {
      throw new ApiError(403, 'bitrix_domain_denied', 'Bitrix24 portal is not publicly reachable.');
    }
    if (!addresses.length || addresses.some((address) => !isPublicAddress(address))) {
      throw new ApiError(403, 'bitrix_domain_denied', 'Bitrix24 portal must use a public network address.');
    }
  }
}

const BITRIX_CLOUD_SUFFIXES = [
  '.bitrix24.ru',
  '.bitrix24.com',
  '.bitrix24.by',
  '.bitrix24.kz',
  '.bitrix24.eu',
  '.bitrix24.com.br',
  '.bitrix24.in',
];

function isSafeHostname(value: string) {
  return value.length <= 253
    && value.includes('.')
    && !value.includes('..')
    && /^[a-z0-9.-]+$/.test(value)
    && !/^\d+(?:\.\d+){3}$/.test(value)
    && !value.startsWith('.')
    && !value.endsWith('.');
}

function isBitrixCloudDomain(value: string) {
  return BITRIX_CLOUD_SUFFIXES.some((suffix) => value.endsWith(suffix));
}

async function resolveHostAddresses(domain: string) {
  const addresses = await lookup(domain, { all: true, verbatim: true });
  return [...new Set(addresses.map(({ address }) => address))];
}

function isPublicAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version !== 6) return false;

  const normalized = address.toLowerCase();
  if (normalized.startsWith('::ffff:')) {
    return isPublicIpv4(normalized.slice('::ffff:'.length));
  }
  return normalized !== '::'
    && normalized !== '::1'
    && !normalized.startsWith('fc')
    && !normalized.startsWith('fd')
    && !/^fe[89ab]/.test(normalized)
    && !normalized.startsWith('ff')
    && !normalized.startsWith('2001:db8:');
}

function isPublicIpv4(address: string) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first = 0, second = 0, third = 0] = octets;
  return first !== 0
    && first !== 10
    && first !== 127
    && !(first === 100 && second >= 64 && second <= 127)
    && !(first === 169 && second === 254)
    && !(first === 172 && second >= 16 && second <= 31)
    && !(first === 192 && second === 0)
    && !(first === 192 && second === 168)
    && !(first === 198 && (second === 18 || second === 19))
    && !(first === 198 && second === 51 && third === 100)
    && !(first === 203 && second === 0 && third === 113)
    && first < 224;
}
