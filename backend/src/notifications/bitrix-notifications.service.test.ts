import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { RegistryContext } from '../http/registry-context.js';
import { BitrixNotificationsService } from './bitrix-notifications.service.js';

class FakeBitrixClient implements BitrixApiClient {
  readonly messages: string[] = [];

  normalizeDomain(value: string) {
    return value;
  }

  async call<T>(_domain: string, _token: string, method: string, params?: object): Promise<T> {
    assert.equal(method, 'im.notify.system.add');
    this.messages.push(String((params as { MESSAGE?: unknown })?.MESSAGE || ''));
    return 1 as T;
  }

  async upload<T>(): Promise<T> {
    throw new Error('Upload is not used by this test.');
  }
}

const baseContext: RegistryContext = {
  portalUrl: 'https://example.bitrix24.ru',
  userId: 82,
  roleCode: 'admin',
  roleSource: 'bitrix_admin',
  departmentIds: [],
  source: 'bitrix',
  bitrix: {
    domain: 'example.bitrix24.ru',
    accessToken: 'test-token',
  },
};

describe('archive notification actor', () => {
  it('uses the Bitrix24 full name when it is available', async () => {
    const bitrix = new FakeBitrixClient();
    await new BitrixNotificationsService(bitrix).archiveChanged(
      { ...baseContext, userName: 'Иван Иванович Петров' },
      { id: 'doc-1', title: 'Договор', number: '123', responsibleId: 82 },
      'archived',
      [82],
    );

    assert.equal(bitrix.messages.length, 1);
    assert.match(bitrix.messages[0], /Действие выполнил Иван Иванович Петров\./);
    assert.doesNotMatch(bitrix.messages[0], /пользователь #82/i);
  });

  it('keeps the technical ID only as a fallback', async () => {
    const bitrix = new FakeBitrixClient();
    await new BitrixNotificationsService(bitrix).archiveChanged(
      baseContext,
      { id: 'doc-1', title: 'Договор', number: '123', responsibleId: 82 },
      'archived',
      [82],
    );

    assert.match(bitrix.messages[0], /Действие выполнил Пользователь #82\./);
  });
});
