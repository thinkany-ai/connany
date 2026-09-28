import type pg from 'pg';
import { ProviderStore } from './provider-store.js';
import type { ProviderName } from './config.js';
import { Vault, hash, id, randomToken } from './crypto.js';
import { event, transaction } from './db.js';
import { AppError, ProviderError } from './errors.js';
import { actions, mcpActionPattern, type ActionName, type Credentials, Providers } from './providers/index.js';
import { provider as providerSpec } from './providers/catalog.js';

export interface Project { id: string; name: string; return_urls: string[] }
export interface Connection {
  id: string; project_id: string; external_user_id: string; provider: ProviderName; provider_app_id: string | null;
  status: string; identity: Record<string, any>; credential_ciphertext: string | null;
  expires_at: Date | null; revocation_status: string; created_at: Date; updated_at: Date;
}
export function publicConnection(c: Connection) {
  return { id: c.id, external_user_id: c.external_user_id, provider: c.provider, status: c.status,
    identity: c.identity, expires_at: c.expires_at, revocation_status: c.revocation_status, created_at: c.created_at, updated_at: c.updated_at };
}
export function publicSession(s: any) {
  return { id: s.id, provider: s.provider, external_user_id: s.external_user_id,
    status: ['pending','authorizing','processing'].includes(s.status) && new Date(s.expires_at).getTime() < Date.now() ? 'expired' : s.status,
    connection_id: s.connection_id, error_code: s.error_code, expires_at: s.expires_at };
}
export class Service {
  public providerStore: ProviderStore;
  private initialization?: Promise<void>;
  constructor(public pool: pg.Pool, public providers: Providers, public vault: Vault) { this.providerStore = new ProviderStore(pool, providers, vault); }
  initialize() {
    return this.initialization ||= this.providerStore.bootstrap().catch(error => { this.initialization = undefined; throw error; });
  }
  context(c: Pick<Connection, 'project_id' | 'provider' | 'id'>) { return `${c.project_id}:${c.provider}:${c.id}`; }
  async authenticate(key: string): Promise<Project> {
    if (!key || key.length > 200) throw new AppError('unauthorized', 'A valid project API key is required.', 401);
    const result = await this.pool.query('SELECT id,name,return_urls FROM projects WHERE api_key_hash=$1 AND enabled=true', [hash(key)]);
    if (!result.rows[0]) throw new AppError('unauthorized', 'A valid project API key is required.', 401);
    const project = result.rows[0];
    const rate = await this.pool.query(`INSERT INTO rate_limits(project_id, window_start, count) VALUES($1, date_trunc('minute', now()), 1)
      ON CONFLICT(project_id) DO UPDATE SET window_start=date_trunc('minute', now()),
      count=CASE WHEN rate_limits.window_start=date_trunc('minute', now()) THEN rate_limits.count+1 ELSE 1 END RETURNING count`, [project.id]);
    if (rate.rows[0].count > 120) throw new AppError('rate_limited', 'Project limit: 120 requests per minute.', 429, { retry_after: 60 });
    return project;
  }
  async getConnection(project: string, user: string, connection: string, db: pg.Pool | pg.PoolClient = this.pool, lock = false): Promise<Connection> {
    const result = await db.query(`SELECT * FROM connections WHERE id=$1 AND project_id=$2 AND external_user_id=$3${lock ? ' FOR UPDATE' : ''}`, [connection, project, user]);
    if (!result.rows[0]) throw new AppError('not_found', 'Connection not found.', 404);
    return result.rows[0];
  }
  async enrichConnection(c: Connection): Promise<Connection> {
    if (!providerSpec(c.provider).refreshIdentity || c.identity.transport !== 'mcp' || c.status !== 'connected') return c;
    const checked = Date.parse(c.identity.identity_checked_at || '');
    if (Number.isFinite(checked) && Date.now() - checked < 3600000) return c;
    try { await this.execute(c.project_id,c.external_user_id,c.id,`${c.provider}.__identity` as ActionName,{}); }
    catch (error) { if (!(error instanceof AppError)) throw error; }
    return this.getConnection(c.project_id,c.external_user_id,c.id);
  }
  async createSession(project: Project, input: { external_user_id: string; provider: ProviderName; return_url?: string }, reconnectId?: string) {
    const active = await this.providerStore.active(input.provider);
    if (reconnectId && providerSpec(input.provider).auth === 'mcp') {
      const old = await this.getConnection(project.id,input.external_user_id,reconnectId);
      if (old.identity.transport !== 'mcp') throw new AppError('new_connection_required','Create a new MCP connection; legacy API connections cannot be reconnected.',409);
    }
    const appId = reconnectId ? (await this.getConnection(project.id, input.external_user_id, reconnectId)).provider_app_id : active.appId;
    const sessionId = id('cs'); const token = randomToken();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await this.pool.query(`INSERT INTO connect_sessions(id,project_id,external_user_id,provider,return_url,link_hash,expires_at,reconnect_id,provider_app_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [sessionId, project.id, input.external_user_id, input.provider, input.return_url || null, hash(token), expiresAt, reconnectId || null, appId]);
    return { id: sessionId, status: 'pending', provider: input.provider, connect_url: `${this.providers.config.publicBaseUrl}/connect/${token}`, expires_at: expiresAt };
  }
  async getLink(token: string) {
    const { rows } = await this.pool.query(`SELECT s.*, p.name AS project_name FROM connect_sessions s JOIN projects p ON p.id=s.project_id WHERE s.link_hash=$1 AND p.enabled=true`, [hash(token)]);
    const s = rows[0];
    if (!s || new Date(s.expires_at).getTime() <= Date.now() || s.status !== 'pending') throw new AppError('session_unavailable', 'This connection link has expired or was already used. Request a new link from your agent.', 410);
    return s;
  }
  async begin(token: string) {
    const s = await this.getLink(token);
    await this.providerStore.active(s.provider);
    const provider = await this.providerStore.resolve(s.provider, s.provider_app_id);
    const state = randomToken(); const browser = randomToken(); const verifier = randomToken();
    const url = provider.authorizeUrl(s.provider, state, verifier);
    const { rowCount } = await this.pool.query(`UPDATE connect_sessions SET status='authorizing',state_hash=$1,browser_hash=$2,verifier_ciphertext=$3 WHERE id=$4 AND status='pending' AND expires_at>now()`, [hash(state), hash(browser), this.vault.seal(verifier, s.id), s.id]);
    if (!rowCount) throw new AppError('session_unavailable', 'This connection link was already used.', 410);
    return { session: s, browser, url };
  }
  async findCallback(provider: ProviderName, state: string) {
    const { rows } = await this.pool.query(`SELECT * FROM connect_sessions WHERE provider=$1 AND state_hash=$2 AND status='authorizing' AND expires_at>now()`, [provider, hash(state)]);
    if (!rows[0]) throw new AppError('invalid_state', 'This authorization has expired or was already completed. Request a new link.', 400);
    return rows[0];
  }
  async finish(s: any, browser: string, code?: string, denied = false) {
    if (!browser || hash(browser) !== s.browser_hash) throw new AppError('browser_mismatch', 'Complete authorization in the browser where you opened the connection link.', 400);
    // Consume before contacting the provider: a callback/code can only be processed once.
    const claimed = await this.pool.query(`UPDATE connect_sessions SET status='processing',state_hash=NULL,browser_hash=NULL,verifier_ciphertext=NULL WHERE id=$1 AND status='authorizing' AND expires_at>now() RETURNING id`, [s.id]);
    if (!claimed.rowCount) throw new AppError('invalid_state', 'This authorization has already been processed.');
    let errorCode: string | null = denied ? 'access_denied' : !code ? 'missing_code' : null;
    let connection: Connection | undefined;
    if (!errorCode) {
      try {
        const providers = await this.providerStore.resolve(s.provider, s.provider_app_id);
        const { credential, raw } = await providers.exchange(s.provider, code!, this.vault.open<string>(s.verifier_ciphertext, s.id));
        const identity = await providers.identify(s.provider, credential, raw);
        connection = await transaction(this.pool, async db => {
          // Serialize identity deduplication for a project; connection-level locks serialize reconnect/disconnect.
          const project = (await db.query('SELECT enabled FROM projects WHERE id=$1 FOR UPDATE', [s.project_id])).rows[0];
          if (!project?.enabled) throw new AppError('project_disabled', 'This agent project has been disabled.', 403);
          let existing: Connection | undefined;
          if (s.reconnect_id) {
            existing = await this.getConnection(s.project_id, s.external_user_id, s.reconnect_id, db, true);
            if (existing.status === 'revoked') throw new AppError('connection_revoked', 'Create a new connection after disconnecting.');
            if (existing.identity.account_id !== identity.account_id || existing.identity.workspace_id !== identity.workspace_id) throw new AppError('account_mismatch', 'Reconnect with the original account and workspace.');
          } else {
            const result = await db.query(`SELECT * FROM connections WHERE project_id=$1 AND external_user_id=$2 AND provider=$3 AND status <> 'revoked' AND identity->>'account_id'=$4 AND COALESCE(identity->>'workspace_id','')=$5 AND provider_app_id IS NOT DISTINCT FROM $6 FOR UPDATE`, [s.project_id, s.external_user_id, s.provider, identity.account_id, identity.workspace_id || '', s.provider_app_id]);
            existing = result.rows[0];
          }
          const connectionId = existing?.id || id('conn');
          const ciphertext = this.vault.seal(credential, `${s.project_id}:${s.provider}:${connectionId}`);
          const result = existing ? await db.query(`UPDATE connections SET status='connected',identity=$1,credential_ciphertext=$2,expires_at=$3,updated_at=now(),revocation_status='not_requested' WHERE id=$4 RETURNING *`, [JSON.stringify(identity), ciphertext, credential.expiresAt || null, connectionId]) : await db.query(`INSERT INTO connections(id,project_id,external_user_id,provider,status,identity,credential_ciphertext,expires_at,provider_app_id) VALUES($1,$2,$3,$4,'connected',$5,$6,$7,$8) RETURNING *`, [connectionId, s.project_id, s.external_user_id, s.provider, JSON.stringify(identity), ciphertext, credential.expiresAt || null, s.provider_app_id]);
          await db.query(`UPDATE connect_sessions SET status='connected',connection_id=$1 WHERE id=$2`, [connectionId, s.id]);
          await event(db, s.project_id, s.external_user_id, 'connection.connected', connectionId, { provider: s.provider });
          return result.rows[0];
        });
      } catch (e) { errorCode = e instanceof AppError ? e.code : 'connection_failed'; }
    }
    if (errorCode) {
      await transaction(this.pool, async db => {
        await db.query(`UPDATE connect_sessions SET status='error',error_code=$1 WHERE id=$2`, [errorCode, s.id]);
        await event(db, s.project_id, s.external_user_id, 'connection.failed', null, { session_id: s.id, error_code: errorCode });
      });
    }
    return { connection, errorCode };
  }
  async execute(project: string, user: string, connectionId: string, action: ActionName, input: unknown) {
    const definition = Object.hasOwn(actions,action) ? actions[action as keyof typeof actions] : undefined;
    if (!definition && !mcpActionPattern.test(action)) throw new AppError('action_not_found','Unknown action.');
    const parsed = definition ? definition.schema.parse(input) : input;
    const outcome = await transaction(this.pool, async db => {
      const c = await this.getConnection(project, user, connectionId, db, true);
      if (c.status !== 'connected' || !c.credential_ciphertext) throw new AppError(c.status === 'revoked' ? 'connection_revoked' : 'reauth_required', 'Reconnect this account before using it.', 409);
      if ((definition?.provider || action.split('.')[0]) !== c.provider) throw new AppError('provider_mismatch', 'The action does not match this connection.');
      const spec = providerSpec(c.provider);
      const isIdentity = action === `${c.provider}.__identity` && !!spec.refreshIdentity;
      if (isIdentity && Date.now() - Date.parse(c.identity.identity_checked_at || '') < 3600000) return {data:c.identity,error:null};
      const providers = await this.providerStore.resolve(c.provider, c.provider_app_id, db);
      let credential = this.vault.open<Credentials>(c.credential_ciphertext, this.context(c));
      let refreshed = false;
      const refresh = async () => {
        credential = await providers.refresh(c.provider, credential); refreshed = true;
        await db.query('UPDATE connections SET credential_ciphertext=$1,expires_at=$2,updated_at=now() WHERE id=$3', [this.vault.seal(credential, this.context(c)), credential.expiresAt || null, c.id]);
      };
      try {
        if (isIdentity) await db.query("UPDATE connections SET identity=identity || $1::jsonb WHERE id=$2",[JSON.stringify({identity_checked_at:new Date().toISOString()}),c.id]);
        const perform = async () => {
          if (isIdentity) {
            const expected = {account_id:c.identity.account_id,workspace_id:c.identity.workspace_id};
            const names = await spec.refreshIdentity!(providers.mcp(c.provider),credential,expected);
            await db.query('UPDATE connections SET identity=identity || $1::jsonb,updated_at=now() WHERE id=$2',[JSON.stringify(names),c.id]);
            return names;
          }
          return action === `${c.provider}.__discover` ? providers.mcp(c.provider).tools(credential) : providers.execute(action, parsed, credential);
        };
        if (credential.expiresAt && Date.parse(credential.expiresAt) < Date.now() + 60000) await refresh();
        let data: unknown;
        try { data = await perform(); }
        catch (e) {
          if (e instanceof ProviderError && e.status === 401 && !refreshed && credential.refreshToken) { await refresh(); data = await perform(); }
          else throw e;
        }
        await event(db, project, user, 'action.succeeded', c.id, { action });
        return { data, error: null };
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        if (e.status === 401) {
          await db.query(`UPDATE connections SET status='reauth_required',updated_at=now() WHERE id=$1`, [c.id]);
          await event(db, project, user, 'connection.reauth_required', c.id);
          e = new AppError('reauth_required', 'Authorization expired or was revoked. Reconnect this account.', 409);
        }
        await event(db, project, user, 'action.failed', c.id, { action, error_code: (e as AppError).code });
        // Commit rotated credentials even when the subsequent provider call fails.
        return { error: e as AppError, data: undefined };
      }
    });
    if (outcome.error) throw outcome.error;
    return outcome.data;
  }
  async githubInstallations(project: string, user: string, connectionId: string, page = 1, limit = 20) {
    const connection = await this.getConnection(project, user, connectionId);
    if (connection.provider !== 'github') throw new AppError('provider_mismatch', 'This connection is not a GitHub account.');
    const result = await this.execute(project, user, connectionId, 'github.installations.list', { page, limit }) as any;
    const providers = await this.providerStore.resolve('github', connection.provider_app_id);
    return {
      installation_url: providers.installUrl(), total_count: result.total_count,
      next_page: page * limit < result.total_count ? page + 1 : null,
      data: (result.installations || []).map((installation: any) => {
        let managementUrl: string | null = null;
        try {
          const url = new URL(installation.html_url);
          if (url.origin === 'https://github.com' && !url.username && !url.password) managementUrl = url.toString();
        } catch {}
        return { id: installation.id, account: installation.account?.login, account_type: installation.account?.type,
          repository_selection: installation.repository_selection, suspended_at: installation.suspended_at,
          management_url: managementUrl };
      })
    };
  }
  /**
   * Permanently delete an API key's project. Disable it first so no new calls or callbacks
   * land, revoke upstream grants best-effort, then remove all rows owned by the project.
   */
  async deleteProject(projectId: string) {
    const { rowCount } = await this.pool.query('UPDATE projects SET enabled=false,updated_at=now() WHERE id=$1', [projectId]);
    if (!rowCount) throw new AppError('not_found', 'API Key 不存在。', 404);
    await this.pool.query("UPDATE connect_sessions SET status='error',error_code='project_deleted',state_hash=NULL,browser_hash=NULL,verifier_ciphertext=NULL WHERE project_id=$1 AND status IN ('pending','authorizing')", [projectId]);
    const { rows } = await this.pool.query<Connection>('SELECT * FROM connections WHERE project_id=$1 AND credential_ciphertext IS NOT NULL', [projectId]);
    const queue = [...rows];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        try { await (await this.providerStore.resolve(c.provider, c.provider_app_id)).revoke(c.provider, this.vault.open<Credentials>(c.credential_ciphertext!, this.context(c))); }
        catch { /* Local deletion proceeds; the upstream grant can still be removed by the user. */ }
      }
    }));
    await transaction(this.pool, async db => {
      await db.query('SELECT 1 FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
      for (const table of ['connect_sessions', 'events', 'rate_limits', 'connections', 'projects'])
        await db.query(`DELETE FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'}=$1`, [projectId]);
    });
    return { revoked: rows.length };
  }
  async disconnect(project: string, user: string, connectionId: string) {
    // Revoke locally in a committed transaction before any upstream request. Ciphertext is
    // retained on upstream failure so DELETE can be retried; it is never usable for actions.
    await transaction(this.pool, async db => {
      const c = await this.getConnection(project, user, connectionId, db, true);
      if (c.status !== 'revoked') {
        await db.query(`UPDATE connections SET status='revoked',revocation_status='pending',updated_at=now() WHERE id=$1`, [c.id]);
        await event(db, project, user, 'connection.revoked', c.id);
      }
    });
    return transaction(this.pool, async db => {
      const c = await this.getConnection(project, user, connectionId, db, true);
      if (c.credential_ciphertext) {
        let result = 'succeeded';
        try { const providers = await this.providerStore.resolve(c.provider, c.provider_app_id, db); await providers.revoke(c.provider, this.vault.open<Credentials>(c.credential_ciphertext, this.context(c))); }
        catch { result = 'failed'; }
        const { rows } = await db.query(`UPDATE connections SET revocation_status=$1,credential_ciphertext=CASE WHEN $1='succeeded' THEN NULL ELSE credential_ciphertext END,expires_at=NULL,updated_at=now() WHERE id=$2 RETURNING *`, [result, c.id]);
        return publicConnection(rows[0]);
      }
      return publicConnection(c);
    });
  }
}
