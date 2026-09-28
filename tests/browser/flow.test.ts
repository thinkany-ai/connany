import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serve } from '@hono/node-server';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { config } from '../support.js';
import { createApp } from '../../src/app.js';
import { Service } from '../../src/service.js';
import { Providers } from '../../src/providers/index.js';
import { Vault, hash } from '../../src/crypto.js';
import { migrate } from '../../src/db.js';
import { Connany } from '../../sdk/client.js';

test('real browser follows all three OAuth flows, keeps binding cookie, and returns to agent', { timeout: 60000 }, async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
  const schema = `browser_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const runtimeConfig = { ...config };
  let hasInstallation = true;
  const fakeFetch: typeof fetch = async (url,init) => {
    const path = String(url);
    if (path === 'https://mcp.notion.com/token' || path === 'https://mcp.linear.app/token' || path.includes('/oauth/token') || path.includes('/login/oauth/access_token')) return Response.json({ access_token: 'test', refresh_token: 'refresh', workspace_id: 'workspace', workspace_name: 'Test workspace', user_id:'user',bot_id: 'bot' });
    if(path === 'https://mcp.linear.app/mcp') {
      const rpc=JSON.parse(String(init?.body));
      if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
      const result=rpc.method==='initialize'?{protocolVersion:'2025-03-26'}:rpc.method==='tools/list'?{tools:[{name:'get_user',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:JSON.stringify({id:'linear-user',name:'Alice'})}]};
      return Response.json({jsonrpc:'2.0',id:rpc.id,result});
    }
    if (path.endsWith('/user')) return Response.json({ id: 1, login: 'test-user' });
    if (path.includes('/user/installations')) return Response.json({ total_count: hasInstallation ? 1 : 0, installations: hasInstallation ? [{ id: 5, account: { login: 'test-user' } }] : [] });
    return Response.json({ data: { viewer: { id: 'user', name: 'Test user' }, organization: { id: 'workspace', name: 'Test workspace' } } });
  };
  const providers = new Providers(runtimeConfig, fakeFetch);
  const originalAuthorize = Providers.prototype.authorizeUrl;
  const originalInstall = Providers.prototype.installUrl;
  Providers.prototype.authorizeUrl = function(...args) { const url = new URL(originalAuthorize.apply(this,args)); return `${runtimeConfig.publicBaseUrl}/mock-authorize${url.search}`; };
  Providers.prototype.installUrl = () => `${runtimeConfig.publicBaseUrl}/mock-install`;
  const app = createApp(new Service(pool, providers, new Vault(config.encryptionKey)));
  app.get('/mock-authorize', c => { const callback = new URL(c.req.query('redirect_uri')!); callback.searchParams.set('state',c.req.query('state')!); callback.searchParams.set('code','test-code'); return c.html(`<a href="${callback.toString().replaceAll('&','&amp;')}">Approve test authorization</a>`); });
  app.get('/mock-install', c => c.html('<h1>Choose repositories</h1>'));
  app.get('/agent-return', c => c.html('<h1>Returned to agent</h1>'));
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.listening ? resolve() : server.once('listening', () => resolve()));
  const address = server.address();
  assert(address && typeof address !== 'string');
  runtimeConfig.publicBaseUrl = `http://127.0.0.1:${address.port}`;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
    await admin.query(`CREATE SCHEMA ${schema}`); await migrate(pool);
    await pool.query("INSERT INTO provider_apps(id,provider,client_id,secret_ciphertext,settings) VALUES('mcp','notion','mcp-client',$1,'{\"transport\":\"mcp\"}')",[new Vault(config.encryptionKey).seal('','provider-app:mcp')]);
    await pool.query("INSERT INTO provider_settings(provider,active_app_id) VALUES('notion','mcp')");
    await pool.query("INSERT INTO provider_apps(id,provider,client_id,secret_ciphertext,settings) VALUES('linear-mcp','linear','linear-client',$1,'{\"transport\":\"mcp\"}')",[new Vault(config.encryptionKey).seal('','provider-app:linear-mcp')]);
    await pool.query("INSERT INTO provider_settings(provider,active_app_id) VALUES('linear','linear-mcp')");
    const returnUrl = `${runtimeConfig.publicBaseUrl}/agent-return`;
    await pool.query('INSERT INTO projects(id,name,api_key_hash,return_urls) VALUES($1,$2,$3,$4)', ['browser','Example agent',hash('browser-key'),JSON.stringify([returnUrl])]);
    const sdk = new Connany({ baseUrl: runtimeConfig.publicBaseUrl, apiKey: 'browser-key' });
    const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(10000);
    page.on('console', message => { if (message.type() === 'error') console.error('Browser:', message.text()); });
    await mkdir('artifacts', { recursive: true });
    for (const provider of ['notion','github','linear'] as const) {
      const session = await sdk.createSession({ external_user_id: 'browser-user', provider, return_url: returnUrl });
      await page.goto(session.connect_url);
      await page.getByRole('link', { name: 'Approve test authorization' }).click();
      await page.getByRole('heading', { name: 'Returned to agent' }).waitFor();
      const status = await sdk.getSession(session.id, 'browser-user');
      assert.equal(status.status, 'connected');
      await page.getByRole('heading', { name: 'Returned to agent' }).waitFor();
      assert.equal(new URL(page.url()).searchParams.get('connany_session_id'), session.id);
    }
    hasInstallation = false;
    const installSession = await sdk.createSession({external_user_id:'new-github-user',provider:'github'});
    await page.goto(installSession.connect_url);
    await page.getByRole('link',{name:'Approve test authorization'}).click();
    await page.getByRole('heading',{name:'账号已连接'}).waitFor();
    assert(page.url().includes('/oauth/github/callback'));
    const completed = await sdk.getSession(installSession.id,'new-github-user');
    const installations = await sdk.githubInstallations(completed.connection_id!,'new-github-user');
    assert.equal(installations.total_count,0);
    assert.equal(installations.data.length,0);
    assert.equal(installations.installation_url,`${runtimeConfig.publicBaseUrl}/mock-install`);
    await assert.rejects(()=>sdk.githubInstallations(completed.connection_id!,'other-user'));
    await page.getByRole('link',{name:'添加组织 / 仓库 ↗'}).click();
    assert.equal((await sdk.getSession(installSession.id,'new-github-user')).status,'connected');
  } finally {
    Providers.prototype.authorizeUrl = originalAuthorize; Providers.prototype.installUrl = originalInstall;
    await browser?.close(); await new Promise<void>((resolve,reject) => server.close(e=>e ? reject(e) : resolve()));
    await pool.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end();
  }
});
