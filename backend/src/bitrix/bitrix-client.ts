import { ApiError } from '../http/api-error.js';

interface BitrixResponse<T> {
  result?: T;
  error?: string;
  error_description?: string;
}

export interface BitrixApiClient {
  normalizeDomain(value: string): string;
  call<T>(domainInput: string, accessToken: string, method: string, params?: object): Promise<T>;
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
  ) {
    this.allowedDomains = new Set(allowedDomains.map((domain) => domain.toLowerCase()));
  }

  normalizeDomain(value: string) {
    const domain = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    if (!this.allowedDomains.has(domain)) {
      throw new ApiError(403, 'bitrix_domain_denied', 'Bitrix24 portal is not allowed.');
    }
    return domain;
  }

  async call<T>(domainInput: string, accessToken: string, method: string, params: object = {}) {
    const domain = this.normalizeDomain(domainInput);
    let response: Response;
    try {
      response = await fetch(`https://${domain}/rest/${method}.json`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...params, auth: accessToken }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new ApiError(502, 'bitrix_unavailable', 'Bitrix24 REST API is unavailable.', {
        cause: error instanceof Error ? error.name : 'unknown',
      });
    }

    const payload = (await response.json().catch(() => null)) as BitrixResponse<T> | null;
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
        headers,
        body: body as unknown as BodyInit,
        duplex: 'half',
        signal: AbortSignal.timeout(this.uploadTimeoutMs),
      } as RequestInit & { duplex: 'half' });
    } catch (error) {
      throw new ApiError(502, 'bitrix_upload_failed', 'Could not upload the file to Bitrix24 Disk.', {
        cause: error instanceof Error ? error.name : 'unknown',
      });
    }

    const payload = (await response.json().catch(() => null)) as BitrixResponse<T> | null;
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
}
