import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import {
  missingRequiredBitrixScopes,
  normalizeBitrixScopes,
} from '../bitrix/bitrix-scopes.js';
import { ApiError } from '../http/api-error.js';
import type { RegistryContext } from '../http/registry-context.js';

interface BitrixEventBinding {
  event?: string;
  handler?: string;
  EVENT?: string;
  HANDLER?: string;
}

interface BitrixPlacementBinding {
  placement?: string;
  handler?: string;
  PLACEMENT?: string;
  HANDLER?: string;
}

const CRM_EVENTS = [
  'ONCRMDEALUPDATE',
  'ONCRMDEALDELETE',
  'ONCRMCOMPANYUPDATE',
  'ONCRMCOMPANYDELETE',
] as const;
const CRM_PLACEMENTS = [
  { code: 'CRM_DEAL_DETAIL_TAB', title: 'Документы' },
  { code: 'CRM_COMPANY_DETAIL_TAB', title: 'Документы' },
] as const;

const pendingEnsures = new Map<string, Promise<BitrixIntegrationStatus>>();

export interface BitrixIntegrationStatus {
  scopes: string[];
  missingScopes: string[];
  eventHandlerUrl: string;
  events: Array<{ event: string; registered: boolean }>;
  placementHandlerUrl: string;
  placements: Array<{ placement: string; registered: boolean }>;
}

export class BitrixIntegrationsService {
  constructor(
    private readonly bitrix: BitrixApiClient,
    private readonly eventHandlerUrl: string,
    private readonly placementHandlerUrl: string,
  ) {}

  status(context: RegistryContext) {
    const bitrixContext = this.requireBitrixContext(context);
    return this.loadStatus(bitrixContext.domain, bitrixContext.accessToken);
  }

  ensure(context: RegistryContext) {
    const bitrixContext = this.requireBitrixContext(context);
    const key = `${context.portalUrl}\0${context.userId}`;
    const pending = pendingEnsures.get(key);
    if (pending) return pending;

    const ensuring = this.ensureMissingIntegrations(
      bitrixContext.domain,
      bitrixContext.accessToken,
    ).finally(() => {
      pendingEnsures.delete(key);
    });
    pendingEnsures.set(key, ensuring);
    return ensuring;
  }

  private async ensureMissingIntegrations(domain: string, accessToken: string) {
    const before = await this.loadStatus(domain, accessToken);
    for (const event of before.events) {
      if (event.registered) continue;
      await this.bitrix.call<boolean>(
        domain,
        accessToken,
        'event.bind',
        { event: event.event, handler: this.eventHandlerUrl },
      );
    }
    for (const placement of before.placements) {
      if (placement.registered) continue;
      const config = CRM_PLACEMENTS.find((item) => item.code === placement.placement);
      if (!config) continue;
      await this.bitrix.call<boolean>(
        domain,
        accessToken,
        'placement.bind',
        {
          PLACEMENT: config.code,
          HANDLER: this.placementHandlerUrl,
          TITLE: config.title,
          LANG_ALL: {
            ru: { TITLE: config.title },
            en: { TITLE: 'Documents' },
          },
        },
      );
    }
    return this.loadStatus(domain, accessToken);
  }

  private async loadStatus(domain: string, accessToken: string): Promise<BitrixIntegrationStatus> {
    const [rawScopes, rawEventBindings, rawPlacementBindings] = await Promise.all([
      this.bitrix.call<string[]>(domain, accessToken, 'scope'),
      this.bitrix.call<BitrixEventBinding[]>(domain, accessToken, 'event.get'),
      this.bitrix.call<unknown>(domain, accessToken, 'placement.get'),
    ]);
    const scopes = normalizeBitrixScopes(rawScopes);
    const eventBindings = Array.isArray(rawEventBindings) ? rawEventBindings : [];
    const registeredEvents = new Set(
      eventBindings
        .filter((binding) => this.sameHandler(binding.handler ?? binding.HANDLER))
        .map((binding) => String(binding.event ?? binding.EVENT ?? '').toUpperCase()),
    );
    const placementBindings = flattenBindings(rawPlacementBindings) as BitrixPlacementBinding[];
    const registeredPlacements = new Set(
      placementBindings
        .filter((binding) => this.samePlacementHandler(binding.handler ?? binding.HANDLER))
        .map((binding) =>
          String(binding.placement ?? binding.PLACEMENT ?? '').toUpperCase(),
        ),
    );

    return {
      scopes,
      missingScopes: missingRequiredBitrixScopes(scopes),
      eventHandlerUrl: this.eventHandlerUrl,
      events: CRM_EVENTS.map((event) => ({
        event,
        registered: registeredEvents.has(event),
      })),
      placementHandlerUrl: this.placementHandlerUrl,
      placements: CRM_PLACEMENTS.map(({ code }) => ({
        placement: code,
        registered: registeredPlacements.has(code),
      })),
    };
  }

  private sameHandler(value: unknown) {
    if (typeof value !== 'string') return false;
    return value.replace(/\/+$/, '') === this.eventHandlerUrl.replace(/\/+$/, '');
  }

  private samePlacementHandler(value: unknown) {
    if (typeof value !== 'string') return false;
    return value.replace(/\/+$/, '') === this.placementHandlerUrl.replace(/\/+$/, '');
  }

  private requireBitrixContext(context: RegistryContext) {
    if (!context.bitrix) {
      throw new ApiError(
        400,
        'bitrix_integration_session_required',
        'Bitrix24 integration setup requires an authenticated Bitrix24 session.',
      );
    }
    return context.bitrix;
  }
}

function flattenBindings(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(flattenBindings);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  if (
    'placement' in record
    || 'PLACEMENT' in record
    || 'handler' in record
    || 'HANDLER' in record
  ) {
    return [record];
  }
  return Object.values(record).flatMap(flattenBindings);
}
