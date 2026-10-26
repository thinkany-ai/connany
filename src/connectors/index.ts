import { HostedMcp } from './hosted-mcp.js';
import { genericIdentity } from './mcp-identity.js';
import { z } from 'zod';
import { githubRestTools } from './github-rest.js';
import { googleTools } from './google.js';
import { googleWorkspaceTools } from './google-workspace.js';
import { microsoft365Tools } from './microsoft-365.js';
import { outlookTools } from './outlook.js';
import { gmailTools } from './gmail.js';
import { zohoMailTools } from './zoho-mail.js';
import type { RestOperation, RestRequest } from './rest.js';
import type { Config } from '../config.js';
import { connector as definition, connectorNames, isCustomConnector, type AnyConnector } from './catalog.js';
import { guardFetch, systemLookup, type HostLookup } from './remote-mcp.js';
import { challenge } from '../crypto.js';
import { AppError, UpstreamError } from '../errors.js';

export interface Credentials {
  accessToken: string; refreshToken?: string; expiresAt?: string; refreshExpiresAt?: string; scopes?: string[];
  /** Regional accounts server the account authorized with (Zoho data centers); see OAuthSpec.servers. */
  server?: string;
}
export interface Identity { account_id: string; account_name: string; workspace_id?: string; workspace_name?: string; [key: string]: unknown }
export type Fetcher = typeof fetch;
const pagination = { limit: z.number().int().min(1).max(100).default(20), cursor: z.string().max(500).optional() };
/** Tools Connany implements against REST APIs, for connectors with `rest` in the catalog. */
const restOperations: Record<string, RestOperation> = { ...googleTools, ...gmailTools, ...zohoMailTools, ...googleWorkspaceTools, ...outlookTools, ...microsoft365Tools };
export const restTools = {
  ...microsoft365Tools,
  ...googleWorkspaceTools,
  ...outlookTools,
  ...githubRestTools,
  ...googleTools,
  ...gmailTools,
  ...zohoMailTools,
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
    const resource = oauth ? oauth.resource : this.mcp(connector).resource;
    if (resource) url.searchParams.set('resource', resource);
    return url.toString();
  }
  /** The endpoint at the user's regional accounts server, when the connector has regions; otherwise as configured. */
  private regional(connector: AnyConnector, url: string, server?: string) {
    const servers = definition(connector).oauth?.servers;
    if (!servers || !server) return url;
    if (!servers.includes(server)) throw new UpstreamError('invalid_accounts_server');
    return server + new URL(url).pathname;
  }
  private mcpClient(connector: AnyConnector) { const app = this.client(connector); return { clientId: app.clientId, clientSecret: app.clientSecret, authMethod: app.authMethod || 'none' } as const; }
  private basic(connector: AnyConnector) { const p = this.client(connector); return `Basic ${Buffer.from(`${p.clientId}:${p.clientSecret}`).toString('base64')}`; }
  private async request(url: string, init: RequestInit, tokenRequest = false): Promise<any> {
    let response: Response;
    try { response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new UpstreamError('upstream_unavailable', 502); }
    let body: any;
    try { body = response.status === 204 ? {} : await response.json(); } catch { body = {}; }
    if (!response.ok || body.error || body.ok === false) {
      // Zoho answers a revoked or unknown refresh token with invalid_code.
      const authError = tokenRequest && ['invalid_grant', 'bad_refresh_token', 'expired_token', 'invalid_refresh_token', 'invalid_code'].includes(body.error);
      const status = response.status === 429 ? 429 : (!tokenRequest && response.status === 401) || authError ? 401 : 502;
      // Google and Zoho API errors explain themselves (API not enabled, no access to the property, unknown metric, invalid folder).
      const explanation = [body.error?.message, body.data?.moreInfo, body.status?.description].find(v => typeof v === 'string' && v);
      const message = explanation ? explanation.slice(0, 500) : undefined;
      throw new UpstreamError(authError ? 'reauth_required' : 'upstream_error', status, { upstream_status: response.status, ...(message ? { upstream_message: message } : {}), ...(response.headers.get('retry-after') ? { retry_after: response.headers.get('retry-after') } : {}) });
    }
    return body;
  }
  private async token(connector: AnyConnector, fields: Record<string, string>, old?: Credentials, server = old?.server) {
    const app = this.client(connector);
    const spec = definition(connector);
    const raw = spec.auth === 'mcp' ? await this.mcp(connector).token(this.mcpClient(connector), fields) : await this.request(this.regional(connector, spec.oauth!.token, server), { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({...fields,...(spec.oauth?.resource ? {resource:spec.oauth.resource} : {}),client_id:app.clientId,client_secret:app.clientSecret}).toString() }, true);
    if (typeof raw.access_token !== 'string' || !raw.access_token) throw new UpstreamError('invalid_token_response');
    const expires = (seconds: unknown) => typeof seconds === 'number' && seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : undefined;
    const credential: Credentials = { accessToken: raw.access_token, refreshToken: raw.refresh_token || old?.refreshToken,
      expiresAt: expires(raw.expires_in), refreshExpiresAt: expires(raw.refresh_token_expires_in) || old?.refreshExpiresAt,
      scopes: connector === 'slack' && typeof raw.authed_user?.scope === 'string' ? raw.authed_user.scope.split(/[ ,]+/).filter(Boolean) : Array.isArray(raw.scope) ? raw.scope : typeof raw.scope === 'string' ? raw.scope.split(/[ ,]+/).filter(Boolean) : old?.scopes,
      ...(server && spec.oauth?.servers ? { server } : {}) };
    return { credential, raw };
  }
  /** `server`: the callback's `accounts-server` parameter, for connectors with regional accounts servers. */
  async exchange(connector: AnyConnector, code: string, verifier: string, server?: string) {
    return this.token(connector, { grant_type: 'authorization_code', code, redirect_uri: this.callback(connector), code_verifier: verifier }, undefined, definition(connector).oauth?.servers ? server : undefined);
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
      const me = await this.request(this.regional(connector, spec.oauth.userinfo, credential.server), { headers: { Authorization: `${spec.oauth.tokenType || 'Bearer'} ${credential.accessToken}`, Accept: 'application/json' } });
      const profile = spec.oauth.profile ? spec.oauth.profile(me) : { id: me.sub ?? me.id, email: me.email, name: me.name };
      const accountId = profile.id;
      if ((typeof accountId !== 'string' && typeof accountId !== 'number') || accountId === '') throw new UpstreamError('invalid_upstream_identity');
      return { account_id: String(accountId), account_name: String(profile.email || profile.name || `${spec.label} account`), ...(typeof profile.email === 'string' ? { email: profile.email } : {}) };
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
      // Google and Zoho document only the token parameter; revoking the refresh token also ends its access tokens.
      if (spec.oauth?.revoke) {
        const token = new URLSearchParams({ token: spec.oauth.revokeToken === 'access' ? credential.accessToken : credential.refreshToken || credential.accessToken }).toString();
        const url = this.regional(connector, spec.oauth.revoke, credential.server);
        await this.request(spec.oauth.revokeInQuery ? `${url}?${token}` : url, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, ...(spec.oauth.revokeInQuery ? {} : { body: token }) });
      }
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
    if (Object.hasOwn(restOperations, name)) {
      const operation = restOperations[name];
      const parsed = operation.schema.parse(input);
      const authorization = `${definition(operation.connector).oauth?.tokenType || 'Bearer'} ${credential.accessToken}`;
      const call = (request: RestRequest) => this.request(request.url, { method: request.method || 'GET', headers: { Authorization: authorization, Accept: 'application/json', ...(request.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }) });
      const context = { server: credential.server, call };
      if (operation.run) return operation.run(parsed, context);
      const raw = await call(operation.request!(parsed, context));
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
