import { HostedMcp } from './hosted-mcp.js';
import { genericIdentity } from './mcp-identity.js';
import { z } from 'zod';
import { githubRestTools } from './github-rest.js';
import { googleTools } from './google.js';
import type { Config } from '../config.js';
import { connector as definition, connectorNames, isCustomConnector, type AnyConnector } from './catalog.js';
import { guardFetch, systemLookup, type HostLookup } from './remote-mcp.js';
import { challenge } from '../crypto.js';
import { AppError, UpstreamError } from '../errors.js';

export interface Credentials { accessToken: string; refreshToken?: string; expiresAt?: string; refreshExpiresAt?: string; scopes?: string[] }
export interface Identity { account_id: string; account_name: string; workspace_id?: string; workspace_name?: string; [key: string]: unknown }
export type Fetcher = typeof fetch;
const pagination = { limit: z.number().int().min(1).max(100).default(20), cursor: z.string().max(500).optional() };
export const restTools = {
  ...githubRestTools,
  ...googleTools,
  'github.installations.list': { connector: 'github', description: 'List installations of this GitHub App accessible to the user.', schema: z.object({ page: z.number().int().min(1).max(10000).default(1), limit: pagination.limit }).strict() },
  'github.repositories.list': { connector: 'github', description: 'List repositories accessible to both the user and a GitHub App installation.', schema: z.object({ installation_id: z.number().int().positive(), page: z.number().int().min(1).max(10000).default(1), limit: pagination.limit }).strict() },
} as const;
export type ToolName = keyof typeof restTools | `${AnyConnector}.${string}`;
/** Dynamic MCP tool names: `<connector>.<upstream tool>`, built-in or custom (`mcp_…`). */
export const toolNamePattern = new RegExp(`^(${connectorNames.join('|')}|mcp_[a-z0-9]{10})\\.[a-zA-Z0-9_-]{1,128}$`);
export function restToolCatalog(connector?: AnyConnector) { return Object.entries(restTools).filter(([, a]) => !connector || a.connector === connector).map(([name, a]) => ({ name, connector: a.connector, description: a.description, read_only: 'read_only' in a ? a.read_only : true, required_permissions: 'required_permissions' in a ? a.required_permissions : ['Metadata: read'], input_schema: z.toJSONSchema(a.schema) })); }

export class ConnectorRuntime {
  constructor(public config: Config, private fetcher: Fetcher = fetch, private lookup: HostLookup = systemLookup) {}
  /** Custom servers are unvetted: their traffic may only reach public addresses. */
  mcp(connector: AnyConnector) { return new HostedMcp(isCustomConnector(connector) ? guardFetch(this.fetcher, this.lookup, this.config.customMcpAllowFakeIp) : this.fetcher,connector); }
  /** The base fetcher and host lookup, for discovering a custom server. */
  network() { return { fetcher: this.fetcher, lookup: this.lookup, allowFakeIp: !!this.config.customMcpAllowFakeIp }; }
  withConfig(config: Config) { return new ConnectorRuntime(config, this.fetcher, this.lookup); }
  enabled(connector: AnyConnector) { return !!this.config.connectors[connector]?.clientId; }
  private client(connector: AnyConnector) {
    const app = this.config.connectors[connector];
    if (!app) throw new AppError('connector_not_configured', 'This connector is not configured.', 503);
    return app;
  }
  callback(connector: AnyConnector) { return `${this.config.publicBaseUrl}/oauth/${connector}/callback`; }
  installUrl() { return `https://github.com/apps/${this.config.githubAppSlug}/installations/new`; }
  authorizeUrl(connector: AnyConnector, state: string, verifier: string) {
    if (!this.enabled(connector)) throw new AppError('connector_not_configured', 'This connector is not configured.', 503);
    const spec = definition(connector);
    const oauth = spec.auth === 'mcp' ? undefined : spec.oauth!;
    const url = new URL(oauth ? oauth.authorize : this.mcp(connector).oauthUrl('authorize')!);
    url.search = new URLSearchParams({ client_id: this.client(connector).clientId, redirect_uri: this.callback(connector), response_type: 'code', state }).toString();
    { url.searchParams.set('code_challenge', challenge(verifier)); url.searchParams.set('code_challenge_method', 'S256'); }
    const scope = oauth ? oauth.scope : spec.mcp!.scope;
    if (scope) url.searchParams.set('scope', scope);
    for (const [key, value] of Object.entries((oauth ?? spec.mcp!).authorizeParams || {})) url.searchParams.set(key, value);
    const resource = oauth ? undefined : this.mcp(connector).resource;
    if (resource) url.searchParams.set('resource', resource);
    return url.toString();
  }
  private mcpClient(connector: AnyConnector) { const app = this.client(connector); return { clientId: app.clientId, clientSecret: app.clientSecret, authMethod: app.authMethod || 'none' } as const; }
  private basic(connector: AnyConnector) { const p = this.client(connector); return `Basic ${Buffer.from(`${p.clientId}:${p.clientSecret}`).toString('base64')}`; }
  private async request(url: string, init: RequestInit, tokenRequest = false): Promise<any> {
    let response: Response;
    try { response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new UpstreamError('upstream_unavailable', 502); }
    let body: any;
    try { body = response.status === 204 ? {} : await response.json(); } catch { body = {}; }
    if (!response.ok || body.error) {
      const authError = tokenRequest && ['invalid_grant', 'bad_refresh_token', 'expired_token', 'invalid_refresh_token'].includes(body.error);
      const status = response.status === 429 ? 429 : (!tokenRequest && response.status === 401) || authError ? 401 : 502;
      // Google API errors explain themselves (API not enabled, no access to the property, unknown metric).
      const message = typeof body.error?.message === 'string' ? body.error.message.slice(0, 500) : undefined;
      throw new UpstreamError(authError ? 'reauth_required' : 'upstream_error', status, { upstream_status: response.status, ...(message ? { upstream_message: message } : {}), ...(response.headers.get('retry-after') ? { retry_after: response.headers.get('retry-after') } : {}) });
    }
    return body;
  }
  private async token(connector: AnyConnector, fields: Record<string, string>, old?: Credentials) {
    const app = this.client(connector);
    const spec = definition(connector);
    const raw = spec.auth === 'mcp' ? await this.mcp(connector).token(this.mcpClient(connector), fields) : await this.request(spec.oauth!.token, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({...fields,client_id:app.clientId,client_secret:app.clientSecret}).toString() }, true);
    if (typeof raw.access_token !== 'string' || !raw.access_token) throw new UpstreamError('invalid_token_response');
    const expires = (seconds: unknown) => typeof seconds === 'number' && seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : undefined;
    const credential: Credentials = { accessToken: raw.access_token, refreshToken: raw.refresh_token || old?.refreshToken,
      expiresAt: expires(raw.expires_in), refreshExpiresAt: expires(raw.refresh_token_expires_in) || old?.refreshExpiresAt,
      scopes: Array.isArray(raw.scope) ? raw.scope : typeof raw.scope === 'string' ? raw.scope.split(/[ ,]+/).filter(Boolean) : old?.scopes };
    return { credential, raw };
  }
  async exchange(connector: AnyConnector, code: string, verifier: string) {
    return this.token(connector, { grant_type: 'authorization_code', code, redirect_uri: this.callback(connector), code_verifier: verifier });
  }
  async refresh(connector: AnyConnector, credential: Credentials) {
    if (!credential.refreshToken || (credential.refreshExpiresAt && Date.parse(credential.refreshExpiresAt) <= Date.now())) throw new UpstreamError('reauth_required', 401);
    return (await this.token(connector, { grant_type: 'refresh_token', refresh_token: credential.refreshToken }, credential)).credential;
  }
  private api(connector: 'github', path: string, credential: Credentials, init: RequestInit = {}) {
    const bases = { github: 'https://api.github.com' };
    return this.request(bases[connector] + path, { ...init, headers: { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(connector === 'github' ? { 'X-GitHub-Api-Version': this.config.githubVersion, 'User-Agent': 'Connany/0.1' } : {}) } });
  }
  async identify(connector: AnyConnector, credential: Credentials, raw: any): Promise<Identity> {
    const spec = definition(connector);
    if (spec.identify) return spec.identify(this.mcp(connector), credential, raw);
    if (spec.auth === 'mcp') return genericIdentity(this.mcp(connector), credential, raw, spec.label);
    if (spec.auth === 'oauth') {
      if (!spec.oauth?.userinfo) throw new UpstreamError('invalid_upstream_identity');
      const me = await this.request(spec.oauth.userinfo, { headers: { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json' } });
      const accountId = me.sub ?? me.id;
      if ((typeof accountId !== 'string' && typeof accountId !== 'number') || accountId === '') throw new UpstreamError('invalid_upstream_identity');
      return { account_id: String(accountId), account_name: String(me.email || me.name || `${spec.label} account`), ...(typeof me.email === 'string' ? { email: me.email } : {}) };
    }
    if (spec.auth === 'github_app') {
      const me = await this.api('github', '/user', credential);
      const installs = await this.api('github', '/user/installations?per_page=100', credential);
      if (!me.id || !me.login) throw new UpstreamError('invalid_upstream_identity');
      return { account_id: String(me.id), account_name: me.login, installation_count: installs.total_count, needs_installation: installs.total_count === 0, installations: (installs.installations || []).map((i: any) => ({ id: i.id, account: i.account?.login })) };
    }
    throw new UpstreamError('invalid_upstream_identity');
  }
  async revoke(connector: AnyConnector, credential: Credentials) {
    const spec = definition(connector);
    if (spec.auth === 'oauth') {
      // Google documents only the token parameter; revoking the refresh token also ends its access tokens.
      if (spec.oauth?.revoke) await this.request(spec.oauth.revoke, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: credential.refreshToken || credential.accessToken }).toString() });
    } else if (spec.auth === 'github_app') {
      await this.request(`https://api.github.com/applications/${encodeURIComponent(this.config.connectors.github.clientId)}/token`, { method: 'DELETE', headers: { Authorization: this.basic(connector), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': this.config.githubVersion, 'User-Agent': 'Connany/0.1' }, body: JSON.stringify({ access_token: credential.accessToken }) });
    } else {
      await this.mcp(connector).revoke(this.mcpClient(connector), credential);
    }
  }
  /** Tool catalog: built in for REST connectors, otherwise the upstream MCP tool list. */
  async tools(connector: AnyConnector, credential: Credentials) {
    return definition(connector).rest ? restToolCatalog(connector) : this.mcp(connector).tools(credential);
  }
  /** `known`: the tool is in the cached catalog, so the upstream list is not fetched to check it. */
  async execute(name: ToolName, input: any, credential: Credentials, known = false): Promise<unknown> {
    if (!Object.hasOwn(restTools,name)) return this.mcp(name.split('.')[0] as AnyConnector).call(name,input,credential,known);
    if (Object.hasOwn(googleTools, name)) {
      const operation = googleTools[name as keyof typeof googleTools];
      const parsed = operation.schema.parse(input);
      const request = operation.request(parsed);
      const raw = await this.request(request.url, { method: request.method || 'GET', headers: { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json', ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
      return operation.response ? operation.response(raw, parsed) : raw;
    }
    if (Object.hasOwn(githubRestTools, name)) {
      const action = githubRestTools[name as keyof typeof githubRestTools];
      const request = action.request(action.schema.parse(input));
      return this.api('github', request.path, credential, {method:request.method || 'GET', ...(request.body === undefined ? {} : {body:JSON.stringify(request.body)})});
    }
    switch (name) {
      case 'github.installations.list': return this.api('github', `/user/installations?per_page=${input.limit}&page=${input.page}`, credential);
      case 'github.repositories.list': return this.api('github', `/user/installations/${input.installation_id}/repositories?per_page=${input.limit}&page=${input.page}`, credential);
    }
  }
}
