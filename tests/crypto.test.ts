import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Vault } from '../src/crypto.js';
import { loadConfig } from '../src/config.js';
test('encrypted credentials cannot be decrypted under another tenant or after tampering', () => {
  const vault = new Vault(randomBytes(32).toString('base64'));
  const cipher = vault.seal({ accessToken: 'very-secret' }, 'project-a:github:connection');
  assert(!cipher.includes('very-secret'));
  assert.deepEqual(vault.open(cipher, 'project-a:github:connection'), { accessToken: 'very-secret' });
  assert.throws(() => vault.open(cipher, 'project-b:github:connection'));
  const parts = cipher.split('.'); parts[3] = 'A' + parts[3].slice(1);
  if (parts.join('.') !== cipher) assert.throws(() => vault.open(parts.join('.'), 'project-a:github:connection'));
});
test('configuration rejects insecure public URLs and incomplete credentials', () => {
  const env = { DATABASE_URL: 'postgres://localhost/test', TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('base64') };
  assert.throws(() => loadConfig({ ...env, PUBLIC_BASE_URL: 'http://example.com' }));
  assert.throws(() => loadConfig({ ...env, GITHUB_CLIENT_ID: 'x' }));
  assert.equal(loadConfig(env).publicBaseUrl, 'http://localhost:3000');
});
