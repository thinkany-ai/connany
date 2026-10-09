import type pg from 'pg';
import type { Credentials, ConnectorRuntime } from './connectors/index.js';
import { customDefinitions, isCustomConnector, type ConnectorDefinition, type CustomConnectorName, type McpSpec } from './connectors/catalog.js';
import { discoverServer } from './connectors/remote-mcp.js';
import { Vault, hash, id } from './crypto.js';
import { transaction } from './db.js';
import { AppError } from './errors.js';

/**
 * Remote MCP servers a project's user adds by URL (docs/custom-connectors.md).
 *
 * A custom connector belongs to exactly one (project, external_user_id): only that user can
 * see it, connect to it or call its tools. Otherwise it behaves like a built-in hosted MCP
 * connector — Connany registers an OAuth client with the server (RFC 7591), keeps the user's
 * tokens, and proxies tool calls — so the connection, session and tool APIs need no changes.
 */
export interface CustomConnectorRow {
  name: CustomConnectorName; workspace_id: string; project_id: string; external_user_id: string;
  url: string; label: string; website: string; spec: McpSpec; created_at: Date;
}
/** At most this many custom servers per user of a project. */
export const MAX_CUSTOM_CONNECTORS = 20;

const escapeXml = (value: string) => value.replace(/[<>&"']/g, ch => `&#${ch.charCodeAt(0)};`);
/** A monogram badge: the server's own icon is not fetched (it would be unvetted content). */
export function monogram(label: string) {
  const letter = [...label].find(ch => /[\p{L}\p{N}]/u.test(ch))?.toUpperCase() || '?';
  return `<svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text x="12" y="16.5" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" font-size="13" font-weight="600" fill="currentColor">${escapeXml(letter)}</text></svg>`;
}
export function definitionOf(row: Pick<CustomConnectorRow, 'label' | 'website' | 'spec'>): ConnectorDefinition {
  const host = new URL(row.website).host;
  return {
    label: row.label, category: 'custom', website: row.website, icon: monogram(row.label),
    description: { 'zh-CN': `自定义 MCP 服务器（${host}）`, en: `Custom MCP server (${host})` },
    auth: 'mcp', mcp: row.spec,
  };
}
export function publicCustomConnector(row: CustomConnectorRow, base: string) {
  return { name: row.name, title: row.label, url: row.url, website: row.website, avatar_url: `${base}/connectors/${row.name}/avatar.svg`, created_at: row.created_at };
}

export class CustomConnectors {
  constructor(private pool: pg.Pool, private runtime: ConnectorRuntime, private vault: Vault) {}
  // Same encryption context as ConnectorStore's app secrets.
  private context(appId: string) { return `provider-app:${appId}`; }

  /** Make a custom connector's definition available to the synchronous catalog lookup. */
  async ensure(name: string, db: pg.Pool | pg.PoolClient = this.pool) {
    if (!isCustomConnector(name) || customDefinitions.has(name)) return;
    const row = (await db.query<CustomConnectorRow>('SELECT * FROM custom_connectors WHERE name=$1', [name])).rows[0];
    if (!row) throw new AppError('connector_not_found', 'Unknown connector.', 404);
    customDefinitions.set(name, definitionOf(row));
  }
  /** The row, when this user of this project owns it. Everyone else gets not_found. */
  async owned(name: string, projectId: string, user: string): Promise<CustomConnectorRow> {
    const row = isCustomConnector(name) ? (await this.pool.query<CustomConnectorRow>('SELECT * FROM custom_connectors WHERE name=$1 AND project_id=$2 AND external_user_id=$3', [name, projectId, user])).rows[0] : undefined;
    if (!row) throw new AppError('connector_not_found', 'Unknown connector.', 404);
    customDefinitions.set(row.name, definitionOf(row));
    return row;
  }
  async list(projectId: string, user: string): Promise<CustomConnectorRow[]> {
    const { rows } = await this.pool.query<CustomConnectorRow>('SELECT * FROM custom_connectors WHERE project_id=$1 AND external_user_id=$2 ORDER BY created_at', [projectId, user]);
    for (const row of rows) customDefinitions.set(row.name, definitionOf(row));
    return rows;
  }

  /**
   * Discover the server, register an OAuth client with it and record it for this user.
   * Adding a URL the user already added returns the existing connector.
   */
  async add(project: { id: string; workspace_id: string }, user: string, url: string): Promise<CustomConnectorRow> {
    const network = this.runtime.network();
    const server = await discoverServer(url, network.fetcher, network.lookup, network.allowFakeIp);
    const name = `mcp_${hash(`${project.id}\n${user}\n${server.url}`).slice(0, 10)}` as CustomConnectorName;
    const existing = (await this.pool.query<CustomConnectorRow>('SELECT * FROM custom_connectors WHERE name=$1', [name])).rows[0];
    if (existing) { customDefinitions.set(name, definitionOf(existing)); return existing; }
    const { rows: [{ count }] } = await this.pool.query('SELECT count(*)::int AS count FROM custom_connectors WHERE project_id=$1 AND external_user_id=$2', [project.id, user]);
    if (count >= MAX_CUSTOM_CONNECTORS) throw new AppError('custom_connector_limit', `At most ${MAX_CUSTOM_CONNECTORS} custom MCP servers per user.`, 409);

    const definition = definitionOf({ label: server.label, website: server.website, spec: server.mcp });
    customDefinitions.set(name, definition);
    let client;
    try { client = await this.runtime.mcp(name).register(this.runtime.callback(name)); }
    catch (error) {
      customDefinitions.delete(name);
      if (error instanceof AppError && error.code !== 'server_not_public' && error.code !== 'server_unreachable') throw new AppError('server_registration_failed', 'The MCP server refused to register Connany as a client.', 422, error.details);
      throw error;
    }
    const appId = id('capp');
    return transaction(this.pool, async db => {
      // Two concurrent adds of the same URL: the first insert wins, the other returns it.
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [name]);
      const raced = (await db.query<CustomConnectorRow>('SELECT * FROM custom_connectors WHERE name=$1', [name])).rows[0];
      if (raced) return raced;
      await db.query('INSERT INTO connector_apps(id,workspace_id,connector,client_id,secret_ciphertext,settings) VALUES($1,$2,$3,$4,$5,$6)',
        [appId, project.workspace_id, name, client.clientId, this.vault.seal(client.clientSecret, this.context(appId)),
          JSON.stringify({ transport: 'mcp', callback_url: this.runtime.callback(name), token_endpoint_auth_method: client.authMethod, requested_auth: server.mcp.clientAuth || 'none' })]);
      await db.query('INSERT INTO connectors(workspace_id,name,active_app_id,enabled) VALUES($1,$2,$3,true)', [project.workspace_id, name, appId]);
      const { rows } = await db.query<CustomConnectorRow>(`INSERT INTO custom_connectors(name,workspace_id,project_id,external_user_id,url,label,website,spec)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [name, project.workspace_id, project.id, user, server.url, server.label, server.website, JSON.stringify(server.mcp)]);
      return rows[0];
    });
  }

  /**
   * Remove a custom connector: revoke and delete the user's connections to it (best effort
   * upstream), then its sessions, tool catalog, OAuth client and record.
   */
  async remove(projectId: string, user: string, name: string) {
    const row = await this.owned(name, projectId, user);
    const { rows: connections } = await this.pool.query('SELECT * FROM connections WHERE project_id=$1 AND external_user_id=$2 AND connector=$3', [projectId, user, row.name]);
    for (const c of connections) {
      if (!c.credential_ciphertext || !c.connector_app_id) continue;
      try {
        const app = (await this.pool.query('SELECT * FROM connector_apps WHERE id=$1', [c.connector_app_id])).rows[0];
        if (!app) continue;
        const runtime = this.runtime.withConfig({ ...this.runtime.config, connectors: { ...this.runtime.config.connectors,
          [row.name]: { clientId: app.client_id, clientSecret: this.vault.open<string>(app.secret_ciphertext, this.context(app.id)), authMethod: app.settings.token_endpoint_auth_method } } });
        await runtime.revoke(row.name, this.vault.open<Credentials>(c.credential_ciphertext, `${c.project_id}:${c.connector}:${c.id}`));
      } catch { /* The local credential is deleted below either way. */ }
    }
    await transaction(this.pool, async db => {
      await db.query('DELETE FROM connect_sessions WHERE connector=$1', [row.name]);
      await db.query('DELETE FROM connections WHERE connector=$1', [row.name]);
      await db.query('DELETE FROM connector_tools WHERE workspace_id=$1 AND connector=$2', [row.workspace_id, row.name]);
      await db.query('DELETE FROM connectors WHERE workspace_id=$1 AND name=$2', [row.workspace_id, row.name]);
      await db.query('DELETE FROM connector_apps WHERE workspace_id=$1 AND connector=$2', [row.workspace_id, row.name]);
      await db.query('DELETE FROM custom_connectors WHERE name=$1', [row.name]);
    });
    customDefinitions.delete(row.name);
    return { name: row.name, removed: true, revoked: connections.filter(c => c.credential_ciphertext).length };
  }

  /** Rows a project's deletion must clear besides those keyed by project_id. */
  async deleteForProject(db: pg.PoolClient, projectId: string) {
    const { rows } = await db.query<{ name: CustomConnectorName; workspace_id: string }>('SELECT name,workspace_id FROM custom_connectors WHERE project_id=$1', [projectId]);
    for (const row of rows) {
      await db.query('DELETE FROM connector_tools WHERE workspace_id=$1 AND connector=$2', [row.workspace_id, row.name]);
      await db.query('DELETE FROM connectors WHERE workspace_id=$1 AND name=$2', [row.workspace_id, row.name]);
      await db.query('DELETE FROM connector_apps WHERE workspace_id=$1 AND connector=$2', [row.workspace_id, row.name]);
      customDefinitions.delete(row.name);
    }
    await db.query('DELETE FROM custom_connectors WHERE project_id=$1', [projectId]);
  }
}
