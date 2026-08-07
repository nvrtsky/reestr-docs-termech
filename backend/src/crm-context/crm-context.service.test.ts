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
    if (method === 'scope') return ['task'] as T;
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

class FakeBitrixV3TasksClient implements BitrixApiClient {
  calls: Array<{ method: string; params: object; apiVersion: string }> = [];

  normalizeDomain(value: string) {
    return value;
  }

  async call<T>(
    _domain: string,
    _token: string,
    method: string,
    params: object = {},
    apiVersion: 'legacy' | 'v3' = 'legacy',
  ): Promise<T> {
    this.calls.push({ method, params, apiVersion });
    if (method === 'scope') return ['crm', 'tasks'] as T;
    if (method === 'tasks.task.list') {
      const taskParams = params as {
        filter?: Array<[string, string | number, number?]>;
        pagination?: { page?: number };
      };
      const taskFilter = taskParams.filter?.[0];
      if (taskFilter?.length === 2) {
        return { items: [{ id: 1796, title: 'QA-REG задача' }] } as T;
      }
      if (taskFilter?.[2] === 0) {
        return {
          // The production portal may return fewer items than the requested
          // 1000-item limit while still having another page.
          items: Array.from({ length: 50 }, (_, index) => ({
            id: index + 1,
            title: `Посторонняя задача ${index}`,
          })),
        } as T;
      }
      if (taskFilter?.[2] === 50) {
        return { items: [{ id: 1796, title: 'QA-REG задача' }] } as T;
      }
      return { items: [] } as T;
    }
    if (method === 'tasks.task.get') {
      return { item: { id: 1796, title: 'QA-REG задача' } } as T;
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

  it('uses the REST 3.0 task route and searches subsequent pages by title', async () => {
    const bitrix = new FakeBitrixV3TasksClient();
    const service = new CrmContextService(bitrix);

    const tasks = await service.searchTasks(context, 'qa-reg', 20);
    const selected = await service.resolveTaskSelection(context, 1796);

    assert.deepEqual(tasks, [{ id: 1796, title: 'QA-REG задача' }]);
    assert.deepEqual(selected, { id: 1796, title: 'QA-REG задача' });
    const taskCalls = bitrix.calls.filter((call) => call.method.startsWith('tasks.task.'));
    assert.equal(taskCalls.every((call) => call.apiVersion === 'v3'), true);
    assert.deepEqual(
      taskCalls[0].params,
      {
        order: { id: 'ASC' },
        filter: [['id', '>', 0]],
        select: ['id', 'title'],
        pagination: { page: 1, limit: 1_000, offset: 0 },
      },
    );
    assert.deepEqual(
      (taskCalls[1].params as { filter: unknown }).filter,
      [['id', '>', 50]],
    );
    assert.deepEqual(
      (taskCalls[2].params as { filter: unknown }).filter,
      [['id', '>', 1796]],
    );
    assert.equal('id' in taskCalls[3].params, true);
  });

  it('uses the supported REST 3.0 id filter for an exact numeric search', async () => {
    const bitrix = new FakeBitrixV3TasksClient();
    const tasks = await new CrmContextService(bitrix).searchTasks(context, '1796', 20);

    assert.deepEqual(tasks, [{ id: 1796, title: 'QA-REG задача' }]);
    const taskCall = bitrix.calls.find((call) => call.method === 'tasks.task.list');
    assert.deepEqual(taskCall?.params, {
      order: { id: 'DESC' },
      filter: [['id', 1796]],
      select: ['id', 'title'],
      pagination: { page: 1, limit: 1, offset: 0 },
    });
    assert.equal(taskCall?.apiVersion, 'v3');
  });
});
