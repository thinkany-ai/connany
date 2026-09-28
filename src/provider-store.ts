import type pg from 'pg';
import { z } from 'zod';
import type { Config, ProviderName } from './config.js';
import { providerNames } from './config.js';
import { provider as providerSpec } from './providers/catalog.js';
import { Vault, id } from './crypto.js';
import { transaction } from './db.js';
import { AppError } from './errors.js';
import { Providers } from './providers/index.js';

export const providerInput = z.object({
  client_id: z.string().trim().min(1).max(300), client_secret: z.string().max(2000).default(''),
  github_app_slug: z.string().trim().max(100).default(''), enabled: z.boolean(),
}).strict();
export interface ProviderView {
  name: ProviderName; configured: boolean; enabled: boolean; client_id: string;
  has_secret: boolean; github_app_slug: string; callback_url: string; installation_url?: string; updated_at: Date | null;
}
export class ProviderStore {
  constructor(public pool: pg.Pool, public base: Providers, private vault: Vault) {}
  private context(appId: string) { return `provider-app:${appId}`; }
  /** Import legacy env credentials only once. Database settings win after initial import. */
  async bootstrap() {
    await transaction(this.pool, async db => {
      await db.query('SELECT pg_advisory_xact_lock(804217332)');
      for (const name of providerNames) {
        if (providerSpec(name).auth !== 'github_app') continue;
        const env = this.base.config.providers[name];
        if (!env.clientId) continue;
        let app = (await db.query('SELECT id FROM provider_apps WHERE provider=$1 AND client_id=$2', [name, env.clientId])).rows[0];
        const hasSettings = !!(await db.query('SELECT 1 FROM provider_settings WHERE provider=$1', [name])).rowCount;
        if (!app && !hasSettings) {
          const appId = id('pa');
          app = (await db.query('INSERT INTO provider_apps(id,provider,client_id,secret_ciphertext,settings) VALUES($1,$2,$3,$4,$5) RETURNING id', [appId, name, env.clientId, this.vault.seal(env.clientSecret, this.context(appId)), JSON.stringify({ github_app_slug: name === 'github' ? this.base.config.githubAppSlug : '' })])).rows[0];
        }
        if (!app) continue;
        await db.query('INSERT INTO provider_settings(provider,active_app_id) VALUES($1,$2) ON CONFLICT(provider) DO NOTHING', [name, app.id]);
        // Bind legacy tokens only to the matching legacy env app, never to a new default app.
        await db.query('UPDATE connections SET provider_app_id=$1 WHERE provider=$2 AND provider_app_id IS NULL', [app.id, name]);
        await db.query('UPDATE connect_sessions SET provider_app_id=$1 WHERE provider=$2 AND provider_app_id IS NULL', [app.id, name]);
      }
    });
  }
  async list(): Promise<ProviderView[]> {
    const { rows } = await this.pool.query(`SELECT s.provider,s.enabled,s.updated_at,a.id,a.client_id,a.settings FROM provider_settings s LEFT JOIN provider_apps a ON a.id=s.active_app_id`);
    return providerNames.map(name => {
      const r = rows.find(r => r.provider === name);
      if (providerSpec(name).auth === 'mcp' && r?.settings?.transport !== 'mcp') return {name,configured:false,enabled:false,client_id:'',has_secret:false,github_app_slug:'',callback_url:this.base.callback(name),updated_at:null};
      const slug = r?.settings?.github_app_slug || '';
      return { name, configured: !!r?.id, enabled: !!r?.id && r.enabled, client_id: r?.client_id || '', has_secret: !!r?.id,
        github_app_slug: slug, callback_url: this.base.callback(name), updated_at: r?.updated_at || null,
        ...(name === 'github' && slug ? { installation_url: `https://github.com/apps/${slug}/installations/new` } : {}) };
    });
  }
  async saveMcp(name: ProviderName, enabled: boolean, adminId: string) {
    if (providerSpec(name).auth !== 'mcp') throw new AppError('github_app_required', 'Configure a GitHub App for OAuth.');
    await transaction(this.pool, async db => {
      await db.query('SELECT pg_advisory_xact_lock(804217332)');
      const existing = (await db.query("SELECT a.* FROM provider_settings s JOIN provider_apps a ON a.id=s.active_app_id WHERE s.provider=$1",[name])).rows[0];
      let appId = existing?.settings?.transport === 'mcp' && existing.settings.callback_url === this.base.callback(name) ? existing.id : null;
      if (!appId && enabled) {
        const clientId = await this.base.mcp(name).register(this.base.callback(name));
        appId = id('pa');
        await db.query("INSERT INTO provider_apps(id,provider,client_id,secret_ciphertext,settings) VALUES($1,$5,$2,$3,$4)", [appId,clientId,this.vault.seal('',this.context(appId)),JSON.stringify({transport:'mcp',callback_url:this.base.callback(name)}),name]);
      }
      await db.query("INSERT INTO provider_settings(provider,active_app_id,enabled) VALUES($3,$1,$2) ON CONFLICT(provider) DO UPDATE SET active_app_id=EXCLUDED.active_app_id,enabled=EXCLUDED.enabled,updated_at=now()",[appId,enabled,name]);
      await db.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$3)',[adminId,'provider.saved',name]);
    });
  }
  async save(name: ProviderName, input: z.infer<typeof providerInput>, adminId: string) {
    if (providerSpec(name).auth !== 'github_app') throw new AppError(`use_${name}_mcp`, 'Use official MCP registration.');
    if (name === 'github' && !/^[a-zA-Z0-9-]+$/.test(input.github_app_slug)) throw new AppError('invalid_slug', '请填写 GitHub App slug。');
    await transaction(this.pool, async db => {
      await db.query('SELECT pg_advisory_xact_lock(804217332)');
      const existing = (await db.query('SELECT * FROM provider_apps WHERE provider=$1 AND client_id=$2 FOR UPDATE', [name, input.client_id])).rows[0];
      if (!existing && !input.client_secret.trim()) throw new AppError('secret_required', '首次配置或更换 Client ID 时必须填写 Client Secret。');
      if (input.client_secret && !input.client_secret.trim()) throw new AppError('secret_required', 'Client Secret 不能为空白字符。');
      const appId = existing?.id || id('pa');
      const ciphertext = input.client_secret ? this.vault.seal(input.client_secret, this.context(appId)) : existing.secret_ciphertext;
      const settings = JSON.stringify({ github_app_slug: name === 'github' ? input.github_app_slug : '' });
      await db.query(`INSERT INTO provider_apps(id,provider,client_id,secret_ciphertext,settings) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(provider,client_id) DO UPDATE SET secret_ciphertext=EXCLUDED.secret_ciphertext,settings=EXCLUDED.settings,updated_at=now()`, [appId, name, input.client_id, ciphertext, settings]);
      await db.query(`INSERT INTO provider_settings(provider,active_app_id,enabled) VALUES($1,$2,$3)
        ON CONFLICT(provider) DO UPDATE SET active_app_id=EXCLUDED.active_app_id,enabled=EXCLUDED.enabled,updated_at=now()`, [name, appId, input.enabled]);
      await db.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$3)', [adminId, 'provider.saved', name]);
    });
  }
  /** Pause or resume an already configured provider without touching its credentials. */
  async setEnabled(name: ProviderName, enabled: boolean, adminId: string) {
    await transaction(this.pool, async db => {
      const { rowCount } = await db.query('UPDATE provider_settings SET enabled=$2,updated_at=now() WHERE provider=$1 AND active_app_id IS NOT NULL', [name, enabled]);
      if (!rowCount) throw new AppError('provider_not_configured', '请先配置应用凭证。', 409);
      await db.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$3)', [adminId, 'provider.saved', name]);
    });
  }
  async active(name: ProviderName) {
    const { rows } = await this.pool.query('SELECT active_app_id FROM provider_settings WHERE provider=$1 AND enabled=true', [name]);
    if (!rows[0]?.active_app_id) throw new AppError('provider_not_configured', 'This provider is not accepting new connections.', 503);
    return { appId: rows[0].active_app_id as string, providers: await this.resolve(name, rows[0].active_app_id) };
  }
  async resolve(name: ProviderName, appId: string | null | undefined, db: pg.Pool | pg.PoolClient = this.pool) {
    if (!appId && providerSpec(name).auth === 'mcp') throw new AppError('reauth_required', 'Create a new MCP connection.', 409);
    if (!appId) {
      if (this.base.enabled(name)) return this.base;
      throw new AppError('provider_not_configured', 'Restore the original OAuth app credentials for this legacy connection.', 503);
    }
    const { rows } = await db.query('SELECT * FROM provider_apps WHERE id=$1 AND provider=$2', [appId, name]);
    const app = rows[0];
    if (!app) throw new AppError('provider_not_configured', 'OAuth app configuration not found.', 503);
    if (providerSpec(name).auth === 'mcp' && app.settings.transport !== 'mcp') throw new AppError('reauth_required', 'Create a new MCP connection.', 409);
    const config: Config = { ...this.base.config, providers: { ...this.base.config.providers,
      [name]: { clientId: app.client_id, clientSecret: this.vault.open<string>(app.secret_ciphertext, this.context(app.id)) } },
      ...(name === 'github' ? { githubAppSlug: app.settings.github_app_slug } : {}) };
    return this.base.withConfig(config);
  }
}
