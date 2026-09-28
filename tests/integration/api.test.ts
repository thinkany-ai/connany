import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { migrate } from '../../src/db.js';
import { createApp } from '../../src/app.js';
import { Vault, hash } from '../../src/crypto.js';
import { Service } from '../../src/service.js';
import { Providers } from '../../src/providers/index.js';
import { config } from '../support.js';
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required. Tests create and remove an isolated schema.');
const schema = `test_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
let refreshCount = 0;
let failAction = false;
let rejectRefresh = false;
let failRevoke = false;
let seenSecrets: string[] = [];
const fetcher: typeof fetch = async (url, init) => {
  const u = String(url); const body = String(init?.body || '');
  const headers = new Headers(init?.headers);
  seenSecrets.push(headers.get('Authorization') || '');
  if ((u === 'https://mcp.notion.com/token' || u === 'https://mcp.linear.app/token') && !new URLSearchParams(body).has('grant_type')) return Response.json({}, {status:failRevoke?503:200});
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
const service = new Service(pool, new Providers(config, fetcher), vault);
const app = createApp(service);
const api = (path: string, method = 'GET', body?: unknown, key = 'key-a') => app.request(`http://localhost:3000${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await pool.query("INSERT INTO provider_apps(id,provider,client_id,secret_ciphertext,settings) VALUES('notion-app','notion','mcp-client',$1,'{\"transport\":\"mcp\"}')",[vault.seal('', 'provider-app:notion-app')]);
  await pool.query("INSERT INTO provider_settings(provider,active_app_id) VALUES('notion','notion-app')");
  await pool.query("INSERT INTO provider_apps(id,provider,client_id,secret_ciphertext,settings) VALUES('linear-app','linear','linear-client',$1,'{\"transport\":\"mcp\"}')",[vault.seal('', 'provider-app:linear-app')]);
  await pool.query("INSERT INTO provider_settings(provider,active_app_id) VALUES('linear','linear-app')");
  await pool.query('INSERT INTO projects(id,name,api_key_hash,return_urls) VALUES($1,$2,$3,$4),($5,$6,$7,$8)', ['a','Agent A',hash('key-a'),JSON.stringify(['http://localhost:3001/done']),'b','Agent B',hash('key-b'),'[]']);
});
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
async function start(provider = 'notion', user = 'user-1') {
  const created = await api('/v1/connect-sessions', 'POST', { provider, external_user_id: user, return_url: 'http://localhost:3001/done' });
  assert.equal(created.status, 201); const session = await created.json() as any;
  const launch = await app.request(session.connect_url);
  assert.equal(launch.status, 302);
  const cookie = launch.headers.get('set-cookie')!.split(';')[0];
  const state = new URL(launch.headers.get('location')!).searchParams.get('state');
  return { session, cookie, callback: `http://localhost:3000/oauth/${provider}/callback?state=${state}&code=code` };
}
async function connect(provider = 'notion', user = 'user-1') {
  const flow = await start(provider, user);
  const result = await app.request(flow.callback, { headers: { Cookie: flow.cookie } }); assert.equal(result.status, 302);
  assert.equal(new URL(result.headers.get('location')!).origin, 'http://localhost:3001');
  const state = await (await api(`/v1/connect-sessions/${flow.session.id}?external_user_id=${user}`)).json() as any;
  assert.equal(state.status, 'connected');
  return { ...flow, id: state.connection_id };
}
test('full OAuth callback round trips for Notion, GitHub and Linear; tokens remain encrypted', async () => {
  for (const provider of ['notion','github','linear']) {
    const flow = await connect(provider);
    const response = await api(`/v1/connections/${flow.id}?external_user_id=user-1`);
    const text = await response.text(); assert(!text.includes('secret-access')); assert(!text.includes('ciphertext'));
    const { rows } = await pool.query('SELECT * FROM connections WHERE id=$1', [flow.id]);
    assert(!rows[0].credential_ciphertext.includes('secret-access'));
    assert.equal((vault.open<any>(rows[0].credential_ciphertext, service.context(rows[0]))).accessToken, 'secret-access');
    assert.equal((await app.request(flow.callback, { headers: { Cookie: flow.cookie } })).status, 400);
  }
});
test('browser binding, provider binding, denial, origin and return URL checks', async () => {
  // Return URLs come from the key holder per request; only unsafe forms are rejected.
  for (const url of ['https://unregistered.example/done','http://localhost:49152/callback','http://[::1]:8787/callback','myapp://oauth/callback'])
    assert.equal((await api('/v1/connect-sessions','POST',{ provider:'notion',external_user_id:'u',return_url:url })).status,201,url);
  for (const url of ['http://evil.example/done','javascript:alert(1)','data:text/html,hi','https://user:pass@a.example/','https://a.example/#x'])
    assert.equal((await api('/v1/connect-sessions','POST',{ provider:'notion',external_user_id:'u',return_url:url })).status,400,url);
  const flow = await start('notion','browser-user');
  assert.equal((await app.request(flow.callback)).status,400);
  assert.equal((await app.request(flow.callback.replace('/notion/', '/github/'), { headers: { Cookie: flow.cookie } })).status,400);
  const denied = flow.callback.replace('&code=code','&error=access_denied');
  assert.equal((await app.request(denied,{headers:{Cookie:flow.cookie}})).status,400);
  const status = await (await api(`/v1/connect-sessions/${flow.session.id}?external_user_id=browser-user`)).json() as any;
  assert.equal(status.error_code,'access_denied');
  const created = await (await api('/v1/connect-sessions','POST',{provider:'notion',external_user_id:'u'})).json() as any;
  assert.equal((await app.request(`${created.connect_url}/start`,{method:'POST',headers:{Origin:'https://evil.example'}})).status,403);
});
test('tenant and end-user isolation applies to reads, actions, sessions and disconnect', async () => {
  const flow = await connect('notion','isolated');
  for (const [key,user] of [['key-b','isolated'],['key-a','other']]) {
    for (const method of ['GET','DELETE']) assert.equal((await api(`/v1/connections/${flow.id}?external_user_id=${user}`,method,undefined,key)).status,404);
    assert.equal((await api(`/v1/connect-sessions/${flow.session.id}?external_user_id=${user}`,'GET',undefined,key)).status,404);
    assert.equal((await api('/v1/actions/execute','POST',{external_user_id:user,connection_id:flow.id,action:'notion.notion-search',input:{}},key)).status,404);
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
  const execute = () => api('/v1/actions/execute','POST',{external_user_id:'refresh-user',connection_id:flow.id,action:'notion.notion-search',input:{}});
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
  try { assert.equal((await api('/v1/actions/execute','POST',{external_user_id:'reauth-user',connection_id:flow.id,action:'notion.notion-search',input:{}})).status,409); } finally { rejectRefresh=false; }
  assert.equal((await service.getConnection('a','reauth-user',flow.id)).status,'reauth_required');
  const reconnect = await (await api(`/v1/connections/${flow.id}/reconnect`,'POST',{external_user_id:'reauth-user'})).json() as any;
  const launch = await app.request(`${reconnect.connect_url}/start`,{method:'POST',headers:{Origin:config.publicBaseUrl}});
  const state = new URL(launch.headers.get('refresh')!.slice(6)).searchParams.get('state');
  assert.equal((await app.request(`http://localhost:3000/oauth/notion/callback?state=${state}&code=x`,{headers:{Cookie:launch.headers.get('set-cookie')!.split(';')[0]}})).status,200);
  assert.equal((await service.getConnection('a','reauth-user',flow.id)).status,'connected');
});
test('disconnect blocks actions even when provider revocation fails and can be retried', async () => {
  const flow = await connect('notion','disconnect-user'); failRevoke=true;
  let body: any;
  try { body=await (await api(`/v1/connections/${flow.id}?external_user_id=disconnect-user`,'DELETE')).json(); } finally { failRevoke=false; }
  assert.equal(body.status,'revoked'); assert.equal(body.revocation_status,'failed');
  assert.equal((await api('/v1/actions/execute','POST',{external_user_id:'disconnect-user',connection_id:flow.id,action:'notion.notion-search',input:{}})).status,409);
  body=await (await api(`/v1/connections/${flow.id}?external_user_id=disconnect-user`,'DELETE')).json();
  assert.equal(body.revocation_status,'succeeded');
  assert.equal((await service.getConnection('a','disconnect-user',flow.id)).credential_ciphertext,null);
});
test('expired sessions, action schemas and provider mismatch are rejected', async () => {
  const s = await (await api('/v1/connect-sessions','POST',{provider:'notion',external_user_id:'expired'})).json() as any;
  await pool.query("UPDATE connect_sessions SET expires_at=now()-interval '1 minute' WHERE id=$1",[s.id]);
  assert.equal((await app.request(s.connect_url)).status,410);
  const state = await (await api(`/v1/connect-sessions/${s.id}?external_user_id=expired`)).json() as any; assert.equal(state.status,'expired');
  const flow=await connect('notion','schemas');
  assert.equal((await api('/v1/actions/execute','POST',{external_user_id:'schemas',connection_id:flow.id,action:'notion.search',input:{limit:1000}})).status,400);
  assert.equal((await api('/v1/actions/execute','POST',{external_user_id:'schemas',connection_id:flow.id,action:'linear.teams.list',input:{}})).status,400);
  const catalog=await (await api('/v1/actions')).json() as any; assert.equal(catalog.data.length,18);
});
test('connection filters paginate within owner and provider; checks use the normal lifecycle', async () => {
  const user='filtered-connections';
  const notion=await connect('notion',user);
  const github=await connect('github',user);
  await connect('linear',user);
  await pool.query("UPDATE connections SET status='revoked' WHERE id=$1",[github.id]);
  const list=async(query:string,key='key-a')=>{
    const response=await api(`/v1/connections?external_user_id=${user}&${query}`,'GET',undefined,key);
    assert.equal(response.status,200);return response.json() as Promise<any>;
  };
  const onlyNotion=await list('provider=notion&status=connected');
  assert.deepEqual(onlyNotion.data.map((c:any)=>c.id),[notion.id]);
  const revoked=await list('status=revoked');assert.deepEqual(revoked.data.map((c:any)=>c.id),[github.id]);
  const first=await list('status=connected&limit=1');assert.equal(first.data.length,1);assert(first.next_cursor);
  const second=await list(`status=connected&limit=1&after=${first.next_cursor}`);
  assert.equal(second.data.length,1);assert.notEqual(first.data[0].id,second.data[0].id);assert.equal(second.next_cursor,null);
  assert.equal((await list('provider=notion','key-b')).data.length,0);
  const checked=await api(`/v1/connections/${notion.id}/check`,'POST',{external_user_id:user});
  assert.equal(checked.status,200);assert.equal((await checked.json() as any).tool_count,1);
  assert.equal((await api(`/v1/connections/${notion.id}/check`,'POST',{external_user_id:user},'key-b')).status,404);
  assert.equal((await api(`/v1/connections/${github.id}/check`,'POST',{external_user_id:user})).status,409);
});
test('events are scoped and rate limiting is persisted per project', async () => {
  const events = await (await api('/v1/events?external_user_id=refresh-user')).json() as any;
  assert(events.data.some((e:any)=>e.type==='action.succeeded'));
  const other=await (await api('/v1/events?external_user_id=refresh-user','GET',undefined,'key-b')).json() as any; assert.equal(other.data.length,0);
  await pool.query("INSERT INTO rate_limits(project_id,window_start,count) VALUES('b',date_trunc('minute',now()),120) ON CONFLICT(project_id) DO UPDATE SET count=120,window_start=date_trunc('minute',now())");
  assert.equal((await api('/v1/providers','GET',undefined,'key-b')).status,429);
});
