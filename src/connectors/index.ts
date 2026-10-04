import { HostedMcp } from './hosted-mcp.js';
import { genericIdentity } from './mcp-identity.js';
import { z } from 'zod';
import { githubRestTools } from './github-rest.js';
import type { Config } from '../config.js';
import { connector as definition, connectorNames, type ConnectorName } from './catalog.js';
import { challenge } from '../crypto.js';
import { AppError, UpstreamError } from '../errors.js';

export interface Credentials { accessToken: string; refreshToken?: string; expiresAt?: string; refreshExpiresAt?: string; scopes?: string[] }
export interface Identity { account_id: string; account_name: string; workspace_id?: string; workspace_name?: string; [key: string]: unknown }
export type Fetcher = typeof fetch;
const pagination = { limit: z.number().int().min(1).max(100).default(20), cursor: z.string().max(500).optional() };
export const restTools = {
  ...githubRestTools,
  'github.installations.list': { connector: 'github', description: 'List installations of this GitHub App accessible to the user.', schema: z.object({ page: z.number().int().min(1).max(10000).default(1), limit: pagination.limit }).strict() },
  'github.repositories.list': { connector: 'github', description: 'List repositories accessible to both the user and a GitHub App installation.', schema: z.object({ installation_id: z.number().int().positive(), page: z.number().int().min(1).max(10000).default(1), limit: pagination.limit }).strict() },
} as const;
export type ToolName = keyof typeof restTools | `${ConnectorName}.${string}`;
/** Dynamic MCP tool names: `<connector>.<upstream tool>`. */
export const toolNamePattern = new RegExp(`^(${connectorNames.join('|')})\\.[a-zA-Z0-9_-]{1,128}$`);
export function restToolCatalog() { return Object.entries(restTools).map(([name, a]) => ({ name, connector: a.connector, description: a.description, read_only: 'read_only' in a ? a.read_only : true, required_permissions: 'required_permissions' in a ? a.required_permissions : ['Metadata: read'], input_schema: z.toJSONSchema(a.schema) })); }

export class ConnectorRuntime {
  constructor(public config: Config, private fetcher: Fetcher = fetch) {}
  mcp(connector: ConnectorName) { return new HostedMcp(this.fetcher,connector); }
  withConfig(config: Config) { return new ConnectorRuntime(config, this.fetcher); }
  enabled(connector: ConnectorName) { return !!this.config.connectors[connector].clientId; }
  callback(connector: ConnectorName) { return `${this.config.publicBaseUrl}/oauth/${connector}/callback`; }
  installUrl() { return `https://github.com/apps/${this.config.githubAppSlug}/installations/new`; }
  authorizeUrl(connector: ConnectorName, state: string, verifier: string) {
    if (!this.enabled(connector)) throw new AppError('connector_not_configured', 'This connector is not configured.', 503);
    const spec = definition(connector);
    const url = new URL(spec.auth === 'mcp' ? this.mcp(connector).oauthUrl('authorize')! : 'https://github.com/login/oauth/authorize');
    url.search = new URLSearchParams({ client_id: this.config.connectors[connector].clientId, redirect_uri: this.callback(connector), response_type: 'code', state }).toString();
    { url.searchParams.set('code_challenge', challenge(verifier)); url.searchParams.set('code_challenge_method', 'S256'); }
    if (spec.auth === 'mcp' && spec.mcp.scope) url.searchParams.set('scope', spec.mcp.scope);
    for (const [key, value] of Object.entries(spec.mcp.authorizeParams || {})) if (spec.auth === 'mcp') url.searchParams.set(key, value);
    const resource = spec.auth === 'mcp' ? this.mcp(connector).resource : undefined;
    if (resource) url.searchParams.set('resource', resource);
    // Always offer account selection when adding or reconnecting a GitHub account.
    if (connector === 'github') url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }
  private mcpClient(connector: ConnectorName) { const app = this.config.connectors[connector]; return { clientId: app.clientId, clientSecret: app.clientSecret, authMethod: app.authMethod || 'none' } as const; }
  private basic(connector: ConnectorName) { const p = this.config.connectors[connector]; return `Basic ${Buffer.from(`${p.clientId}:${p.clientSecret}`).toString('base64')}`; }
  private async request(url: string, init: RequestInit, tokenRequest = false): Promise<any> {
    let response: Response;
    try { response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { throw new UpstreamError('upstream_unavailable', 502); }
    let body: any;
    try { body = response.status === 204 ? {} : await response.json(); } catch { body = {}; }
    if (!response.ok || body.error) {
      const authError = tokenRequest && ['invalid_grant', 'bad_refresh_token', 'expired_token', 'invalid_refresh_token'].includes(body.error);
      const status = response.status === 429 ? 429 : (!tokenRequest && response.status === 401) || authError ? 401 : 502;
      throw new UpstreamError(authError ? 'reauth_required' : 'upstream_error', status, { upstream_status: response.status, ...(response.headers.get('retry-after') ? { retry_after: response.headers.get('retry-after') } : {}) });
    }
    return body;
  }
  private async token(connector: ConnectorName, fields: Record<string, string>, old?: Credentials) {
    const app = this.config.connectors[connector];
    const urls = { github: 'https://github.com/login/oauth/access_token' };
    const raw = definition(connector).auth === 'mcp' ? await this.mcp(connector).token(this.mcpClient(connector), fields) : await this.request(urls.github, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({...fields,client_id:app.clientId,client_secret:app.clientSecret}).toString() }, true);
    if (typeof raw.access_token !== 'string' || !raw.access_token) throw new UpstreamError('invalid_token_response');
    const expires = (seconds: unknown) => typeof seconds === 'number' && seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : undefined;
    const credential: Credentials = { accessToken: raw.access_token, refreshToken: raw.refresh_token || old?.refreshToken,
      expiresAt: expires(raw.expires_in), refreshExpiresAt: expires(raw.refresh_token_expires_in) || old?.refreshExpiresAt,
      scopes: Array.isArray(raw.scope) ? raw.scope : typeof raw.scope === 'string' ? raw.scope.split(/[ ,]+/).filter(Boolean) : old?.scopes };
    return { credential, raw };
  }
  async exchange(connector: ConnectorName, code: string, verifier: string) {
    return this.token(connector, { grant_type: 'authorization_code', code, redirect_uri: this.callback(connector), code_verifier: verifier });
  }
  async refresh(connector: ConnectorName, credential: Credentials) {
    if (!credential.refreshToken || (credential.refreshExpiresAt && Date.parse(credential.refreshExpiresAt) <= Date.now())) throw new UpstreamError('reauth_required', 401);
    return (await this.token(connector, { grant_type: 'refresh_token', refresh_token: credential.refreshToken }, credential)).credential;
  }
  private api(connector: 'github', path: string, credential: Credentials, init: RequestInit = {}) {
    const bases = { github: 'https://api.github.com' };
    return this.request(bases[connector] + path, { ...init, headers: { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json', ...(connector === 'github' ? { 'X-GitHub-Api-Version': this.config.githubVersion, 'User-Agent': 'Connany/0.1' } : {}) } });
  }
  async identify(connector: ConnectorName, credential: Credentials, raw: any): Promise<Identity> {
    const spec = definition(connector);
    if (spec.identify) return spec.identify(this.mcp(connector), credential, raw);
    if (spec.auth === 'mcp') return genericIdentity(this.mcp(connector), credential, raw, spec.label);
    if (connector === 'github') {
      const me = await this.api('github', '/user', credential);
      const installs = await this.api('github', '/user/installations?per_page=100', credential);
      if (!me.id || !me.login) throw new UpstreamError('invalid_upstream_identity');
      return { account_id: String(me.id), account_name: me.login, installation_count: installs.total_count, needs_installation: installs.total_count === 0, installations: (installs.installations || []).map((i: any) => ({ id: i.id, account: i.account?.login })) };
    }
    throw new UpstreamError('invalid_upstream_identity');
  }
  async revoke(connector: ConnectorName, credential: Credentials) {
    if (definition(connector).auth === 'github_app') {
      await this.request(`https://api.github.com/applications/${encodeURIComponent(this.config.connectors.github.clientId)}/token`, { method: 'DELETE', headers: { Authorization: this.basic(connector), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': this.config.githubVersion, 'User-Agent': 'Connany/0.1' }, body: JSON.stringify({ access_token: credential.accessToken }) });
    } else {
      await this.mcp(connector).revoke(this.mcpClient(connector), credential);
    }
  }
  /** `known`: the tool is in the cached catalog, so the upstream list is not fetched to check it. */
  async execute(name: ToolName, input: any, credential: Credentials, known = false): Promise<unknown> {
    if (!Object.hasOwn(restTools,name)) return this.mcp(name.split('.')[0] as ConnectorName).call(name,input,credential,known);
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
