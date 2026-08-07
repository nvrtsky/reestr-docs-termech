import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { BitrixApiClient } from '../bitrix/bitrix-client.js';
import type { RegistryContext } from '../http/registry-context.js';
import { CrmContextService } from './crm-context.service.js';

class FakeBitrixClient implements BitrixApiClient {
  normalizeDomain(value: string) {
    return value;
  }

  async call<T>(_domain: string, _token: string, method: string): Promise<T> {
    if (method === 'crm.deal.get') {
      return {
        ID: '1234',
        TITLE: 'Поставка оборудования',
        COMPANY_ID: '77',
        STAGE_ID: 'C1:NEW',
      } as T;
    }
    if (method === 'crm.company.get') {
      return { ID: '77', TITLE: 'ООО «Ромашка»' } as T;
    }
    if (method === 'crm.status.list') {
      return [{ STATUS_ID: 'C1:NEW', NAME: 'Новая', COLOR: '#2563eb' }] as T;
    }
    if (method === 'user.get') {
      return [{ ID: '82', ACTIVE: true, NAME: 'Иван', LAST_NAME: 'Иванов' }] as T;
    }
    throw new Error(`Unexpected Bitrix method: ${method}`);
  }

  async upload<T>(): Promise<T> {
    throw new Error('Upload is not used by this test.');
  }
}

const context: RegistryContext = {
  portalUrl: 'https://example.bitrix24.ru',
  userId: 1,
  roleCode: 'admin',
  roleSource: 'bitrix_admin',
  departmentIds: [],
  source: 'bitrix',
  bitrix: {
    domain: 'example.bitrix24.ru',
    accessToken: 'test-access-token',
  },
};

describe('CRM placement context', () => {
  it('keeps the company as creation context without broadening a deal list', async () => {
    const resolved = await new CrmContextService(new FakeBitrixClient())
      .resolve(context, 'deal', 1234);

    assert.deepEqual(resolved.references, [
      { entityType: 'deal', entityId: 1234 },
    ]);
    assert.deepEqual(resolved.company, {
      id: 77,
      title: 'ООО «Ромашка»',
    });
  });

  it('returns the canonical deal company for server-side link validation', async () => {
    const resolved = await new CrmContextService(new FakeBitrixClient())
      .resolveDealSelection(context, 1234, 'Client supplied title');

    assert.deepEqual(resolved, {
      id: 1234,
      title: 'Поставка оборудования',
      companyId: 77,
    });
  });

  it('uses the live active Bitrix24 user name for responsible assignments', async () => {
    const resolved = await new CrmContextService(new FakeBitrixClient())
      .resolveUserSelection(context, 82, 'Client supplied name');

    assert.deepEqual(resolved, { id: 82, name: 'Иванов Иван' });
  });
});
