import type pg from 'pg';
import { ConnectorStore } from './connector-store.js';
import type { ConnectorName } from './config.js';
import { Vault, hash, id, randomToken } from './crypto.js';
import { event, transaction } from './db.js';
import { AppError, UpstreamError } from './errors.js';
import { restTools, toolNamePattern, type ToolName, type Credentials, ConnectorRuntime } from './connectors/index.js';
import { connector as connectorSpec } from './connectors/catalog.js';
import { defaultWorkspaceId } from './workspaces.js';

export interface Project { id: string; workspace_id: string; name: string; return_urls: string[]; api_key_id: string | null; kind?: 'api' | 'personal' }
export interface Connection {
  id: string; project_id: string; external_user_id: string; connector: ConnectorName; connector_app_id: string | null;
  status: string; identity: Record<string, any>; credential_ciphertext: string | null;
  expires_at: Date | null; revocation_status: string; created_at: Date; updated_at: Date;
}
export function publicConnection(c: Connection) {
  return { id: c.id, external_user_id: c.external_user_id, connector: c.connector, status: c.status,
    identity: c.identity, needs_access: !!connectorSpec(c.connector).access?.needsAccess(c.identity), expires_at: c.expires_at, revocation_status: c.revocation_status, created_at: c.created_at, updated_at: c.updated_at };
}
export function publicSession(s: any) {
  return { id: s.id, connector: s.connector, external_user_id: s.external_user_id,
    status: ['pending','authorizing','processing'].includes(s.status) && new Date(s.expires_at).getTime() < Date.now() ? 'expired' : s.status,
    connection_id: s.connection_id, error_code: s.error_code, expires_at: s.expires_at };
}
export class Service {
  public connectorStore: ConnectorStore;
  private initialization?: Promise<void>;
  constructor(public pool: pg.Pool, public runtime: ConnectorRuntime, public vault: Vault) { this.connectorStore = new ConnectorStore(pool, runtime, vault); }
  initialize() {
    return this.initialization ||= this.connectorStore.bootstrap().catch(error => { this.initialization = undefined; throw error; });
  }
  context(c: Pick<Connection, 'project_id' | 'connector' | 'id'>) { return `${c.project_id}:${c.connector}:${c.id}`; }
  async authenticate(key: string): Promise<Project> {
    if (!key || key.length > 200) throw new AppError('unauthorized', 'A valid project API key is required.', 401);
    const result = await this.pool.query(`SELECT p.id,p.workspace_id,p.name,p.return_urls,k.id AS api_key_id,k.last_used_at FROM api_keys k JOIN projects p ON p.id=k.project_id
      WHERE k.key_hash=$1 AND k.revoked_at IS NULL AND p.enabled=true`, [hash(key)]);
    if (!result.rows[0]) throw new AppError('unauthorized', 'A valid project API key is required.', 401);
    const { last_used_at: lastUsed, ...project } = result.rows[0];
    // Coarse usage tracking: at most one write per key per minute.
    if (!lastUsed || Date.now() - new Date(lastUsed).getTime() > 60000) await this.pool.query('UPDATE api_keys SET last_used_at=now() WHERE id=$1', [project.api_key_id]);
    await this.rateLimit(project.id);
    return project;
  }
  async rateLimit(projectId: string) {
    const rate = await this.pool.query(`INSERT INTO rate_limits(project_id, window_start, count) VALUES($1, date_trunc('minute', now()), 1)
      ON CONFLICT(project_id) DO UPDATE SET window_start=date_trunc('minute', now()),
      count=CASE WHEN rate_limits.window_start=date_trunc('minute', now()) THEN rate_limits.count+1 ELSE 1 END RETURNING count`, [projectId]);
    if (rate.rows[0].count > 120) throw new AppError('rate_limited', 'Project limit: 120 requests per minute.', 429, { retry_after: 60 });
  }
  /**
   * The personal project of a console user: their own connections, used through MCP clients.
   * Created on first use in the user's workspace; external_user_id is the user's id.
   */
  async personalProject(user: { id: string; workspace_id: string }): Promise<Project> {
    const select = "SELECT id,workspace_id,name,return_urls,NULL AS api_key_id,kind FROM projects WHERE owner_id=$1 AND kind='personal'";
    const existing = (await this.pool.query(select, [user.id])).rows[0];
    if (existing) return existing;
    await this.pool.query(`INSERT INTO projects(id,workspace_id,name,return_urls,kind,owner_id) VALUES($1,$2,'个人 MCP','[]','personal',$3)
      ON CONFLICT (owner_id) WHERE kind='personal' DO NOTHING`, [id('proj'), user.workspace_id, user.id]);
    return (await this.pool.query(select, [user.id])).rows[0];
  }
  /**
   * Workspace whose connector configuration serves a project. Personal projects use the
   * user's own connector when enabled, otherwise the platform's (the default workspace).
   */
  async connectorWorkspace(project: { workspace_id: string; kind?: string }, connector: ConnectorName) {
    if (project.kind !== 'personal' || project.workspace_id === defaultWorkspaceId) return project.workspace_id;
    const { rowCount } = await this.pool.query('SELECT 1 FROM connectors WHERE workspace_id=$1 AND name=$2 AND enabled AND active_app_id IS NOT NULL', [project.workspace_id, connector]);
    return rowCount ? project.workspace_id : defaultWorkspaceId;
  }
  async workspaceOf(projectId: string, db: pg.Pool | pg.PoolClient = this.pool): Promise<string> {
    const row = (await db.query('SELECT workspace_id FROM projects WHERE id=$1', [projectId])).rows[0];
    if (!row) throw new AppError('not_found', 'Project not found.', 404);
    return row.workspace_id;
  }
  /** Delete everything a workspace owns, revoking upstream grants of its connections first. */
  async deleteWorkspace(workspaceId: string) {
    const { rows } = await this.pool.query('SELECT id FROM projects WHERE workspace_id=$1', [workspaceId]);
    for (const project of rows) await this.deleteProject(project.id);
    await transaction(this.pool, async db => {
      await db.query('DELETE FROM connect_sessions WHERE workspace_id=$1', [workspaceId]);
      for (const table of ['connector_tools', 'connectors', 'connector_apps']) await db.query(`DELETE FROM ${table} WHERE workspace_id=$1`, [workspaceId]);
      await db.query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
    });
  }
  async getConnection(project: string, user: string, connection: string, db: pg.Pool | pg.PoolClient = this.pool, lock = false): Promise<Connection> {
    const result = await db.query(`SELECT * FROM connections WHERE id=$1 AND project_id=$2 AND external_user_id=$3${lock ? ' FOR UPDATE' : ''}`, [connection, project, user]);
    if (!result.rows[0]) throw new AppError('not_found', 'Connection not found.', 404);
    return result.rows[0];
  }
  async enrichConnection(c: Connection): Promise<Connection> {
    if (!connectorSpec(c.connector).refreshIdentity || c.identity.transport !== 'mcp' || c.status !== 'connected') return c;
    const checked = Date.parse(c.identity.identity_checked_at || '');
    if (Number.isFinite(checked) && Date.now() - checked < 3600000) return c;
    try { await this.execute(c.project_id,c.external_user_id,c.id,`${c.connector}.__identity` as ToolName,{}); }
    catch (error) { if (!(error instanceof AppError)) throw error; }
    return this.getConnection(c.project_id,c.external_user_id,c.id);
  }
  async createSession(project: Project, input: { external_user_id: string; connector: ConnectorName; return_url?: string }, reconnectId?: string) {
    const active = await this.connectorStore.in(await this.connectorWorkspace(project, input.connector)).active(input.connector);
    if (reconnectId && connectorSpec(input.connector).auth === 'mcp') {
      const old = await this.getConnection(project.id,input.external_user_id,reconnectId);
      if (old.identity.transport !== 'mcp') throw new AppError('new_connection_required','Create a new MCP connection; legacy API connections cannot be reconnected.',409);
    }
    const appId = reconnectId ? (await this.getConnection(project.id, input.external_user_id, reconnectId)).connector_app_id : active.appId;
    const sessionId = id('cs'); const token = randomToken();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await this.pool.query(`INSERT INTO connect_sessions(id,project_id,external_user_id,connector,return_url,link_hash,expires_at,reconnect_id,connector_app_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [sessionId, project.id, input.external_user_id, input.connector, input.return_url || null, hash(token), expiresAt, reconnectId || null, appId]);
    return { id: sessionId, status: 'pending', connector: input.connector, connect_url: `${this.runtime.config.publicBaseUrl}/connect/${token}`, expires_at: expiresAt };
  }
  async getLink(token: string) {
    const { rows } = await this.pool.query(`SELECT s.*, p.name AS project_name, p.workspace_id AS project_workspace_id, p.kind AS project_kind FROM connect_sessions s JOIN projects p ON p.id=s.project_id WHERE s.link_hash=$1 AND p.enabled=true`, [hash(token)]);
    const s = rows[0];
    if (!s || new Date(s.expires_at).getTime() <= Date.now() || !['pending','authorizing'].includes(s.status)) throw new AppError('session_unavailable', 'This connection link has expired or was already used. Request a new link from your agent.', 410);
    return s;
  }
  /**
   * Start (or restart) authorization from a connection link. Chat apps and link previews often
   * fetch a link before the user clicks it, so opening it again until authorization completes
   * issues a fresh state and browser binding; whatever an earlier open started stops working.
   */
  async begin(token: string) {
    const s = await this.getLink(token);
    await this.connectorStore.in(await this.connectorWorkspace({ workspace_id: s.project_workspace_id, kind: s.project_kind }, s.connector)).active(s.connector);
    const runtime = await this.connectorStore.resolve(s.connector, s.connector_app_id);
    const state = randomToken(); const browser = randomToken(); const verifier = randomToken();
    const url = runtime.authorizeUrl(s.connector, state, verifier);
    const { rowCount } = await this.pool.query(`UPDATE connect_sessions SET status='authorizing',state_hash=$1,browser_hash=$2,verifier_ciphertext=$3 WHERE id=$4 AND status IN ('pending','authorizing') AND expires_at>now()`, [hash(state), hash(browser), this.vault.seal(verifier, s.id), s.id]);
    if (!rowCount) throw new AppError('session_unavailable', 'This connection link was already used.', 410);
    return { session: s, browser, url };
  }
  async findCallback(connector: ConnectorName, state: string) {
    const { rows } = await this.pool.query(`SELECT * FROM connect_sessions WHERE connector=$1 AND state_hash=$2 AND status='authorizing' AND expires_at>now()`, [connector, hash(state)]);
    if (!rows[0]) throw new AppError('invalid_state', 'This authorization has expired or was already completed. Request a new link.', 400);
    return rows[0];
  }
  async finish(s: any, browser: string, code?: string, denied = false) {
    if (!browser || hash(browser) !== s.browser_hash) throw new AppError('browser_mismatch', 'Complete authorization in the browser where you opened the connection link.', 400);
    // Consume before contacting the upstream service: a callback/code can only be processed once.
    const claimed = await this.pool.query(`UPDATE connect_sessions SET status='processing',state_hash=NULL,browser_hash=NULL,verifier_ciphertext=NULL WHERE id=$1 AND status='authorizing' AND expires_at>now() RETURNING id`, [s.id]);
    if (!claimed.rowCount) throw new AppError('invalid_state', 'This authorization has already been processed.');
    if (s.purpose === 'tool_sync') return this.finishToolSync(s, code, denied);
    let errorCode: string | null = denied ? 'access_denied' : !code ? 'missing_code' : null;
    let connection: Connection | undefined;
    if (!errorCode) {
      try {
        const runtime = await this.connectorStore.resolve(s.connector, s.connector_app_id);
        const { credential, raw } = await runtime.exchange(s.connector, code!, this.vault.open<string>(s.verifier_ciphertext, s.id));
        const identity = await runtime.identify(s.connector, credential, raw);
        // Refresh the connector's tool catalog with the user's own fresh credential; optional.
        try { await this.connectorStore.in(await this.workspaceOf(s.project_id)).saveTools(s.connector, await runtime.mcp(s.connector).tools(credential)); } catch {}
        connection = await transaction(this.pool, async db => {
          // Serialize identity deduplication for a project; connection-level locks serialize reconnect/disconnect.
          const project = (await db.query('SELECT enabled FROM projects WHERE id=$1 FOR UPDATE', [s.project_id])).rows[0];
          if (!project?.enabled) throw new AppError('project_disabled', 'This agent project has been disabled.', 403);
          let existing: Connection | undefined;
          if (s.reconnect_id) {
            existing = await this.getConnection(s.project_id, s.external_user_id, s.reconnect_id, db, true);
            if (existing.status === 'revoked') throw new AppError('connection_revoked', 'Create a new connection after disconnecting.');
            // Unverified identities (no userinfo or claims upstream) cannot be compared.
            const comparable = !existing.identity.unverified && !identity.unverified;
            if (comparable && (existing.identity.account_id !== identity.account_id || existing.identity.workspace_id !== identity.workspace_id)) throw new AppError('account_mismatch', 'Reconnect with the original account and workspace.');
          } else {
            const result = await db.query(`SELECT * FROM connections WHERE project_id=$1 AND external_user_id=$2 AND connector=$3 AND status <> 'revoked' AND identity->>'account_id'=$4 AND COALESCE(identity->>'workspace_id','')=$5 AND connector_app_id IS NOT DISTINCT FROM $6 FOR UPDATE`, [s.project_id, s.external_user_id, s.connector, identity.account_id, identity.workspace_id || '', s.connector_app_id]);
            existing = result.rows[0];
          }
          const connectionId = existing?.id || id('conn');
          const ciphertext = this.vault.seal(credential, `${s.project_id}:${s.connector}:${connectionId}`);
          const result = existing ? await db.query(`UPDATE connections SET status='connected',identity=$1,credential_ciphertext=$2,expires_at=$3,updated_at=now(),revocation_status='not_requested' WHERE id=$4 RETURNING *`, [JSON.stringify(identity), ciphertext, credential.expiresAt || null, connectionId]) : await db.query(`INSERT INTO connections(id,project_id,external_user_id,connector,status,identity,credential_ciphertext,expires_at,connector_app_id) VALUES($1,$2,$3,$4,'connected',$5,$6,$7,$8) RETURNING *`, [connectionId, s.project_id, s.external_user_id, s.connector, JSON.stringify(identity), ciphertext, credential.expiresAt || null, s.connector_app_id]);
          await db.query(`UPDATE connect_sessions SET status='connected',connection_id=$1 WHERE id=$2`, [connectionId, s.id]);
          await event(db, s.project_id, s.external_user_id, 'connection.connected', connectionId, { connector: s.connector });
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
    return { connection, errorCode, toolCount: undefined as number | undefined };
  }
  /**
   * Start an administrator authorization whose only purpose is reading the connector's tool
   * catalog. No connection is created and the credential is revoked right after the sync.
   */
  async beginToolSync(connector: ConnectorName, adminId: string, workspaceId: string) {
    const active = await this.connectorStore.in(workspaceId).active(connector);
    const sessionId = id('cs'); const state = randomToken(); const browser = randomToken(); const verifier = randomToken();
    const url = active.runtime.authorizeUrl(connector, state, verifier);
    await this.pool.query(`INSERT INTO connect_sessions(id,project_id,external_user_id,connector,link_hash,status,state_hash,browser_hash,verifier_ciphertext,expires_at,connector_app_id,purpose,workspace_id)
      VALUES($1,NULL,$2,$3,$4,'authorizing',$5,$6,$7,$8,$9,'tool_sync',$10)`, [sessionId, adminId, connector, hash(randomToken()), hash(state), hash(browser), this.vault.seal(verifier, sessionId), new Date(Date.now() + 15 * 60 * 1000), active.appId, workspaceId]);
    return { session: { id: sessionId, connector }, browser, url };
  }
  private async finishToolSync(s: any, code?: string, denied = false) {
    let errorCode: string | null = denied ? 'access_denied' : !code ? 'missing_code' : null;
    let toolCount: number | undefined;
    if (!errorCode) {
      try {
        const runtime = await this.connectorStore.resolve(s.connector, s.connector_app_id);
        const { credential } = await runtime.exchange(s.connector, code!, this.vault.open<string>(s.verifier_ciphertext, s.id));
        try {
          const tools = await runtime.mcp(s.connector).tools(credential);
          await this.connectorStore.in(s.workspace_id).saveTools(s.connector, tools); toolCount = tools.length;
        } finally {
          // Token-level revocation: other grants of the same account are unaffected.
          await runtime.revoke(s.connector, credential).catch(() => {});
        }
      } catch (e) { errorCode = e instanceof AppError ? e.code : 'tool_sync_failed'; }
    }
    await transaction(this.pool, async db => {
      await db.query(`UPDATE connect_sessions SET status=$1,error_code=$2 WHERE id=$3`, [errorCode ? 'error' : 'connected', errorCode, s.id]);
      if (!errorCode) await db.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$3)', [s.external_user_id, 'connector.tools_synced', s.connector]);
    });
    return { connection: undefined, errorCode, toolCount };
  }
  async execute(project: string, user: string, connectionId: string, tool: ToolName, input: unknown) {
    const definition = Object.hasOwn(restTools,tool) ? restTools[tool as keyof typeof restTools] : undefined;
    if (!definition && !toolNamePattern.test(tool)) throw new AppError('tool_not_found','Unknown tool.');
    const parsed = definition ? definition.schema.parse(input) : input;
    const outcome = await transaction(this.pool, async db => {
      const c = await this.getConnection(project, user, connectionId, db, true);
      if (c.status !== 'connected' || !c.credential_ciphertext) throw new AppError(c.status === 'revoked' ? 'connection_revoked' : 'reauth_required', 'Reconnect this account before using it.', 409);
      if ((definition?.connector || tool.split('.')[0]) !== c.connector) throw new AppError('connector_mismatch', 'The tool does not match this connection.');
      const spec = connectorSpec(c.connector);
      const isIdentity = tool === `${c.connector}.__identity` && !!spec.refreshIdentity;
      if (isIdentity && Date.now() - Date.parse(c.identity.identity_checked_at || '') < 3600000) return {data:c.identity,error:null};
      const runtime = await this.connectorStore.resolve(c.connector, c.connector_app_id, db);
      let credential = this.vault.open<Credentials>(c.credential_ciphertext, this.context(c));
      let refreshed = false;
      const refresh = async () => {
        credential = await runtime.refresh(c.connector, credential); refreshed = true;
        await db.query('UPDATE connections SET credential_ciphertext=$1,expires_at=$2,updated_at=now() WHERE id=$3', [this.vault.seal(credential, this.context(c)), credential.expiresAt || null, c.id]);
      };
      try {
        if (isIdentity) await db.query("UPDATE connections SET identity=identity || $1::jsonb WHERE id=$2",[JSON.stringify({identity_checked_at:new Date().toISOString()}),c.id]);
        const perform = async () => {
          if (isIdentity) {
            const expected = {account_id:c.identity.account_id,workspace_id:c.identity.workspace_id};
            const names = await spec.refreshIdentity!(runtime.mcp(c.connector),credential,expected);
            await db.query('UPDATE connections SET identity=identity || $1::jsonb,updated_at=now() WHERE id=$2',[JSON.stringify(names),c.id]);
            return names;
          }
          if (tool !== `${c.connector}.__discover`) {
            // A tool in the cached catalog is called directly instead of listing upstream tools first.
            const catalog = definition ? null : await this.connectorStore.in(await this.workspaceOf(project, db)).catalog(c.connector);
            return runtime.execute(tool, parsed, credential, !!catalog?.some(t => t.name === tool));
          }
          const tools = await runtime.mcp(c.connector).tools(credential);
          await this.connectorStore.in(await this.workspaceOf(project, db)).saveTools(c.connector, tools, db);
          return tools;
        };
        if (credential.expiresAt && Date.parse(credential.expiresAt) < Date.now() + 60000) await refresh();
        let data: unknown;
        try { data = await perform(); }
        catch (e) {
          if (e instanceof UpstreamError && e.status === 401 && !refreshed && credential.refreshToken) { await refresh(); data = await perform(); }
          else throw e;
        }
        await event(db, project, user, 'tool.succeeded', c.id, { tool });
        return { data, error: null };
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        if (e.status === 401) {
          await db.query(`UPDATE connections SET status='reauth_required',updated_at=now() WHERE id=$1`, [c.id]);
          await event(db, project, user, 'connection.reauth_required', c.id);
          e = new AppError('reauth_required', 'Authorization expired or was revoked. Reconnect this account.', 409);
        }
        await event(db, project, user, 'tool.failed', c.id, { tool, error_code: (e as AppError).code });
        // Commit rotated credentials even when the subsequent upstream call fails.
        return { error: e as AppError, data: undefined };
      }
    });
    if (outcome.error) throw outcome.error;
    return outcome.data;
  }
  /** Resource scopes granted after OAuth (see ConnectorAccess). Empty for connectors without that step. */
  async listAccess(project: string, user: string, connectionId: string, page = 1, limit = 20) {
    const connection = await this.getConnection(project, user, connectionId);
    const access = connectorSpec(connection.connector).access;
    if (!access) return { add_url: null, total: 0, next_page: null, data: [] };
    const result = await access.list({ call: (tool, input) => this.execute(project, user, connectionId, tool as ToolName, input), page, limit });
    // Installing an App happens on the platform; the listing is the first place Connany sees it.
    const identity = connection.identity && access.refresh?.(connection.identity, result.total);
    if (identity && JSON.stringify(identity) !== JSON.stringify(connection.identity))
      await this.pool.query('UPDATE connections SET identity=$1,updated_at=now() WHERE id=$2 AND project_id=$3', [JSON.stringify(identity), connection.id, project]);
    const runtime = await this.connectorStore.resolve(connection.connector, connection.connector_app_id);
    return { add_url: access.addUrl(runtime), total: result.total, next_page: page * limit < result.total ? page + 1 : null, data: result.data };
  }
  /**
   * Permanently delete a project. Disable it first so no new calls or callbacks
   * land, revoke upstream grants best-effort, then remove all rows owned by the project.
   */
  async deleteProject(projectId: string) {
    const { rowCount } = await this.pool.query('UPDATE projects SET enabled=false,updated_at=now() WHERE id=$1', [projectId]);
    if (!rowCount) throw new AppError('not_found', 'Project 不存在。', 404);
    await this.pool.query("UPDATE connect_sessions SET status='error',error_code='project_deleted',state_hash=NULL,browser_hash=NULL,verifier_ciphertext=NULL WHERE project_id=$1 AND status IN ('pending','authorizing')", [projectId]);
    const { rows } = await this.pool.query<Connection>('SELECT * FROM connections WHERE project_id=$1 AND credential_ciphertext IS NOT NULL', [projectId]);
    const queue = [...rows];
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      for (let c = queue.shift(); c; c = queue.shift()) {
        try { await (await this.connectorStore.resolve(c.connector, c.connector_app_id)).revoke(c.connector, this.vault.open<Credentials>(c.credential_ciphertext!, this.context(c))); }
        catch { /* Local deletion proceeds; the upstream grant can still be removed by the user. */ }
      }
    }));
    await transaction(this.pool, async db => {
      await db.query('SELECT 1 FROM projects WHERE id=$1 FOR UPDATE', [projectId]);
      for (const table of ['connect_sessions', 'events', 'rate_limits', 'connections', 'api_keys', 'projects'])
        await db.query(`DELETE FROM ${table} WHERE ${table === 'projects' ? 'id' : 'project_id'}=$1`, [projectId]);
    });
    return { revoked: rows.length };
  }
  async disconnect(project: string, user: string, connectionId: string) {
    // Revoke locally in a committed transaction before any upstream request. Ciphertext is
    // retained on upstream failure so DELETE can be retried; it is never usable for tool calls.
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
        try { const runtime = await this.connectorStore.resolve(c.connector, c.connector_app_id, db); await runtime.revoke(c.connector, this.vault.open<Credentials>(c.credential_ciphertext, this.context(c))); }
        catch { result = 'failed'; }
        const { rows } = await db.query(`UPDATE connections SET revocation_status=$1,credential_ciphertext=CASE WHEN $1='succeeded' THEN NULL ELSE credential_ciphertext END,expires_at=NULL,updated_at=now() WHERE id=$2 RETURNING *`, [result, c.id]);
        return publicConnection(rows[0]);
      }
      return publicConnection(c);
    });
  }
}
