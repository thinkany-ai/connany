import { HostedMcp } from './hosted-mcp.js';
import { z } from 'zod';
import { githubActions } from './github-actions.js';
import type { Config } from '../config.js';
import { provider as definition, providerNames, type ProviderName } from './catalog.js';
import { challenge } from '../crypto.js';
import { AppError, ProviderError } from '../errors.js';

export interface Credentials { accessToken: string; refreshToken?: string; expiresAt?: string; refreshExpiresAt?: string; scopes?: string[] }
export interface Identity { account_id: string; account_name: string; workspace_id?: string; workspace_name?: string; [key: string]: unknown }
export type Fetcher = typeof fetch;
const pagination = { limit: z.number().int().min(1).max(100).default(20), cursor: z.string().max(500).optional() };
export const actions = {
  ...githubActions,
  'github.installations.list': { provider: 'github', description: 'List installations of this GitHub App accessible to the user.', schema: z.object({ page: z.number().int().min(1).max(10000).default(1), limit: pagination.limit }).strict() },
  'github.repositories.list': { provider: 'github', description: 'List repositories accessible to both the user and a GitHub App installation.', schema: z.object({ installation_id: z.number().int().positive(), page: z.number().int().min(1).max(10000).default(1), limit: pagination.limit }).strict() },
} as const;
export type ActionName = keyof typeof actions | `${ProviderName}.${string}`;
/** Dynamic MCP tool names: `<provider>.<upstream tool>`. */
export const mcpActionPattern = new RegExp(`^(${providerNames.join('|')})\\.[a-zA-Z0-9_-]{1,128}$`);
export function actionCatalog() { return Object.entries(actions).map(([name, a]) => ({ name, provider: a.provider, description: a.description, read_only: 'read_only' in a ? a.read_only : true, required_permissions: 'required_permissions' in a ? a.required_permissions : ['Metadata: read'], input_schema: z.toJSONSchema(a.schema) })); }

export class Providers {
  constructor(public config: Config, private fetcher: Fetcher = fetch) {}
  mcp(provider: ProviderName) { return new HostedMcp(this.fetcher,provider); }
  withConfig(config: Config) { return new Providers(config, this.fetcher); }
  enabled(provider: ProviderName) { return !!this.config.providers[provider].clientId; }
  callback(provider: ProviderName) { return `${this.config.publicBaseUrl}/oauth/${provider}/callback`; }
  installUrl() { return `https://github.com/apps/${this.config.githubAppSlug}/installations/new`; }
  authorizeUrl(provider: ProviderName, state: string, verifier: string) {
    if (!this.enabled(provider)) throw new AppError('provider_not_configured', 'This provider is not configured.', 503);
    const spec = definition(provider);
    const url = new URL(spec.auth === 'mcp' ? `${spec.mcp.origin}/authorize` : 'https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({ client_id: this.config.providers[provider].clientId, redirect_uri: this.callback(provider), response_type: 'code', state }).toString();
    { url.searchParams.set('code_challenge', challenge(verifier)); url.searchParams.set('code_challenge_method', 'S256'); }
    for (const [key, value] of Object.entries(spec.mcp.authorizeParams || {})) if (spec.auth === 'mcp') url.searchParams.set(key, value);
    const resource = spec.auth === 'mcp' ? this.mcp(provider).resource : undefined;
    if (resource) url.searchParams.set('resource', resource);
    // Always offer account selection when adding or reconnecting a GitHub account.
    if (provider === 'github') url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }
  private basic(provider: ProviderName) { const p = this.config.providers[provider]; return `Basic ${Buffer.from(`${p.clientId}:${p.clientSecret}`).toString('base64')}`; }
  private async request(url: string, init: RequestInit, tokenRequest = false): Promise<any> {
    let response: Response;
    try { response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new ProviderError('provider_unavailable', 502); }
    let body: any;
    try { body = response.status === 204 ? {} : await response.json(); } catch { body = {}; }
    if (!response.ok || body.error) {
      const authError = tokenRequest && ['invalid_grant', 'bad_refresh_token', 'expired_token', 'invalid_refresh_token'].includes(body.error);
      const status = response.status === 429 ? 429 : (!tokenRequest && response.status === 401) || authError ? 401 : 502;
      throw new ProviderError(authError ? 'reauth_required' : 'provider_error', status, { upstream_status: response.status, ...(response.headers.get('retry-after') ? { retry_after: response.headers.get('retry-after') } : {}) });
    }
    return body;
  }
  private async token(provider: ProviderName, fields: Record<string, string>, old?: Credentials) {
    const app = this.config.providers[provider];
    const urls = { github: 'https://github.com/login/oauth/access_token' };
    const raw = definition(provider).auth === 'mcp' ? await this.mcp(provider).token(app.clientId, fields) : await this.request(urls.github, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({...fields,client_id:app.clientId,client_secret:app.clientSecret}).toString() }, true);
    if (typeof raw.access_token !== 'string' || !raw.access_token) throw new ProviderError('invalid_token_response');
    const expires = (seconds: unknown) => typeof seconds === 'number' && seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : undefined;
    const credential: Credentials = { accessToken: raw.access_token, refreshToken: raw.refresh_token || old?.refreshToken,
      expiresAt: expires(raw.expires_in), refreshExpiresAt: expires(raw.refresh_token_expires_in) || old?.refreshExpiresAt,
      scopes: Array.isArray(raw.scope) ? raw.scope : typeof raw.scope === 'string' ? raw.scope.split(/[ ,]+/).filter(Boolean) : old?.scopes };
    return { credential, raw };
  }
  async exchange(provider: ProviderName, code: string, verifier: string) {
    return this.token(provider, { grant_type: 'authorization_code', code, redirect_uri: this.callback(provider), code_verifier: verifier });
  }
  async refresh(provider: ProviderName, credential: Credentials) {
    if (!credential.refreshToken || (credential.refreshExpiresAt && Date.parse(credential.refreshExpiresAt) <= Date.now())) throw new ProviderError('reauth_required', 401);
    return (await this.token(provider, { grant_type: 'refresh_token', refresh_token: credential.refreshToken }, credential)).credential;
  }
  private api(provider: 'github', path: string, credential: Credentials, init: RequestInit = {}) {
    const bases = { github: 'https://api.github.com' };
    return this.request(bases[provider] + path, { ...init, headers: { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(provider === 'github' ? { 'X-GitHub-Api-Version': this.config.githubVersion, 'User-Agent': 'Connany/0.1' } : {}) } });
  }
  async identify(provider: ProviderName, credential: Credentials, raw: any): Promise<Identity> {
    const spec = definition(provider);
    if (spec.identify) return spec.identify(this.mcp(provider), credential, raw);
    if (provider === 'github') {
      const me = await this.api('github', '/user', credential);
      const installs = await this.api('github', '/user/installations?per_page=100', credential);
      if (!me.id || !me.login) throw new ProviderError('invalid_provider_identity');
      return { account_id: String(me.id), account_name: me.login, installation_count: installs.total_count, needs_installation: installs.total_count === 0, installations: (installs.installations || []).map((i: any) => ({ id: i.id, account: i.account?.login })) };
    }
    throw new ProviderError('invalid_provider_identity');
  }
  async revoke(provider: ProviderName, credential: Credentials) {
    if (definition(provider).auth === 'github_app') {
      await this.request(`https://api.github.com/applications/${encodeURIComponent(this.config.providers.github.clientId)}/token`, { method: 'DELETE', headers: { Authorization: this.basic(provider), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': this.config.githubVersion, 'User-Agent': 'Connany/0.1' }, body: JSON.stringify({ access_token: credential.accessToken }) });
    } else {
      await this.mcp(provider).revoke(this.config.providers[provider].clientId, credential);
    }
  }
  async execute(name: ActionName, input: any, credential: Credentials): Promise<unknown> {
    if (!Object.hasOwn(actions,name)) return this.mcp(name.split('.')[0] as ProviderName).call(name,input,credential);
    if (Object.hasOwn(githubActions, name)) {
      const action = githubActions[name as keyof typeof githubActions];
      const request = action.request(action.schema.parse(input));
      return this.api('github', request.path, credential, {method:request.method || 'GET', ...(request.body === undefined ? {} : {body:JSON.stringify(request.body)})});
    }
    switch (name) {
      case 'github.installations.list': return this.api('github', `/user/installations?per_page=${input.limit}&page=${input.page}`, credential);
      case 'github.repositories.list': return this.api('github', `/user/installations/${input.installation_id}/repositories?per_page=${input.limit}&page=${input.page}`, credential);
    }
  }
}

export function discoverActions(options: {provider?: ProviderName; query?: string; limit?: number; offset?: number; read_only?: boolean} = {}) {
  const words = (options.query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const matches = actionCatalog().filter(a => (!options.provider || a.provider === options.provider) && (options.read_only === undefined || a.read_only === options.read_only)).map(a => {
    const definition = actions[a.name as keyof typeof actions];
    const haystack = `${a.name} ${a.description} ${'keywords' in definition ? definition.keywords : ''}`.toLowerCase();
    return {action:a,score:words.reduce((score,word)=>score+(haystack.includes(word)?1:0),0)};
  }).filter(a=>!words.length || a.score>0).sort((a,b)=>b.score-a.score || a.action.name.localeCompare(b.action.name));
  const offset=options.offset || 0, limit=options.limit || 5;
  return {data:matches.slice(offset,offset+limit).map(a=>a.action),total:matches.length,next_offset:offset+limit<matches.length?offset+limit:null};
}
