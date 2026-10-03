import assert from 'node:assert/strict';
import test from 'node:test';
import { hasBitrixScope as backend } from '../backend/src/bitrix/bitrix-scopes.js';
import { hasBitrixScope as frontend } from '../frontend/src/bitrix-scopes.js';

for (const [name, check] of [['frontend', frontend], ['backend', backend]] as const) {
  test(`${name}: minimal, basic and full user scopes permit reading minimal profiles`, () => {
    for (const granted of ['user_brief', 'user_basic', 'user']) assert.equal(check([granted], 'user_brief'), true);
  });
  test(`${name}: missing profile or unrelated rights remain denied`, () => {
    assert.equal(check(['crm', 'disk', 'user.userfield'], 'user_brief'), false);
    assert.equal(check(['user_brief'], 'crm'), false);
    assert.equal(check(['user_brief'], 'user'), false);
    assert.equal(check(['user_brief'], 'user_basic'), false);
  });
  test(`${name}: both task scope spellings are supported`, () => {
    assert.equal(check(['tasks'], 'task'), true);
    assert.equal(check(['task'], 'tasks'), true);
    assert.equal(check([], 'tasks'), false);
  });
}
