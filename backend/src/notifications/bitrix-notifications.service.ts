import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { RegistryContext } from '../http/registry-context.js';
import { logger } from '../logger.js';

interface NotificationDocument {
  id: string;
  title: string;
  number?: string | null;
  responsibleId: number;
}

export class BitrixNotificationsService {
  constructor(private readonly bitrix: BitrixApiClient) {}

  async responsibleAssigned(
    context: RegistryContext,
    document: NotificationDocument,
  ) {
    if (document.responsibleId === context.userId) return;
    await this.send(
      context,
      document.responsibleId,
      `registry-responsible-${document.id}-${document.responsibleId}`,
      `[B]Реестр документов[/B]\nВас назначили ответственным за документ «${this.label(document)}».`,
    );
  }

  async statusChanged(
    context: RegistryContext,
    document: NotificationDocument,
    statusCode: string,
    previousStatusLabel: string,
    nextStatusLabel: string,
  ) {
    if (document.responsibleId === context.userId) return;
    await this.send(
      context,
      document.responsibleId,
      `registry-status-${document.id}-${this.tagPart(statusCode)}`,
      `[B]Реестр документов[/B]\nСтатус документа «${this.label(document)}» изменён: «${previousStatusLabel}» → «${nextStatusLabel}».`,
    );
  }

  private async send(
    context: RegistryContext,
    userId: number,
    tag: string,
    message: string,
  ) {
    if (!context.bitrix) return;
    try {
      await this.bitrix.call<number | false>(
        context.bitrix.domain,
        context.bitrix.accessToken,
        'im.notify.system.add',
        {
          USER_ID: userId,
          MESSAGE: message,
          MESSAGE_OUT: message.replace(/\[\/?B\]/g, ''),
          TAG: tag.slice(0, 255),
        },
      );
    } catch (error) {
      logger.warn(
        {
          error,
          portalUrl: context.portalUrl,
          recipientUserId: userId,
          notificationTag: tag,
        },
        'Could not deliver Bitrix24 registry notification',
      );
    }
  }

  private label(document: NotificationDocument) {
    return document.number ? `${document.number} · ${document.title}` : document.title;
  }

  private tagPart(value: string) {
    return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 80) || 'changed';
  }
}
