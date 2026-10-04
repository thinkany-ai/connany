import { createHash } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { hash, id, randomToken } from '../crypto.js';
import { transaction } from '../db.js';
import { returnUrlSchema } from '../projects.js';
import { ensureWorkspace } from '../workspaces.js';

/**
 * Connany as an OAuth 2.1 authorization server for MCP clients (Claude Code, Codex, ...):
 * metadata (RFC 8414 / RFC 9728), dynamic registration of public clients (RFC 7591),
 * authorization code + PKCE S256, rotating refresh tokens and revocation (RFC 7009).
 * The user signs in to the console and approves the client on a consent page.
 */
const codeTtl = 600;
export const accessTtl = 3600;
const refreshTtl = 30 * 24 * 3600;
export const mcpScope = 'connany';

/** An OAuth error response: `{error, error_description}` (RFC 6749 §5.2). */
export class OAuthError extends Error {
  constructor(public error: string, public description: string, public status = 400) { super(description); }
}
export interface AuthorizeRequest { client_id: string; redirect_uri: string; response_type: string; code_challenge: string; code_challenge_method: string; state?: string; scope?: string; resource?: string }
export interface OAuthUser { id: string; email: string; role: string; workspace_id: string; client_name: string }

const authorizeRequest = z.object({
  client_id: z.string().min(1).max(200), redirect_uri: z.string().min(1).max(2048),
  response_type: z.string().max(50).default(''), code_challenge: z.string().max(200).default(''), code_challenge_method: z.string().max(20).default(''),
  state: z.string().max(2000).optional(), scope: z.string().max(500).optional(), resource: z.string().max(2048).optional(),
});
const registration = z.object({ client_name: z.string().trim().max(200).optional(), redirect_uris: z.array(returnUrlSchema).min(1).max(10) }).passthrough();
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Exact match, except that loopback redirect URIs may use any port (RFC 8252 §7.3). */
function sameRedirect(registered: string, requested: string) {
  if (registered === requested) return true;
  try {
    const a = new URL(registered), b = new URL(requested);
    return a.protocol === 'http:' && b.protocol === 'http:' && loopback.has(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}
const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');

export class OAuthServer {
  constructor(private pool: pg.Pool, private base: string) {}
  get resource() { return `${this.base}/mcp`; }
  protectedResource() {
    return { resource: this.resource, authorization_servers: [this.base], scopes_supported: [mcpScope], bearer_methods_supported: ['header'], resource_name: 'Connany' };
  }
  metadata() {
    return {
      issuer: this.base,
      authorization_endpoint: `${this.base}/oauth2/authorize`, token_endpoint: `${this.base}/oauth2/token`,
      registration_endpoint: `${this.base}/oauth2/register`, revocation_endpoint: `${this.base}/oauth2/revoke`,
      scopes_supported: [mcpScope], response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'],
    };
  }
  async register(body: unknown) {
    const parsed = registration.safeParse(body);
    if (!parsed.success) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be HTTPS, loopback HTTP or an app scheme, without credentials or fragment.');
    const clientId = id('mcpc');
    const name = parsed.data.client_name || 'MCP client';
    const { rows } = await this.pool.query('INSERT INTO oauth_clients(id,client_name,redirect_uris) VALUES($1,$2,$3) RETURNING created_at', [clientId, name, JSON.stringify(parsed.data.redirect_uris)]);
    // Only public clients: whatever authentication was requested, the client uses PKCE without a secret.
    return { client_id: clientId, client_id_issued_at: Math.floor(rows[0].created_at.getTime() / 1000), client_name: name, redirect_uris: parsed.data.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: mcpScope };
  }
  /**
   * Validate an authorization request. Without a known client and a registered redirect URI the
   * error is shown to the user (`page`); other errors are returned to the client (`redirect`).
   */
  async validate(query: Record<string, string | undefined>): Promise<{ request: AuthorizeRequest; client: { id: string; client_name: string } } | { page: string } | { redirect: string }> {
    const parsed = authorizeRequest.safeParse(query);
    if (!parsed.success) return { page: '授权请求缺少 client_id 或 redirect_uri。' };
    const request = parsed.data;
    const client = (await this.pool.query('SELECT id,client_name,redirect_uris FROM oauth_clients WHERE id=$1', [request.client_id])).rows[0];
    if (!client) return { page: '未知的客户端，请在 agent 中重新连接 Connany。' };
    if (!(client.redirect_uris as string[]).some(uri => sameRedirect(uri, request.redirect_uri))) return { page: '回调地址与客户端注册的不一致。' };
    const fail = (error: string, description: string) => ({ redirect: this.redirect(request, { error, error_description: description }) });
    if (request.response_type !== 'code') return fail('unsupported_response_type', 'Only response_type=code is supported.');
    if (request.code_challenge_method !== 'S256' || !/^[A-Za-z0-9._~-]{43,128}$/.test(request.code_challenge)) return fail('invalid_request', 'PKCE with code_challenge_method=S256 is required.');
    if (request.resource && ![this.resource, this.base, `${this.base}/`].includes(request.resource)) return fail('invalid_target', `Use resource=${this.resource}.`);
    return { request, client: { id: client.id, client_name: client.client_name } };
  }
  redirect(request: Pick<AuthorizeRequest, 'redirect_uri' | 'state'>, params: Record<string, string>) {
    const url = new URL(request.redirect_uri);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (request.state) url.searchParams.set('state', request.state);
    // RFC 9207: tell the client which authorization server answered.
    url.searchParams.set('iss', this.base);
    return url.toString();
  }
  /** The user approved: issue a single-use code bound to the client, redirect URI and PKCE challenge. */
  async approve(user: { id: string }, request: AuthorizeRequest) {
    const code = randomToken();
    await this.pool.query('INSERT INTO oauth_grants(id,client_id,user_id,redirect_uri,code_hash,code_challenge,code_expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+make_interval(secs=>$7))',
      [id('grant'), request.client_id, user.id, request.redirect_uri, hash(code), request.code_challenge, codeTtl]);
    return this.redirect(request, { code });
  }
  async token(fields: Record<string, string | undefined>) {
    const clientId = fields.client_id;
    if (!clientId) throw new OAuthError('invalid_client', 'client_id is required.', 401);
    if (fields.grant_type === 'authorization_code') {
      if (!fields.code || !fields.code_verifier || !fields.redirect_uri) throw new OAuthError('invalid_request', 'code, code_verifier and redirect_uri are required.');
      const result = await transaction(this.pool, async db => {
        const grant = (await db.query('SELECT * FROM oauth_grants WHERE code_hash=$1 FOR UPDATE', [hash(fields.code!)])).rows[0];
        if (!grant || grant.revoked_at || grant.code_expires_at < new Date()) throw new OAuthError('invalid_grant', 'The authorization code is invalid or expired.');
        // A code used twice means it leaked: revoke everything issued from it (committed below).
        if (grant.access_hash) { await db.query('UPDATE oauth_grants SET revoked_at=now() WHERE id=$1', [grant.id]); return null; }
        if (grant.client_id !== clientId || grant.redirect_uri !== fields.redirect_uri) throw new OAuthError('invalid_grant', 'The code was issued to another client or redirect URI.');
        if (s256(fields.code_verifier!) !== grant.code_challenge) throw new OAuthError('invalid_grant', 'PKCE verification failed.');
        return this.issue(db, grant.id);
      });
      if (!result) throw new OAuthError('invalid_grant', 'The authorization code was already used.');
      return result;
    }
    if (fields.grant_type === 'refresh_token') {
      if (!fields.refresh_token) throw new OAuthError('invalid_request', 'refresh_token is required.');
      return transaction(this.pool, async db => {
        const grant = (await db.query('SELECT * FROM oauth_grants WHERE refresh_hash=$1 FOR UPDATE', [hash(fields.refresh_token!)])).rows[0];
        if (!grant || grant.revoked_at || grant.refresh_expires_at < new Date() || grant.client_id !== clientId) throw new OAuthError('invalid_grant', 'The refresh token is invalid, expired or revoked.');
        return this.issue(db, grant.id);
      });
    }
    throw new OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.');
  }
  /** New access token and rotated refresh token; the previous pair stops working. */
  private async issue(db: pg.PoolClient, grantId: string) {
    const access = `cny_at_${randomToken()}`; const refresh = `cny_rt_${randomToken()}`;
    await db.query(`UPDATE oauth_grants SET access_hash=$1,access_expires_at=now()+make_interval(secs=>$2),refresh_hash=$3,refresh_expires_at=now()+make_interval(secs=>$4) WHERE id=$5`,
      [hash(access), accessTtl, hash(refresh), refreshTtl, grantId]);
    return { access_token: access, token_type: 'Bearer', expires_in: accessTtl, refresh_token: refresh, scope: mcpScope };
  }
  /** RFC 7009: unknown tokens are not an error. */
  async revoke(token: string) {
    await this.pool.query('UPDATE oauth_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE access_hash=$1 OR refresh_hash=$1', [hash(token)]);
  }
  async verify(token: string): Promise<OAuthUser | null> {
    if (!token.startsWith('cny_at_') || token.length > 100) return null;
    const { rows } = await this.pool.query(`SELECT g.id AS grant_id,g.last_used_at,u.id,u.email,u.role,c.client_name FROM oauth_grants g JOIN admin_users u ON u.id=g.user_id JOIN oauth_clients c ON c.id=g.client_id
      WHERE g.access_hash=$1 AND g.access_expires_at>now() AND g.revoked_at IS NULL`, [hash(token)]);
    const row = rows[0];
    if (!row) return null;
    if (!row.last_used_at || Date.now() - row.last_used_at.getTime() > 60000) await this.pool.query('UPDATE oauth_grants SET last_used_at=now() WHERE id=$1', [row.grant_id]);
    return { id: row.id, email: row.email, role: row.role, client_name: row.client_name, workspace_id: await ensureWorkspace(this.pool, row) };
  }
  /** Clients the user authorized whose tokens can still be used or refreshed. */
  async grants(userId: string) {
    const { rows } = await this.pool.query(`SELECT g.id,c.client_name,g.redirect_uri,g.created_at,g.last_used_at FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id
      WHERE g.user_id=$1 AND g.revoked_at IS NULL AND g.refresh_expires_at>now() ORDER BY g.created_at DESC`, [userId]);
    return rows as { id: string; client_name: string; redirect_uri: string; created_at: Date; last_used_at: Date | null }[];
  }
  async revokeGrant(userId: string, grantId: string) {
    const { rowCount } = await this.pool.query('UPDATE oauth_grants SET revoked_at=now() WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL', [grantId, userId]);
    return !!rowCount;
  }
}
