import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TokenCipher } from './token-cipher.js';

test('encrypts tokens with authenticated random nonces', () => {
  const cipher = new TokenCipher(Buffer.alloc(32, 7).toString('base64'));
  const first = cipher.encrypt('access-token');
  const second = cipher.encrypt('access-token');

  assert.notEqual(first, second);
  assert.equal(cipher.decrypt(first), 'access-token');
  assert.equal(cipher.decrypt(second), 'access-token');
});

test('rejects modified encrypted tokens', () => {
  const cipher = new TokenCipher(Buffer.alloc(32, 9).toString('hex'));
  const encrypted = cipher.encrypt('refresh-token');
  const parts = encrypted.split('.');
  const ciphertext = Buffer.from(parts[3], 'base64url');
  ciphertext[0] ^= 1;
  parts[3] = ciphertext.toString('base64url');
  const modified = parts.join('.');
  assert.throws(() => cipher.decrypt(modified));
});

test('requires a 32 byte key', () => {
  assert.throws(() => new TokenCipher('too-short'), /32 bytes/);
});
