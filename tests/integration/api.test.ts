import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { migrate } from '../../src/db.js';
import { createApp } from '../../src/app.js';
import { Vault, hash } from '../../src/crypto.js';
import { Service } from '../../src/service.js';
import { ConnectorRuntime } from '../../src/connectors/index.js';
import { config } from '../support.js';
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required. Tests create and remove an isolated schema.');
const schema = `test_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
let refreshCount = 0;
let failAction = false;
let rejectRefresh = false;
let failRevoke = false;
let tokenRevocations = 0;
let seenSecrets: string[] = [];
const fetcher: typeof fetch = async (url, init) => {
  const u = String(url); const body = String(init?.body || '');
  const headers = new Headers(init?.headers);
  seenSecrets.push(headers.get('Authorization') || '');
  if ((u === 'https://mcp.notion.com/token' || u === 'https://mcp.linear.app/token') && !new URLSearchParams(body).has('grant_type')) { tokenRevocations++; return Response.json({}, {status:failRevoke?503:200}); }
  if (u === 'https://mcp.notion.com/mcp' || u === 'https://mcp.linear.app/mcp') {
    if(JSON.parse(body).method==='tools/call' && JSON.parse(body).params.name==='get_user')return Response.json({jsonrpc:'2.0',id:JSON.parse(body).id,result:{content:[{type:'text',text:JSON.stringify({id:'linear-user',name:'Alice'})}]}});
    if(failAction)return Response.json({}, {status:503});
    const rpc=JSON.parse(body);
    if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
    const result=rpc.method==='initialize'?{protocolVersion:'2025-03-26'}:rpc.method==='tools/list'?{tools:[{name:u.includes('linear')?'get_user':'notion-search',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]}:{content:[{type:'text',text:'found'}]};
    return Response.json({jsonrpc:'2.0',id:rpc.id,result});
  }
  if (u.includes('/oauth/revoke') || (u.includes('/applications/') && init?.method === 'DELETE')) {
    return Response.json({}, { status: failRevoke ? 503 : 200 });
  }
  if ((u === 'https://mcp.notion.com/token' || u === 'https://mcp.linear.app/token') || u.includes('/oauth/token') || u.includes('/login/oauth/access_token')) {
    const fields = headers.get('Content-Type') === 'application/json' ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
    if (fields.grant_type === 'refresh_token') {
      refreshCount++;
      await new Promise(resolve => setTimeout(resolve, 20));
      if (rejectRefresh) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 3600 });
    }
    return Response.json({ access_token: 'secret-access', refresh_token: 'secret-refresh', expires_in: 3600, user_id:'notion-user',bot_id: 'bot', workspace_id: 'notion-workspace', workspace_name: 'Workspace', owner: { user: { id: 'notion-user', name: 'Alice' } } });
  }
  if (u.endsWith('/user')) return Response.json({ id: 42, login: 'alice' });
  if (u.includes('/user/installations/')) return Response.json({ repositories: [{ id: 1, name: 'private-project' }], total_count: 1 });
  if (u.includes('/user/installations')) return Response.json({ installations: [{ id: 99, account: { login: 'alice' } }], total_count: 1 });
  if (u.endsWith('/graphql')) {
    if (body.includes('ConnanyIdentity')) return Response.json({ data: { viewer: { id: 'linear-user', name: 'Alice' }, organization: { id: 'linear-workspace', name: 'Work' } } });
    return Response.json({ data: { teams: { nodes: [{ id: 'team', name: 'Engineering' }], pageInfo: { hasNextPage: false, endCursor: null } } } });
  }
  if (failAction) return Response.json({}, { status: 503 });
  return Response.json({ results: [{ id: 'page', object: 'page' }], has_more: false, next_cursor: null });
};
const vault = new Vault(config.encryptionKey);
const service = new Service(pool, new ConnectorRuntime(config, fetcher), vault);
const app = createApp(service);
const api = (path: string, method = 'GET', body?: unknown, key = 'key-a') => app.request(`http://localhost:3000${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await pool.query("INSERT INTO connector_apps(id,connector,client_id,secret_ciphertext,settings) VALUES('notion-app','notion','mcp-client',$1,'{\"transport\":\"mcp\"}')",[vault.seal('', 'provider-app:notion-app')]);
  await pool.query("INSERT INTO connectors(name,active_app_id) VALUES('notion','notion-app')");
  await pool.query("INSERT INTO connector_apps(id,connector,client_id,secret_ciphertext,settings) VALUES('linear-app','linear','linear-client',$1,'{\"transport\":\"mcp\"}')",[vault.seal('', 'provider-app:linear-app')]);
  await pool.query("INSERT INTO connectors(name,active_app_id) VALUES('linear','linear-app')");
  await pool.query('INSERT INTO projects(id,name,return_urls) VALUES($1,$2,$3),($4,$5,$6)', ['a','Agent A',JSON.stringify(['http://localhost:3001/done']),'b','Agent B','[]']);
  await pool.query("INSERT INTO api_keys(id,project_id,key_hash,key_prefix) VALUES('key_a','a',$1,'cn_live_a'),('key_b','b',$2,'cn_live_b')", [hash('key-a'),hash('key-b')]);
});
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function start(connector = 'notion', user = 'user-1') {
  const created = await api(`/v1/connectors/${connector}/sessions`, 'POST', { external_user_id: user, return_url: 'http://localhost:3001/done' });
  assert.equal(created.status, 201); const session = await created.json() as any;
  const launch = await app.request(session.connect_url);
  assert.equal(launch.status, 302);
  const cookie = launch.headers.get('set-cookie')!.split(';')[0];
  const state = new URL(launch.headers.get('location')!).searchParams.get('state');
  return { session, cookie, callback: `http://localhost:3000/oauth/${connector}/callback?state=${state}&code=code` };
}
async function connect(connector = 'notion', user = 'user-1') {
  const flow = await start(connector, user);
  const result = await app.request(flow.callback, { headers: { Cookie: flow.cookie } }); assert.equal(result.status, 302);
  assert.equal(new URL(result.headers.get('location')!).origin, 'http://localhost:3001');
  const state = await (await api(`/v1/connectors/${connector}/sessions/${flow.session.id}?external_user_id=${user}`)).json() as any;
  assert.equal(state.status, 'connected');
  return { ...flow, id: state.connection_id };
}
test('full OAuth callback round trips for Notion, GitHub and Linear; tokens remain encrypted', async () => {
  for (const connector of ['notion','github','linear']) {
    const flow = await connect(connector);
    const response = await api(`/v1/connections/${flow.id}?external_user_id=user-1`);
    const text = await response.text(); assert(!text.includes('secret-access')); assert(!text.includes('ciphertext'));
    const { rows } = await pool.query('SELECT * FROM connections WHERE id=$1', [flow.id]);
    assert(!rows[0].credential_ciphertext.includes('secret-access'));
    assert.equal((vault.open<any>(rows[0].credential_ciphertext, service.context(rows[0]))).accessToken, 'secret-access');
    assert.equal((await app.request(flow.callback, { headers: { Cookie: flow.cookie } })).status, 400);
  }
});
test('browser binding, connector binding, denial, origin and return URL checks', async () => {
  // Return URLs come from the key holder per request; only unsafe forms are rejected.
  for (const url of ['https://unregistered.example/done','http://localhost:49152/callback','http://[::1]:8787/callback','myapp://oauth/callback'])
    assert.equal((await api('/v1/connectors/notion/sessions','POST',{ external_user_id:'u',return_url:url })).status,201,url);
  for (const url of ['http://evil.example/done','javascript:alert(1)','data:text/html,hi','https://user:pass@a.example/','https://a.example/#x'])
    assert.equal((await api('/v1/connectors/notion/sessions','POST',{ external_user_id:'u',return_url:url })).status,400,url);
  const flow = await start('notion','browser-user');
  assert.equal((await app.request(flow.callback)).status,400);
  assert.equal((await app.request(flow.callback.replace('/notion/', '/github/'), { headers: { Cookie: flow.cookie } })).status,400);
  const denied = flow.callback.replace('&code=code','&error=access_denied');
  // With a return_url, a denied authorization returns to the agent with the outcome.
  const deniedResponse = await app.request(denied,{headers:{Cookie:flow.cookie}});
  assert.equal(deniedResponse.status,302);
  const deniedLocation = new URL(deniedResponse.headers.get('location')!);
  assert.equal(deniedLocation.origin,'http://localhost:3001');
  assert.equal(deniedLocation.searchParams.get('connany_session_id'),flow.session.id);
  assert.equal(deniedLocation.searchParams.get('connany_status'),'error');
  assert.equal(deniedLocation.searchParams.get('connany_error'),'access_denied');
  const status = await (await api(`/v1/connectors/notion/sessions/${flow.session.id}?external_user_id=browser-user`)).json() as any;
  assert.equal(status.error_code,'access_denied');
  const created = await (await api('/v1/connectors/notion/sessions','POST',{external_user_id:'u'})).json() as any;
  assert.equal((await app.request(`${created.connect_url}/start`,{method:'POST',headers:{Origin:'https://evil.example'}})).status,403);
});
test('tenant and end-user isolation applies to reads, actions, sessions and disconnect', async () => {
  const flow = await connect('notion','isolated');
  for (const [key,user] of [['key-b','isolated'],['key-a','other']]) {
    for (const method of ['GET','DELETE']) assert.equal((await api(`/v1/connections/${flow.id}?external_user_id=${user}`,method,undefined,key)).status,404);
    assert.equal((await api(`/v1/connectors/notion/sessions/${flow.session.id}?external_user_id=${user}`,'GET',undefined,key)).status,404);
    assert.equal((await api(`/v1/connections/${flow.id}/tools/notion.notion-search/call`,'POST',{external_user_id:user,input:{}},key)).status,404);
  }
  assert.equal((await api('/v1/connections?external_user_id=isolated','GET',undefined,'bad-key')).status,401);
  assert.equal((await api(`/v1/connections/${flow.id}`)).status,400);
});
test('one concurrent refresh across workers, and action failure preserves rotated credentials', async () => {
  const flow = await connect('notion','refresh-user');
  const expire = async () => {
    const c = await service.getConnection('a','refresh-user',flow.id);
    const cred = vault.open<any>(c.credential_ciphertext!,service.context(c)); cred.expiresAt = new Date(0).toISOString();
    await pool.query('UPDATE connections SET credential_ciphertext=$1 WHERE id=$2',[vault.seal(cred,service.context(c)),c.id]);
  };
  await expire(); refreshCount=0;
  const execute = () => api(`/v1/connections/${flow.id}/tools/notion.notion-search/call`,'POST',{external_user_id:'refresh-user',input:{}});
  const responses = await Promise.all([execute(),execute(),execute()]);
  assert(responses.every(r => r.status===200)); assert.equal(refreshCount,1);
  await expire(); failAction=true;
  try { assert.equal((await execute()).status,502); } finally { failAction=false; }
  const c = await service.getConnection('a','refresh-user',flow.id);
  const cred = vault.open<any>(c.credential_ciphertext!,service.context(c));
  assert.equal(cred.refreshToken,'rotated-refresh'); assert(Date.parse(cred.expiresAt)>Date.now());
  assert(seenSecrets.includes('Bearer rotated-access'));
});
test('invalid refresh requires reauthorization; reconnect preserves connection ID', async () => {
  const flow = await connect('notion','reauth-user');
  const c = await service.getConnection('a','reauth-user',flow.id);
  const cred = vault.open<any>(c.credential_ciphertext!,service.context(c)); cred.expiresAt = new Date(0).toISOString();
  await pool.query('UPDATE connections SET credential_ciphertext=$1 WHERE id=$2',[vault.seal(cred,service.context(c)),c.id]);
  rejectRefresh=true;
  try { assert.equal((await api(`/v1/connections/${flow.id}/tools/notion.notion-search/call`,'POST',{external_user_id:'reauth-user',input:{}})).status,409); } finally { rejectRefresh=false; }
  assert.equal((await service.getConnection('a','reauth-user',flow.id)).status,'reauth_required');
  const reconnect = await (await api(`/v1/connections/${flow.id}/reconnect`,'POST',{external_user_id:'reauth-user'})).json() as any;
  const launch = await app.request(`${reconnect.connect_url}/start`,{method:'POST',headers:{Origin:config.publicBaseUrl}});
  const state = new URL(launch.headers.get('refresh')!.slice(6)).searchParams.get('state');
  assert.equal((await app.request(`http://localhost:3000/oauth/notion/callback?state=${state}&code=x`,{headers:{Cookie:launch.headers.get('set-cookie')!.split(';')[0]}})).status,200);
  assert.equal((await service.getConnection('a','reauth-user',flow.id)).status,'connected');
});
test('disconnect blocks actions even when connector revocation fails and can be retried', async () => {
  const flow = await connect('notion','disconnect-user'); failRevoke=true;
  let body: any;
  try { body=await (await api(`/v1/connections/${flow.id}?external_user_id=disconnect-user`,'DELETE')).json(); } finally { failRevoke=false; }
  assert.equal(body.status,'revoked'); assert.equal(body.revocation_status,'failed');
  assert.equal((await api(`/v1/connections/${flow.id}/tools/notion.notion-search/call`,'POST',{external_user_id:'disconnect-user',input:{}})).status,409);
  body=await (await api(`/v1/connections/${flow.id}?external_user_id=disconnect-user`,'DELETE')).json();
  assert.equal(body.revocation_status,'succeeded');
  assert.equal((await service.getConnection('a','disconnect-user',flow.id)).credential_ciphertext,null);
});
test('expired sessions, action schemas and connector mismatch are rejected', async () => {
  const s = await (await api('/v1/connectors/notion/sessions','POST',{external_user_id:'expired'})).json() as any;
  await pool.query("UPDATE connect_sessions SET expires_at=now()-interval '1 minute' WHERE id=$1",[s.id]);
  assert.equal((await app.request(s.connect_url)).status,410);
  const state = await (await api(`/v1/connectors/notion/sessions/${s.id}?external_user_id=expired`)).json() as any; assert.equal(state.status,'expired');
  assert.equal((await api(`/v1/connectors/github/sessions/${s.id}?external_user_id=expired`)).status,404);
  assert.equal((await api(`/v1/connectors/github/sessions/${s.id}?external_user_id=expired`)).status,404);
  const flow=await connect('notion','schemas');
  assert.equal((await api(`/v1/connections/${flow.id}/tools/notion.search/call`,'POST',{external_user_id:'schemas',input:{limit:1000}})).status,400);
  assert.equal((await api(`/v1/connections/${flow.id}/tools/linear.teams.list/call`,'POST',{external_user_id:'schemas',input:{}})).status,400);
});
test('connection filters paginate within owner and connector; checks use the normal lifecycle', async () => {
  const user='filtered-connections';
  const notion=await connect('notion',user);
  const github=await connect('github',user);
  await connect('linear',user);
  await pool.query("UPDATE connections SET status='revoked' WHERE id=$1",[github.id]);
  const list=async(query:string,key='key-a')=>{
    const response=await api(`/v1/connections?external_user_id=${user}&${query}`,'GET',undefined,key);
    assert.equal(response.status,200);return response.json() as Promise<any>;
  };
  const onlyNotion=await list('connector=notion&status=connected');
  assert.deepEqual(onlyNotion.data.map((c:any)=>c.id),[notion.id]);
  const revoked=await list('status=revoked');assert.deepEqual(revoked.data.map((c:any)=>c.id),[github.id]);
  const first=await list('status=connected&limit=1');assert.equal(first.data.length,1);assert(first.next_cursor);
  const second=await list(`status=connected&limit=1&after=${first.next_cursor}`);
  assert.equal(second.data.length,1);assert.notEqual(first.data[0].id,second.data[0].id);assert.equal(second.next_cursor,null);
  assert.equal((await list('connector=notion','key-b')).data.length,0);
  const checked=await api(`/v1/connections/${notion.id}/check`,'POST',{external_user_id:user});
  assert.equal(checked.status,200);assert.equal((await checked.json() as any).tool_count,1);
  assert.equal((await api(`/v1/connections/${notion.id}/check`,'POST',{external_user_id:user},'key-b')).status,404);
  assert.equal((await api(`/v1/connections/${github.id}/check`,'POST',{external_user_id:user})).status,409);
});
test('events are scoped and rate limiting is persisted per project', async () => {
  const events = await (await api('/v1/events?external_user_id=refresh-user')).json() as any;
  assert(events.data.some((e:any)=>e.type==='tool.succeeded'));
  const other=await (await api('/v1/events?external_user_id=refresh-user','GET',undefined,'key-b')).json() as any; assert.equal(other.data.length,0);
  // One project-wide feed covers every user; each event names its user, and filters narrow it.
  const all = await (await api('/v1/events?limit=100')).json() as any;
  assert(new Set(all.data.map((e: any) => e.external_user_id)).size > 1);
  assert(all.data.every((e: any, i: number) => i === 0 || BigInt(e.seq) > BigInt(all.data[i - 1].seq)));
  const failures = await (await api('/v1/events?type=tool.failed')).json() as any;
  assert(failures.data.length && failures.data.every((e: any) => e.type === 'tool.failed'));
  const one = all.data.find((e: any) => e.connection_id);
  const byConnection = await (await api(`/v1/events?connection_id=${one.connection_id}`)).json() as any;
  assert(byConnection.data.every((e: any) => e.connection_id === one.connection_id));
  const page = await (await api('/v1/events?limit=2')).json() as any;
  const next = await (await api(`/v1/events?limit=2&after=${page.next_cursor}`)).json() as any;
  assert.equal(next.data[0].seq, all.data[2].seq);
  assert.equal((await api('/v1/events?type=DROP')).status, 400);
  await pool.query("INSERT INTO rate_limits(project_id,window_start,count) VALUES('b',date_trunc('minute',now()),120) ON CONFLICT(project_id) DO UPDATE SET count=120,window_start=date_trunc('minute',now())");
  assert.equal((await api('/v1/connectors','GET',undefined,'key-b')).status,429);
});

test('user authorization fills the connector tool catalog without requiring a user to list it', async () => {
  await pool.query('DELETE FROM connector_tools');
  assert.equal(((await (await api('/v1/tools?connector=notion')).json()) as any).total, 0);
  await connect('notion', 'catalog-user');
  const tools = await (await api('/v1/tools?connector=notion')).json() as any;
  assert.deepEqual(tools.data.map((t: any) => t.name), ['notion.notion-search']);
  const connectors = await (await api('/v1/connectors')).json() as any;
  assert(connectors.data.find((c: any) => c.name === 'notion').tools_synced_at);
  assert.equal(connectors.data.find((c: any) => c.name === 'linear').tools_synced_at, null);
});

test('administrator tool sync fills the catalog, revokes the token and creates no connection', async () => {
  await pool.query("INSERT INTO admin_users(id,email,password_hash) VALUES('admin_sync','sync@example.com','x') ON CONFLICT DO NOTHING");
  const connections = (await pool.query('SELECT count(*)::int AS n FROM connections')).rows[0].n;
  const revocations = tokenRevocations;
  const { session, browser, url } = await service.beginToolSync('linear', 'admin_sync');
  const state = new URL(url).searchParams.get('state');
  const page = await app.request(`http://localhost:3000/oauth/linear/callback?state=${state}&code=code`, { headers: { Cookie: `connany_${session.id}=${browser}` } });
  assert.equal(page.status, 200); assert((await page.text()).includes('已同步 1 个工具'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM connections')).rows[0].n, connections);
  assert.equal(tokenRevocations, revocations + 1);
  const tools = await (await api('/v1/tools?connector=linear')).json() as any;
  assert.deepEqual(tools.data.map((t: any) => t.name), ['linear.get_user']);
  assert.equal((await pool.query("SELECT action FROM admin_audit WHERE admin_id='admin_sync'")).rows[0].action, 'connector.tools_synced');
  // The sync session is not a project session and cannot be read through the API.
  assert.equal((await api(`/v1/connectors/linear/sessions/${session.id}?external_user_id=admin_sync`)).status, 404);
  assert.equal((await app.request(`http://localhost:3000/oauth/linear/callback?state=${state}&code=code`, { headers: { Cookie: `connany_${session.id}=${browser}` } })).status, 400);
});

test('connection tools come from the catalog and stay scoped to the owner and connection status', async () => {
  const flow = await connect('notion', 'tools-user');
  const own = await (await api(`/v1/connections/${flow.id}/tools?external_user_id=tools-user`)).json() as any;
  assert.deepEqual(own.data.map((t: any) => t.name), ['notion.notion-search']);
  assert.equal((await api(`/v1/connections/${flow.id}/tools?external_user_id=someone-else`)).status, 404);
  await pool.query('DELETE FROM connector_tools WHERE connector=$1', ['notion']);
  assert.equal(((await (await api(`/v1/connections/${flow.id}/tools?external_user_id=tools-user`)).json()) as any).total, 1);
  assert.equal((await pool.query('SELECT 1 FROM connector_tools WHERE connector=$1', ['notion'])).rowCount, 1);
  await api(`/v1/connections/${flow.id}?external_user_id=tools-user`, 'DELETE');
  assert.equal((await api(`/v1/connections/${flow.id}/tools?external_user_id=tools-user`)).status, 409);
});
