import type { Config } from '../src/config.js';
import { connectorNames } from '../src/connectors/catalog.js';
/** Client settings for every catalog connector; tests override the ones they exercise. */
export const connectorClients = (clients: Partial<Config['connectors']> = {}) =>
  Object.fromEntries(connectorNames.map(name => [name, clients[name] ?? { clientId: '', clientSecret: '' }])) as Config['connectors'];
export const config: Config = {
  databaseUrl: '', publicBaseUrl: 'http://localhost:3000', port: 3000, encryptionKey: Buffer.alloc(32, 7).toString('base64'),
  connectors: connectorClients({ notion: { clientId: 'n-client', clientSecret: 'n-secret' }, github: { clientId: 'g-client', clientSecret: 'g-secret' }, linear: { clientId: 'l-client', clientSecret: 'l-secret' } }),
  githubAppSlug: 'test-app', notionVersion: '2026-03-11', githubVersion: '2026-03-10', linearScopes: 'read'
};
