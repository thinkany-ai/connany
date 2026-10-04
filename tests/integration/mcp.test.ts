import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { createAdmin } from '../../src/admin/auth.js';
import { migrate } from '../../src/db.js';
import { createApp } from '../../src/app.js';
import { Vault } from '../../src/crypto.js';
import { Service } from '../../src/service.js';
import { ConnectorRuntime } from '../../src/connectors/index.js';
import { ensureWorkspace } from '../../src/workspaces.js';
import { config, connectorClients } from '../support.js';
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required');
const schema = `mcp_${randomBytes(8).toString('hex')}`;
const owner = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
let toolLists = 0;
const upstreamCalls: { name: string; arguments: unknown }[] = [];
// Notion's hosted MCP server and authorization server.
const fetcher: typeof fetch = async (url, init) => {
  const u = String(url); const body = String(init?.body || '');
  if (u === 'https://mcp.notion.com/register') return Response.json({ client_id: 'notion-client' }, { status: 201 });
  if (u === 'https://mcp.notion.com/token') return Response.json({ access_token: 'notion-access', refresh_token: 'notion-refresh', expires_in: 3600, user_id: 'notion-user', workspace_id: 'notion-ws' });
  if (u === 'https://mcp.notion.com/mcp') {
    const rpc = JSON.parse(body);
    if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (rpc.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-06-18' } });
    if (rpc.method === 'tools/list') {
      toolLists++;
      return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools: [
        { name: 'notion-search', description: 'Search pages in the workspace', inputSchema: { type: 'object', properties: { query: { type: 'string' } } }, annotations: { readOnlyHint: true } },
        { name: 'notion-create-pages', description: 'Create pages', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
      ] } });
    }
    upstreamCalls.push(rpc.params);
    return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: `${rpc.params.name} done` }] } });
  }
  return Response.json({}, { status: 404 });
};
const service = new Service(pool, new ConnectorRuntime({ ...config, connectors: connectorClients() }, fetcher), new Vault(config.encryptionKey));
const app = createApp(service);
const base = config.publicBaseUrl;
const redirectUri = 'http://localhost:33418/callback';
let cookie = ''; let csrf = ''; let memberId = '';
const challenge = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
const consoleCall = (path: string, body: unknown) => app.request(`${base}/admin${path}`, { method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
const tokenCall = (fields: Record<string, string>) => app.request(`${base}/oauth2/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });
let rpcId = 0;
const mcp = async (token: string, method: string, params: object = {}) => {
  const response = await app.request(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  return { status: response.status, body: await response.json() as any };
};
const tool = async (token: string, name: string, args: object = {}) => {
  const { body } = await mcp(token, 'tools/call', { name, arguments: args });
  const text = body.result.content.map((c: any) => c.text).join('\n');
  return { isError: !!body.result.isError, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};
/** Register a client and run the authorization code flow as the signed-in member. */
async function authorize(clientId: string, port = 33418) {
  const verifier = randomBytes(32).toString('base64url');
  const query = { response_type: 'code', client_id: clientId, redirect_uri: `http://localhost:${port}/callback`, code_challenge: challenge(verifier), code_challenge_method: 'S256', state: 'st-1', resource: `${base}/mcp` };
  const approved = await consoleCall('/api/oauth2/authorize', { decision: 'allow', ...query });
  assert.equal(approved.status, 200);
  const redirect = new URL((await approved.json() as any).redirect_url);
  assert.equal(redirect.searchParams.get('state'), 'st-1'); assert.equal(redirect.searchParams.get('iss'), base);
  return { code: redirect.searchParams.get('code')!, verifier, redirect_uri: query.redirect_uri };
}

before(async () => {
  await owner.query(`CREATE SCHEMA ${schema}`); await migrate(pool);
  // The administrator owns the platform workspace and enables Notion there.
  const admin = await createAdmin(pool, 'admin@example.com', 'admin-password-123');
  await service.connectorStore.in(admin.workspace_id).saveMcp('notion', true, admin.id);
  // A member with an empty workspace of their own.
  const { rows } = await pool.query("INSERT INTO admin_users(id,email,password_hash,role) VALUES('admin_member','member@example.com',(SELECT password_hash FROM admin_users WHERE email='admin@example.com'),'member') RETURNING id,email");
  memberId = rows[0].id; await ensureWorkspace(pool, rows[0]);
  const login = await app.request(`${base}/admin/api/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'member@example.com', password: 'admin-password-123' }) });
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  csrf = (await (await app.request(`${base}/admin`, { headers: { Cookie: cookie } })).text()).match(/name="csrf-token" content="([^"]+)"/)![1];
});
after(async () => { await pool.end(); await owner.query(`DROP SCHEMA ${schema} CASCADE`); await owner.end(); });

test('MCP clients discover Connany\'s OAuth server, register, and are sent to the console to sign in and consent', async () => {
  const anonymous = await app.request(`${base}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) });
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.headers.get('www-authenticate'), `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="connany"`);
  const resource = await (await app.request(`${base}/.well-known/oauth-protected-resource/mcp`)).json() as any;
  assert.deepEqual([resource.resource, resource.authorization_servers], [`${base}/mcp`, [base]]);
  const metadata = await (await app.request(`${base}/.well-known/oauth-authorization-server`)).json() as any;
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256']); assert.equal(metadata.registration_endpoint, `${base}/oauth2/register`);
  const preflight = await app.request(`${base}/mcp`, { method: 'OPTIONS', headers: { Origin: 'http://localhost:6274' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), '*');

  const bad = await app.request(`${base}/oauth2/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/callback'] }) });
  assert.equal(bad.status, 400); assert.equal((await bad.json() as any).error, 'invalid_redirect_uri');
  const registered = await app.request(`${base}/oauth2/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [redirectUri], token_endpoint_auth_method: 'client_secret_basic' }) });
  assert.equal(registered.status, 201);
  const client = await registered.json() as any;
  assert.equal(client.token_endpoint_auth_method, 'none');

  const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'http://localhost:40001/callback', code_challenge: challenge('v'.repeat(43)), code_challenge_method: 'S256', state: 'abc' });
  const start = await app.request(`${base}/oauth2/authorize?${query}`);
  assert.equal(start.headers.get('location'), `/admin/oauth2/authorize?${query}`);
  const signIn = await app.request(`${base}/admin/oauth2/authorize?${query}`);
  assert.equal(signIn.status, 302);
  const next = new URL(signIn.headers.get('location')!, base).searchParams.get('next')!;
  assert.equal(next, `/admin/oauth2/authorize?${query}`);
  assert((await (await app.request(`${base}/admin/login?next=${encodeURIComponent(next)}`)).text()).includes(`data-redirect="${next.replaceAll('&', '&amp;')}"`));
  assert((await (await app.request(`${base}/admin/login?next=${encodeURIComponent('https://evil.example')}`)).text()).includes('data-redirect="/admin"'));
  // Loopback redirect URIs may use another port (RFC 8252); other mismatches are shown, not redirected.
  const consent = await app.request(`${base}/admin/oauth2/authorize?${query}`, { headers: { Cookie: cookie } });
  assert.equal(consent.status, 200); const html = await consent.text();
  assert(html.includes('Claude Code')); assert(html.includes('member@example.com'));
  const mismatch = await app.request(`${base}/admin/oauth2/authorize?${new URLSearchParams({ ...Object.fromEntries(query), redirect_uri: 'https://other.example/cb' })}`, { headers: { Cookie: cookie } });
  assert.equal(mismatch.status, 400);
  const noPkce = await app.request(`${base}/admin/oauth2/authorize?${new URLSearchParams({ ...Object.fromEntries(query), code_challenge_method: 'plain' })}`, { headers: { Cookie: cookie } });
  assert.equal(new URL(noPkce.headers.get('location')!).searchParams.get('error'), 'invalid_request');
  const denied = await consoleCall('/api/oauth2/authorize', { decision: 'deny', ...Object.fromEntries(query) });
  const deniedUrl = new URL((await denied.json() as any).redirect_url);
  assert.deepEqual([deniedUrl.port, deniedUrl.searchParams.get('error'), deniedUrl.searchParams.get('state')], ['40001', 'access_denied', 'abc']);
});

test('codes are single-use and PKCE-bound; refresh tokens rotate; revocation ends access', async () => {
  const client = await (await app.request(`${base}/oauth2/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Codex', redirect_uris: [redirectUri] }) })).json() as any;
  const first = await authorize(client.client_id);
  const wrong = await tokenCall({ grant_type: 'authorization_code', client_id: client.client_id, code: first.code, redirect_uri: first.redirect_uri, code_verifier: 'x'.repeat(43) });
  assert.equal(wrong.status, 400); assert.equal((await wrong.json() as any).error, 'invalid_grant');
  const issued = await tokenCall({ grant_type: 'authorization_code', client_id: client.client_id, code: first.code, redirect_uri: first.redirect_uri, code_verifier: first.verifier });
  assert.equal(issued.status, 200);
  const tokens = await issued.json() as any;
  assert.equal(tokens.token_type, 'Bearer'); assert.match(tokens.access_token, /^cny_at_/);
  assert.equal((await mcp(tokens.access_token, 'ping')).status, 200);
  // Replaying a code revokes what it issued.
  assert.equal((await tokenCall({ grant_type: 'authorization_code', client_id: client.client_id, code: first.code, redirect_uri: first.redirect_uri, code_verifier: first.verifier })).status, 400);
  assert.equal((await mcp(tokens.access_token, 'ping')).status, 401);

  const second = await authorize(client.client_id);
  const pair = await (await tokenCall({ grant_type: 'authorization_code', client_id: client.client_id, code: second.code, redirect_uri: second.redirect_uri, code_verifier: second.verifier })).json() as any;
  const rotated = await (await tokenCall({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: pair.refresh_token })).json() as any;
  assert.notEqual(rotated.refresh_token, pair.refresh_token);
  assert.equal((await mcp(pair.access_token, 'ping')).status, 401);
  assert.equal((await tokenCall({ grant_type: 'refresh_token', client_id: client.client_id, refresh_token: pair.refresh_token })).status, 400);
  assert.equal((await mcp(rotated.access_token, 'ping')).status, 200);
  // The console lists the client; revoking it there (or via RFC 7009) ends access.
  // Authorized clients are listed in the console's settings dialog on every page.
  const page = await (await app.request(`${base}/admin`, { headers: { Cookie: cookie } })).text();
  assert(page.includes('id="settings-apps"')); assert(page.includes('Codex'));
  assert.equal((await app.request(`${base}/admin/mcp`, { headers: { Cookie: cookie } })).headers.get('location'), '/docs/mcp');
  const grant = (await pool.query("SELECT g.id FROM oauth_grants g JOIN oauth_clients c ON c.id=g.client_id WHERE c.client_name='Codex' AND g.revoked_at IS NULL")).rows[0];
  assert.equal((await consoleCall(`/api/mcp/grants/${grant.id}/revoke`, {})).status, 200);
  assert.equal((await mcp(rotated.access_token, 'ping')).status, 401);
  const third = await authorize(client.client_id);
  const last = await (await tokenCall({ grant_type: 'authorization_code', client_id: client.client_id, code: third.code, redirect_uri: third.redirect_uri, code_verifier: third.verifier })).json() as any;
  await app.request(`${base}/oauth2/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `token=${last.refresh_token}` });
  assert.equal((await mcp(last.access_token, 'ping')).status, 401);
});

test('a member connects an account from the agent and calls tools; writes need call_write_tool', async () => {
  const client = await (await app.request(`${base}/oauth2/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: [redirectUri] }) })).json() as any;
  const grant = await authorize(client.client_id);
  const { access_token: token } = await (await tokenCall({ grant_type: 'authorization_code', client_id: client.client_id, code: grant.code, redirect_uri: grant.redirect_uri, code_verifier: grant.verifier })).json() as any;

  const init = await mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18'); assert(init.body.result.instructions.includes('list_connectors'));
  const notification = await app.request(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  assert.equal(notification.status, 202);
  const listed = (await mcp(token, 'tools/list')).body.result.tools;
  assert.deepEqual(listed.map((t: any) => t.name), ['list_connectors', 'connect', 'search_tools', 'describe_tool', 'call_read_tool', 'call_write_tool']);
  assert.equal(listed.find((t: any) => t.name === 'call_write_tool').annotations.destructiveHint, true);
  assert.equal((await mcp(token, 'tools/call', { name: 'nope' })).body.error.code, -32602);

  // Notion comes from the platform workspace: the member has not enabled anything.
  const overview = await tool(token, 'list_connectors');
  assert.deepEqual(overview.json.available_connectors.map((c: any) => [c.name, c.connected]), [['notion', false]]);
  assert.deepEqual(overview.json.connections, []);
  assert((await tool(token, 'search_tools', { query: 'search' })).isError);
  assert((await tool(token, 'connect', { connector: 'linear' })).text.startsWith('connector_not_configured'));

  const link = await tool(token, 'connect', { connector: 'notion' });
  assert(!link.isError); assert(link.json.next_step.includes(link.json.connect_url));
  // The user opens the link and authorizes Notion in the browser.
  const started = await app.request(link.json.connect_url);
  const state = new URL(started.headers.get('location')!).searchParams.get('state')!;
  const callback = await app.request(`${base}/oauth/notion/callback?state=${state}&code=ok`, { headers: { Cookie: started.headers.get('set-cookie')!.split(';')[0] } });
  assert.equal(callback.status, 200);
  const connected = await tool(token, 'list_connectors');
  assert.equal(connected.json.connections.length, 1); assert.equal(connected.json.available_connectors[0].connected, true);
  const project = (await pool.query("SELECT p.kind,p.workspace_id,c.external_user_id FROM connections c JOIN projects p ON p.id=c.project_id")).rows[0];
  assert.equal(project.kind, 'personal'); assert.equal(project.external_user_id, memberId); assert.notEqual(project.workspace_id, 'ws_default');

  const found = await tool(token, 'search_tools', { query: 'search pages' });
  assert.deepEqual(found.json.tools.map((t: any) => [t.name, t.read_only]), [['notion.notion-search', true], ['notion.notion-create-pages', false]]);
  const described = await tool(token, 'describe_tool', { name: 'notion.notion-search' });
  assert.deepEqual(described.json.input_schema.properties, { query: { type: 'string' } }); assert.equal(described.json.call_with, 'call_read_tool');
  const lists = toolLists;
  const read = await tool(token, 'call_read_tool', { name: 'notion.notion-search', arguments: { query: 'roadmap' } });
  assert.deepEqual([read.isError, read.text], [false, 'notion-search done']);
  assert.equal(toolLists, lists, 'cataloged tools are called without listing upstream tools again');
  const refused = await tool(token, 'call_read_tool', { name: 'notion.notion-create-pages', arguments: { title: 'x' } });
  assert(refused.isError); assert(refused.text.includes('call_write_tool'));
  assert(!upstreamCalls.some(c => c.name === 'notion-create-pages'));
  const written = await tool(token, 'call_write_tool', { name: 'notion.notion-create-pages', arguments: { title: 'Plan' } });
  assert.deepEqual([written.isError, written.text], [false, 'notion-create-pages done']);
  assert.deepEqual(upstreamCalls.at(-1), { name: 'notion-create-pages', arguments: { title: 'Plan' } });
  assert((await tool(token, 'call_read_tool', { name: 'notion.__discover' })).isError);
  assert((await tool(token, 'call_read_tool', { name: 'notion.notion-search', connection_id: 'conn_other' })).isError);

  // The personal project shows up in the member's connections but not in their project list.
  assert((await (await app.request(`${base}/admin/connections`, { headers: { Cookie: cookie } })).text()).includes('个人 MCP'));
  assert(!(await (await app.request(`${base}/admin/projects`, { headers: { Cookie: cookie } })).text()).includes('个人 MCP'));
  // Other users' tokens never see this connection.
  const skill = await app.request(`${base}/skills/connany/SKILL.md`);
  assert((await skill.text()).includes(`claude mcp add --transport http connany ${base}/mcp`));
});
