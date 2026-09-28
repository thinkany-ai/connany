import type { Config } from '../src/config.js';
export const config: Config = {
  databaseUrl: '', publicBaseUrl: 'http://localhost:3000', port: 3000, encryptionKey: Buffer.alloc(32, 7).toString('base64'),
  providers: { notion: { clientId: 'n-client', clientSecret: 'n-secret' }, github: { clientId: 'g-client', clientSecret: 'g-secret' }, linear: { clientId: 'l-client', clientSecret: 'l-secret' } },
  githubAppSlug: 'test-app', notionVersion: '2026-03-11', githubVersion: '2026-03-10', linearScopes: 'read'
};
