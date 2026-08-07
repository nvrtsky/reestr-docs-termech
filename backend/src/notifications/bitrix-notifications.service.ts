import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { RegistryContext } from '../http/registry-context.js';
import { logger } from '../logger.js';

interface NotificationDocument {
  id: string;
  title: string;
  number?: string | null;
  responsibleId: number;
}

export interface NotificationDelivery {
  userId: number;
  status: 'sent' | 'failed' | 'skipped_no_session';
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
      `[B]Реестр документов[/B]\nСтатус документа «${this.label(document)}» изменён: «${this.escapeBbCode(previousStatusLabel)}» → «${this.escapeBbCode(nextStatusLabel)}».`,
    );
  }

  async archiveChanged(
    context: RegistryContext,
    document: NotificationDocument,
    action: 'archived' | 'restored',
    recipientIds: number[],
  ): Promise<NotificationDelivery[]> {
    const actionLabel = action === 'archived' ? 'архивирован' : 'восстановлен из архива';
    const actorLabel = this.escapeBbCode(
      context.userName?.trim() || `Пользователь #${context.userId}`,
    );
    const eventNonce = Date.now().toString(36);
    const recipients = [...new Set(recipientIds)]
      .filter((userId) => Number.isSafeInteger(userId) && userId > 0)
      .sort((left, right) => left - right);
    const deliveries: NotificationDelivery[] = [];
    for (const userId of recipients) {
      deliveries.push(await this.send(
        context,
        userId,
        `registry-archive-${document.id}-${action}-${eventNonce}-${userId}`,
        `[B]Реестр документов[/B]\nДокумент «${this.label(document)}» ${actionLabel}. Действие выполнил ${actorLabel}.`,
      ));
    }
    return deliveries;
  }

  private async send(
    context: RegistryContext,
    userId: number,
    tag: string,
    message: string,
  ): Promise<NotificationDelivery> {
    if (!context.bitrix) return { userId, status: 'skipped_no_session' };
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
      return { userId, status: 'sent' };
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
      return { userId, status: 'failed' };
    }
  }

  private label(document: NotificationDocument) {
    return this.escapeBbCode(
      document.number ? `${document.number} · ${document.title}` : document.title,
    );
  }

  private escapeBbCode(value: string) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('[', '&#91;')
      .replaceAll(']', '&#93;');
  }

  private tagPart(value: string) {
    return value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 80) || 'changed';
  }
}
