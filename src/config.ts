import { z } from 'zod';
import { providerNames, type ProviderName } from './providers/catalog.js';
export { providerNames, type ProviderName };
export interface Config {
  databaseUrl: string; publicBaseUrl: string; encryptionKey: string; port: number;
  providers: Record<ProviderName, { clientId: string; clientSecret: string }>;
  githubAppSlug: string; githubVersion: string; notionVersion: string; linearScopes: string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = z.string().min(1).parse(env.DATABASE_URL);
  const base = new URL(env.PUBLIC_BASE_URL || 'http://localhost:3000');
  if (base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
      !(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost','127.0.0.1'].includes(base.hostname)))) {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS origin (HTTP is allowed only on localhost).');
  }
  const encryptionKey = env.TOKEN_ENCRYPTION_KEY || '';
  if (Buffer.from(encryptionKey, 'base64').length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 random bytes encoded as base64.');
  const providers = Object.fromEntries(providerNames.map(name => {
    const prefix = name.toUpperCase();
    const clientId = name !== 'github' ? '' : env[`${prefix}_CLIENT_ID`] || '';
    const clientSecret = name !== 'github' ? '' : env[`${prefix}_CLIENT_SECRET`] || '';
    if (!!clientId !== !!clientSecret) throw new Error(`${prefix}: both client ID and secret are required.`);
    return [name, { clientId, clientSecret }];
  })) as Config['providers'];
  const githubAppSlug = env.GITHUB_APP_SLUG || '';
  if (providers.github.clientId && !/^[a-zA-Z0-9-]+$/.test(githubAppSlug)) throw new Error('GITHUB_APP_SLUG is required for GitHub App installation.');
  return { databaseUrl, publicBaseUrl: base.origin, encryptionKey,
    port: z.coerce.number().int().min(1).max(65535).parse(env.PORT || 3000), providers, githubAppSlug,
    githubVersion: env.GITHUB_API_VERSION || '2026-03-10', notionVersion: env.NOTION_API_VERSION || '2026-03-11',
    linearScopes: env.LINEAR_SCOPES || 'read' };
}
