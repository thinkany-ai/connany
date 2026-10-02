import type pg from 'pg';
import { z } from 'zod';
import type { Config, ConnectorName } from './config.js';
import { connectorNames } from './config.js';
import { connector as connectorSpec } from './connectors/catalog.js';
import { Vault, id } from './crypto.js';
import { transaction } from './db.js';
import { AppError } from './errors.js';
import { ConnectorRuntime } from './connectors/index.js';
import { defaultWorkspaceId } from './workspaces.js';

export const connectorAppInput = z.object({
  client_id: z.string().trim().min(1).max(300), client_secret: z.string().max(2000).default(''),
  github_app_slug: z.string().trim().max(100).default(''), enabled: z.boolean(),
}).strict();
export interface ConnectorView {
  name: ConnectorName; configured: boolean; enabled: boolean; client_id: string;
  has_secret: boolean; github_app_slug: string; callback_url: string; updated_at: Date | null;
  /** Cached tool catalog size and freshness; null until an administrator sync or user authorization. */
  tool_count: number; tools_synced_at: Date | null;
}
/** A tool definition in the connector catalog. Never contains user data. */
export interface ToolDefinition { name: string; connector: ConnectorName; description: string; read_only: boolean; required_permissions: string[]; input_schema: Record<string, unknown> }
export class ConnectorStore {
  constructor(public pool: pg.Pool, public base: ConnectorRuntime, private vault: Vault, public workspaceId = defaultWorkspaceId) {}
  // Encryption context of stored app secrets. The literal predates the connector rename; keep it.
  private context(appId: string) { return `provider-app:${appId}`; }
  /** Import legacy env credentials only once. Database settings win after initial import. */
  async bootstrap() {
    await transaction(this.pool, async db => {
      await db.query('SELECT pg_advisory_xact_lock(804217332)');
      for (const name of connectorNames) {
        if (connectorSpec(name).auth !== 'github_app') continue;
        const env = this.base.config.connectors[name];
        if (!env.clientId) continue;
        let app = (await db.query('SELECT id FROM connector_apps WHERE workspace_id=$1 AND connector=$2 AND client_id=$3', [this.workspaceId, name, env.clientId])).rows[0];
        const hasSettings = !!(await db.query('SELECT 1 FROM connectors WHERE workspace_id=$1 AND name=$2', [this.workspaceId, name])).rowCount;
        if (!app && !hasSettings) {
          const appId = id('capp');
          app = (await db.query('INSERT INTO connector_apps(id,workspace_id,connector,client_id,secret_ciphertext,settings) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [appId, this.workspaceId, name, env.clientId, this.vault.seal(env.clientSecret, this.context(appId)), JSON.stringify({ github_app_slug: name === 'github' ? this.base.config.githubAppSlug : '' })])).rows[0];
        }
        if (!app) continue;
        await db.query('INSERT INTO connectors(workspace_id,name,active_app_id) VALUES($1,$2,$3) ON CONFLICT(workspace_id,name) DO NOTHING', [this.workspaceId, name, app.id]);
        // Bind legacy tokens only to the matching legacy env app, never to a new default app.
        await db.query('UPDATE connections SET connector_app_id=$1 WHERE connector=$2 AND connector_app_id IS NULL', [app.id, name]);
        await db.query('UPDATE connect_sessions SET connector_app_id=$1 WHERE connector=$2 AND connector_app_id IS NULL', [app.id, name]);
      }
    });
  }
  async list(): Promise<ConnectorView[]> {
    const catalogs = (await this.pool.query('SELECT connector,jsonb_array_length(tools)::int AS tool_count,synced_at FROM connector_tools WHERE workspace_id=$1',[this.workspaceId])).rows;
    const { rows } = await this.pool.query(`SELECT s.name,s.enabled,s.updated_at,a.id,a.client_id,a.settings FROM connectors s LEFT JOIN connector_apps a ON a.id=s.active_app_id WHERE s.workspace_id=$1`, [this.workspaceId]);
    return connectorNames.map(name => {
      const r = rows.find(r => r.name === name);
      const catalog = catalogs.find(c => c.connector === name);
      const tools = { tool_count: catalog?.tool_count ?? 0, tools_synced_at: catalog?.synced_at ?? null };
      if (connectorSpec(name).auth === 'mcp' && r?.settings?.transport !== 'mcp') return {name,configured:false,enabled:false,client_id:'',has_secret:false,github_app_slug:'',callback_url:this.base.callback(name),updated_at:null,...tools};
      const slug = r?.settings?.github_app_slug || '';
      return { name, configured: !!r?.id, enabled: !!r?.id && r.enabled, client_id: r?.client_id || '', has_secret: !!r?.id,
        github_app_slug: slug, callback_url: this.base.callback(name), updated_at: r?.updated_at || null, ...tools };
    });
  }
  async saveTools(name: ConnectorName, tools: ToolDefinition[], db: pg.Pool | pg.PoolClient = this.pool) {
    await db.query(`INSERT INTO connector_tools(workspace_id,connector,tools,synced_at) VALUES($1,$2,$3,now())
      ON CONFLICT(workspace_id,connector) DO UPDATE SET tools=EXCLUDED.tools,synced_at=now()`, [this.workspaceId, name, JSON.stringify(tools)]);
  }
  /** Tool catalogs of enabled connectors. */
  async tools(): Promise<ToolDefinition[]> {
    const { rows } = await this.pool.query(`SELECT t.tools FROM connector_tools t JOIN connectors s ON s.workspace_id=t.workspace_id AND s.name=t.connector
      WHERE t.workspace_id=$1 AND s.enabled=true AND s.active_app_id IS NOT NULL ORDER BY t.connector`, [this.workspaceId]);
    return rows.flatMap(row => row.tools);
  }
  /** Cached catalog of one connector regardless of whether it accepts new connections; null if never synced. */
  async catalog(name: ConnectorName): Promise<ToolDefinition[] | null> {
    const { rows } = await this.pool.query('SELECT tools FROM connector_tools WHERE workspace_id=$1 AND connector=$2', [this.workspaceId, name]);
    return rows[0]?.tools ?? null;
  }
  async saveMcp(name: ConnectorName, enabled: boolean, adminId: string) {
    if (connectorSpec(name).auth !== 'mcp') throw new AppError('github_app_required', 'Configure a GitHub App for OAuth.');
    await transaction(this.pool, async db => {
      await db.query('SELECT pg_advisory_xact_lock(804217332)');
      const existing = (await db.query("SELECT a.* FROM connectors s JOIN connector_apps a ON a.id=s.active_app_id WHERE s.workspace_id=$1 AND s.name=$2",[this.workspaceId,name])).rows[0];
      let appId = existing?.settings?.transport === 'mcp' && existing.settings.callback_url === this.base.callback(name) ? existing.id : null;
      if (!appId && enabled) {
        const clientId = await this.base.mcp(name).register(this.base.callback(name));
        appId = id('capp');
        await db.query("INSERT INTO connector_apps(id,workspace_id,connector,client_id,secret_ciphertext,settings) VALUES($1,$2,$3,$4,$5,$6)", [appId,this.workspaceId,name,clientId,this.vault.seal('',this.context(appId)),JSON.stringify({transport:'mcp',callback_url:this.base.callback(name)})]);
      }
      await db.query("INSERT INTO connectors(workspace_id,name,active_app_id,enabled) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,name) DO UPDATE SET active_app_id=EXCLUDED.active_app_id,enabled=EXCLUDED.enabled,updated_at=now()",[this.workspaceId,name,appId,enabled]);
      await db.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$3)',[adminId,'connector.saved',name]);
    });
  }
  async save(name: ConnectorName, input: z.infer<typeof connectorAppInput>, adminId: string) {
    if (connectorSpec(name).auth !== 'github_app') throw new AppError(`use_${name}_mcp`, 'Use official MCP registration.');
    if (name === 'github' && !/^[a-zA-Z0-9-]+$/.test(input.github_app_slug)) throw new AppError('invalid_slug', '请填写 GitHub App slug。');
    await transaction(this.pool, async db => {
      await db.query('SELECT pg_advisory_xact_lock(804217332)');
      const existing = (await db.query('SELECT * FROM connector_apps WHERE workspace_id=$1 AND connector=$2 AND client_id=$3 FOR UPDATE', [this.workspaceId, name, input.client_id])).rows[0];
      if (!existing && !input.client_secret.trim()) throw new AppError('secret_required', '首次配置或更换 Client ID 时必须填写 Client Secret。');
      if (input.client_secret && !input.client_secret.trim()) throw new AppError('secret_required', 'Client Secret 不能为空白字符。');
      const appId = existing?.id || id('capp');
      const ciphertext = input.client_secret ? this.vault.seal(input.client_secret, this.context(appId)) : existing.secret_ciphertext;
      const settings = JSON.stringify({ github_app_slug: name === 'github' ? input.github_app_slug : '' });
      await db.query(`INSERT INTO connector_apps(id,workspace_id,connector,client_id,secret_ciphertext,settings) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(workspace_id,connector,client_id) DO UPDATE SET secret_ciphertext=EXCLUDED.secret_ciphertext,settings=EXCLUDED.settings,updated_at=now()`, [appId, this.workspaceId, name, input.client_id, ciphertext, settings]);
      await db.query(`INSERT INTO connectors(workspace_id,name,active_app_id,enabled) VALUES($1,$2,$3,$4)
        ON CONFLICT(workspace_id,name) DO UPDATE SET active_app_id=EXCLUDED.active_app_id,enabled=EXCLUDED.enabled,updated_at=now()`, [this.workspaceId, name, appId, input.enabled]);
      await db.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$3)', [adminId, 'connector.saved', name]);
    });
  }
  /** Pause or resume an already configured connector without touching its credentials. */
  async setEnabled(name: ConnectorName, enabled: boolean, adminId: string) {
    await transaction(this.pool, async db => {
      const { rowCount } = await db.query('UPDATE connectors SET enabled=$3,updated_at=now() WHERE workspace_id=$1 AND name=$2 AND active_app_id IS NOT NULL', [this.workspaceId, name, enabled]);
      if (!rowCount) throw new AppError('connector_not_configured', '请先配置应用凭证。', 409);
      await db.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$3)', [adminId, 'connector.saved', name]);
    });
  }
  async active(name: ConnectorName) {
    const { rows } = await this.pool.query('SELECT active_app_id FROM connectors WHERE workspace_id=$1 AND name=$2 AND enabled=true', [this.workspaceId, name]);
    if (!rows[0]?.active_app_id) throw new AppError('connector_not_configured', 'This connector is not accepting new connections.', 503);
    return { appId: rows[0].active_app_id as string, runtime: await this.resolve(name, rows[0].active_app_id) };
  }
  async resolve(name: ConnectorName, appId: string | null | undefined, db: pg.Pool | pg.PoolClient = this.pool) {
    if (!appId && connectorSpec(name).auth === 'mcp') throw new AppError('reauth_required', 'Create a new MCP connection.', 409);
    if (!appId) {
      if (this.base.enabled(name)) return this.base;
      throw new AppError('connector_not_configured', 'Restore the original OAuth app credentials for this legacy connection.', 503);
    }
    const { rows } = await db.query('SELECT * FROM connector_apps WHERE id=$1 AND connector=$2', [appId, name]);
    const app = rows[0];
    if (!app) throw new AppError('connector_not_configured', 'OAuth app configuration not found.', 503);
    if (connectorSpec(name).auth === 'mcp' && app.settings.transport !== 'mcp') throw new AppError('reauth_required', 'Create a new MCP connection.', 409);
    const config: Config = { ...this.base.config, connectors: { ...this.base.config.connectors,
      [name]: { clientId: app.client_id, clientSecret: this.vault.open<string>(app.secret_ciphertext, this.context(app.id)) } },
      ...(name === 'github' ? { githubAppSlug: app.settings.github_app_slug } : {}) };
    return this.base.withConfig(config);
  }
}
