import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {createAdmin} from '../../src/admin/auth.js';
import {migrate} from '../../src/db.js';
import {Vault} from '../../src/crypto.js';
import {Service} from '../../src/service.js';
import {ConnectorRuntime} from '../../src/connectors/index.js';
import {createApp} from '../../src/app.js';
import {config,connectorClients} from '../support.js';
if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL is required');
const schema=`admin_${randomBytes(8).toString('hex')}`;
const owner=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
const emptyConfig={...config,connectors:connectorClients()};
const calls:{url:string;auth:string;body:string}[]=[];
const fetcher:typeof fetch=async(url,init)=>{
  const u=String(url);calls.push({url:u,auth:new Headers(init?.headers).get('Authorization')||'',body:String(init?.body||'')});
  if(u.endsWith('/login/oauth/access_token'))return Response.json({access_token:'upstream-token',refresh_token:'upstream-refresh',expires_in:3600,workspace_id:'w',workspace_name:'Work',bot_id:'bot',owner:{user:{id:'alice',name:'Alice'}}});
  if(u.endsWith('/oauth/revoke'))return Response.json({});
  if(u.endsWith('/user')) return Response.json({id:42,login:'alice'});
  if(u.includes('/user/installations')) return Response.json({installations:[],total_count:0});
  return Response.json({data:{viewer:{id:'alice',name:'Alice'},organization:{id:'w',name:'Work'},teams:{nodes:[]}}});
};
const vault=new Vault(config.encryptionKey);
const service=new Service(pool,new ConnectorRuntime(emptyConfig,fetcher),vault);
const app=createApp(service);
let cookie='';let csrf='';
const admin=(path:string,method='GET',body?:unknown,extra:Record<string,string>={})=>app.request(`http://localhost:3000/admin${path}`,{method,headers:{Cookie:cookie,Origin:config.publicBaseUrl,'Content-Type':'application/json','X-CSRF-Token':csrf,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
const api=(key:string,path:string,method='GET',body?:unknown)=>app.request(`http://localhost:3000/v1${path}`,{method,headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
async function save(client='client-a',secret='private-secret-a',enabled=true){return admin('/api/connectors/github','POST',{client_id:client,client_secret:secret,github_app_slug:'test-app',enabled});}
async function project(name:string){const response=await admin('/api/projects','POST',{name,return_urls:['http://localhost:3001/done']});assert.equal(response.status,201);return response.json() as Promise<any>;}
async function connect(key:string,user='same-user'){
  const response=await api(key,'/connectors/github/sessions','POST',{external_user_id:user});assert.equal(response.status,201);const session=await response.json() as any;
  const start=await app.request(`${session.connect_url}/start`,{method:'POST',headers:{Origin:config.publicBaseUrl}});assert.equal(start.status,200);
  const state=new URL(start.headers.get('refresh')!.slice(6)).searchParams.get('state');
  const result=await app.request(`http://localhost:3000/oauth/github/callback?state=${state}&code=test`,{headers:{Cookie:start.headers.get('set-cookie')!.split(';')[0]}});assert.equal(result.status,200);
  const completed=await(await api(key,`/connectors/github/sessions/${session.id}?external_user_id=${user}`)).json() as any;
  return completed.connection_id as string;
}
before(async()=>{await owner.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await migrate(pool);await createAdmin(pool,'admin@example.com','test-admin-password-123');});
after(async()=>{await pool.end();await owner.query(`DROP SCHEMA ${schema} CASCADE`);await owner.end();});
test('admin access requires login, exact Origin and session-bound CSRF',async()=>{
  assert.equal((await admin('')).status,302);assert.equal((await admin('/api/projects')).status,401);
  assert.equal((await admin('/api/login','POST',{email:'admin@example.com',password:'wrong'},{Origin:'https://evil.example'})).status,403);
  assert.equal((await admin('/api/login','POST',{email:'admin@example.com',password:'wrong'})).status,401);
  const login=await admin('/api/login','POST',{email:'ADMIN@example.com',password:'test-admin-password-123'});assert.equal(login.status,200);
  const set=login.headers.get('set-cookie')!;assert.match(set,/HttpOnly/);assert.match(set,/SameSite=Strict/);cookie=set.split(';')[0];
  const html=await(await admin('')).text();assert(html.includes('连接，从这里开始'));csrf=html.match(/name="csrf-token" content="([^"]+)"/)![1];
  assert.equal((await admin('/api/projects','POST',{name:'Bad',return_urls:[]},{'X-CSRF-Token':'bad'})).status,403);
  assert.equal((await admin('/api/projects','POST',{name:'Bad',return_urls:[]},{Origin:'https://evil.example'})).status,403);
  assert(!html.includes('password_hash'));assert(!html.includes('test-admin-password-123'));
});
test('database connector configuration becomes available without restart and never exposes secrets',async()=>{
  assert.equal((await save()).status,200);
  const view=await(await admin('/api/connectors')).text();assert(!view.includes('private-secret-a'));assert(!view.includes('ciphertext'));
  const data=JSON.parse(view);assert.equal(data.data.filter((p:any)=>p.enabled).length,1);
  const stored=(await pool.query("SELECT * FROM connector_apps WHERE connector='github'")).rows[0];assert(!stored.secret_ciphertext.includes('private-secret-a'));
  assert.equal((await save('client-a','')).status,200);
  const current=await service.connectorStore.active('github');assert.equal(current.runtime.config.connectors.github.clientSecret,'private-secret-a');
  assert.equal((await save('brand-new-client','')).status,400);
  const html=await(await admin('/connectors')).text();assert(!html.includes('private-secret-a'));assert(html.includes('/oauth/github/callback'));
});
let a:any,b:any,connectionA:string;
test('multiple agents share one app configuration while user connections remain isolated',async()=>{
  a=await project('Agent A');b=await project('Agent B');assert.notEqual(a.api_key,b.api_key);
  connectionA=await connect(a.api_key);const connectionB=await connect(b.api_key);
  assert.notEqual(connectionA,connectionB);
  const {rows}=await pool.query('SELECT DISTINCT connector_app_id FROM connections');assert.equal(rows.length,1);
  assert.equal((await api(b.api_key,`/connections/${connectionA}?external_user_id=same-user`)).status,404);
  const execute={external_user_id:'same-user',input:{}};
  assert.equal((await api(b.api_key,`/connections/${connectionA}/tools/github.installations.list/call`,'POST',execute)).status,404);
  assert.equal((await api(a.api_key,`/connections/${connectionA}/tools/github.installations.list/call`,'POST',execute)).status,200);
  const projectsText=await(await admin('/api/projects')).text();assert(!projectsText.includes(a.api_key));assert(!projectsText.includes('api_key_hash'));
  assert.equal((await app.request('http://localhost:3000/admin/api/connectors',{headers:{Authorization:`Bearer ${a.api_key}`}})).status,401);
});
test('secret rotation affects existing connections; changing Client ID pins old sessions and tokens',async()=>{
  assert.equal((await save('client-a','rotated-secret-a')).status,200);
  const pending=await(await api(a.api_key,'/connectors/github/sessions','POST',{external_user_id:'pending-user'})).json() as any;
  assert.equal((await save('client-b','secret-b')).status,200);
  const start=await app.request(`${pending.connect_url}/start`,{method:'POST',headers:{Origin:config.publicBaseUrl}});
  assert.equal(new URL(start.headers.get('refresh')!.slice(6)).searchParams.get('client_id'),'client-a');
  const c=await service.getConnection(a.project.id,'same-user',connectionA);
  const credential=vault.open<any>(c.credential_ciphertext!,service.context(c));credential.expiresAt=new Date(0).toISOString();
  await pool.query('UPDATE connections SET credential_ciphertext=$1 WHERE id=$2',[vault.seal(credential,service.context(c)),c.id]);
  assert.equal((await api(a.api_key,`/connections/${c.id}/tools/github.installations.list/call`,'POST',{external_user_id:'same-user',input:{}})).status,200);
  const refresh=calls.findLast(call=>call.url.endsWith('/login/oauth/access_token')&&call.body.includes('refresh_token'))!;
  assert.equal(new URLSearchParams(refresh.body).get('client_id'),'client-a');assert.equal(new URLSearchParams(refresh.body).get('client_secret'),'rotated-secret-a');
  const newConnection=await connect(a.api_key,'new-user');const fresh=await service.getConnection(a.project.id,'new-user',newConnection);
  assert.notEqual(fresh.connector_app_id,c.connector_app_id);
  const otherInstance=new Service(pool,new ConnectorRuntime({...config,connectors:{...config.connectors,github:{clientId:'client-a',clientSecret:'stale-env-secret'}}},fetcher),vault);
  await otherInstance.initialize();assert.equal((await otherInstance.connectorStore.active('github')).runtime.config.connectors.github.clientId,'client-b');
  assert.equal((await otherInstance.connectorStore.resolve('github',c.connector_app_id)).config.connectors.github.clientSecret,'rotated-secret-a');
});
test('pausing connector blocks new sessions but permits existing connections',async()=>{
  assert.equal((await save('client-b','',false)).status,200);
  assert.equal((await api(a.api_key,'/connectors/github/sessions','POST',{external_user_id:'u'})).status,503);
  assert.equal((await api(a.api_key,`/connections/${connectionA}/tools/github.installations.list/call`,'POST',{external_user_id:'same-user',input:{}})).status,200);
  assert.equal((await save('client-b','',true)).status,200);
});
test('API keys rotate without downtime, revoke independently, and disabling a project blocks all its keys',async()=>{
  const oldKey=a.api_key;
  const created=await admin(`/api/projects/${a.project.id}/api-keys`,'POST',{name:'production'});assert.equal(created.status,201);
  const issued=await created.json() as any;assert.equal(issued.key.name,'production');assert(!JSON.stringify(issued.key).includes(issued.api_key));
  // Both keys work until the old one is revoked.
  assert.equal((await api(oldKey,'/connectors')).status,200);assert.equal((await api(issued.api_key,'/connectors')).status,200);
  assert.equal((await admin(`/api/projects/${a.project.id}/api-keys`,'POST',{})).status,409);
  const oldId=(await pool.query('SELECT id FROM api_keys WHERE project_id=$1 AND id<>$2',[a.project.id,issued.key.id])).rows[0].id;
  assert.equal((await admin(`/api/api-keys/${oldId}/revoke`,'POST',{})).status,200);
  assert.equal((await api(oldKey,'/connectors')).status,401);a.api_key=issued.api_key;
  assert.equal((await api(a.api_key,'/connectors')).status,200);
  assert((await pool.query('SELECT last_used_at FROM api_keys WHERE id=$1',[issued.key.id])).rows[0].last_used_at);
  // Connections belong to the project, so they survive key rotation.
  assert.equal((await api(a.api_key,`/connections/${connectionA}?external_user_id=same-user`)).status,200);
  const pending=await(await api(a.api_key,'/connectors/github/sessions','POST',{external_user_id:'u'})).json() as any;
  assert.equal((await admin(`/api/projects/${a.project.id}/status`,'POST',{enabled:false})).status,200);
  assert.equal((await api(a.api_key,'/connectors')).status,401);assert.equal((await api(b.api_key,'/connectors')).status,200);
  assert.equal((await app.request(pending.connect_url)).status,410);
  assert.equal((await admin(`/api/projects/${a.project.id}/status`,'POST',{enabled:true})).status,200);
  assert.equal((await app.request(pending.connect_url)).status,410);
  assert.equal((await api(a.api_key,'/connectors')).status,200);
  const page=await(await admin(`/projects/${a.project.id}`)).text();assert(page.includes('production'));assert(!page.includes(a.api_key));
});
test('admin can disconnect users, see sanitized activity and edit return URL allowlists',async()=>{
  assert.equal((await admin(`/api/projects/${a.project.id}`,'POST',{name:'Agent A renamed',return_urls:['https://a.example/return']})).status,200);
  assert.equal((await admin(`/api/projects/${a.project.id}`,'POST',{name:'Bad',return_urls:['http://evil.example']})).status,400);
  // Admin UI edits name only; stored legacy return URLs are kept, not wiped.
  assert.equal((await admin(`/api/projects/${a.project.id}`,'POST',{name:'Agent A name only'})).status,200);
  assert.deepEqual((await pool.query('SELECT return_urls FROM projects WHERE id=$1',[a.project.id])).rows[0].return_urls,['https://a.example/return']);
  assert.equal((await admin(`/api/connections/${connectionA}/disconnect`,'POST',{})).status,200);
  assert.equal((await service.getConnection(a.project.id,'same-user',connectionA)).status,'revoked');
  const list=await(await admin('/api/connections')).text();assert(!list.includes('credential_ciphertext'));assert(!list.includes('upstream-token'));
  const activity=await(await admin('/activity')).text();assert(activity.includes('api_key.revoked'));assert(!activity.includes('rotated-secret-a'));
});
test('deleting a project revokes upstream grants and removes only its data',async()=>{
  assert.equal((await save()).status,200);
  const doomed=await project('Doomed'),kept=await project('Kept');
  const connections=[await connect(doomed.api_key,'u1'),await connect(doomed.api_key,'u2')];const keptConnection=await connect(kept.api_key,'u1');
  const revokes=()=>calls.filter(c=>c.url.includes('/applications/')&&c.url.endsWith('/token')).length;const before=revokes();
  const response=await admin(`/api/projects/${doomed.project.id}/delete`,'POST',{});assert.equal(response.status,200);assert.equal(((await response.json()) as any).revoked,2);
  assert.equal(revokes()-before,2);
  assert.equal((await api(doomed.api_key,'/connectors')).status,401);
  for(const table of ['projects','api_keys','connections','connect_sessions','events'])assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE ${table==='projects'?'id':'project_id'}=$1`,[doomed.project.id])).rowCount,0,table);
  assert.equal((await pool.query('SELECT 1 FROM connections WHERE id=ANY($1)',[connections])).rowCount,0);
  assert.equal((await service.getConnection(kept.project.id,'u1',keptConnection)).status,'connected');
  assert.equal((await admin(`/api/projects/${doomed.project.id}/delete`,'POST',{})).status,404);
  assert((await(await admin('/activity')).text()).includes('project.deleted'));
});
test('administrators manage console users; members use the workbench but not the System section',async()=>{
  const signIn=async(email:string,password:string)=>{
    const login=await app.request('http://localhost:3000/admin/api/login',{method:'POST',headers:{Origin:config.publicBaseUrl,'Content-Type':'application/json'},body:JSON.stringify({email,password})});
    assert.equal(login.status,200);const session=login.headers.get('set-cookie')!.split(';')[0];
    const page=await(await app.request('http://localhost:3000/admin',{headers:{Cookie:session}})).text();
    const token=page.match(/name="csrf-token" content="([^"]+)"/)![1];
    return {page,call:(path:string,method='GET',body?:unknown)=>app.request(`http://localhost:3000/admin${path}`,{method,redirect:'manual',headers:{Cookie:session,Origin:config.publicBaseUrl,'Content-Type':'application/json','X-CSRF-Token':token},...(body===undefined?{}:{body:JSON.stringify(body)})})};
  };
  const created=await admin('/api/users','POST',{email:'Member@Example.com',password:'member-password-123'});assert.equal(created.status,201);
  const member=(await created.json() as any).user;assert.equal(member.role,'member');assert.equal(member.email,'member@example.com');
  assert.equal((await admin('/api/users','POST',{email:'member@example.com',password:'member-password-123'})).status,409);
  assert.equal((await admin('/api/users','POST',{email:'weak@example.com',password:'short'})).status,400);
  assert((await(await admin('/users')).text()).includes('member@example.com'));
  // Members see the workbench but no System section, and cannot reach user management.
  const asMember=await signIn('member@example.com','member-password-123');
  assert(asMember.page.includes('/admin/projects'));assert(!asMember.page.includes('/admin/users'));
  assert.equal((await asMember.call('/users')).status,302);
  assert.equal((await asMember.call('/api/users')).status,403);
  assert.equal((await asMember.call('/api/users','POST',{email:'x@example.com',password:'member-password-123'})).status,403);
  assert.equal((await asMember.call('/api/projects')).status,200);
  // Role changes; the last administrator and one's own account are protected.
  const me=(await(await admin('/api/users')).json() as any).data.find((u:any)=>u.email==='admin@example.com');
  assert.equal((await admin(`/api/users/${me.id}/role`,'POST',{role:'member'})).status,400);
  assert.equal((await admin(`/api/users/${me.id}/delete`,'POST',{})).status,400);
  assert.equal((await admin(`/api/users/${member.id}/role`,'POST',{role:'admin'})).status,200);
  assert(!(await asMember.call('/api/users')).status.toString().startsWith('4'));
  assert.equal((await admin(`/api/users/${member.id}/role`,'POST',{role:'member'})).status,200);
  // A password reset signs the user out everywhere.
  assert.equal((await admin(`/api/users/${member.id}/password`,'POST',{password:'member-password-456'})).status,200);
  assert.equal((await asMember.call('/api/projects')).status,401);
  const again=await signIn('member@example.com','member-password-456');
  // Each user has a workspace: projects, connectors and connections never leak across users.
  const adminProjects=(await(await admin('/api/projects')).json() as any).data;assert(adminProjects.length>0);
  assert.equal(((await(await again.call('/api/projects')).json()) as any).data.length,0);
  assert.equal((await again.call(`/projects/${adminProjects[0].id}`)).status,404);
  assert.equal((await again.call(`/api/projects/${adminProjects[0].id}/status`,'POST',{enabled:false})).status,404);
  assert.equal(((await(await again.call('/api/connections')).json()) as any).data.length,0);
  assert(((await(await again.call('/api/connectors')).json()) as any).data.every((c:any)=>!c.enabled&&!c.client_id));
  const memberProject=await again.call('/api/projects','POST',{name:'Member project'});assert.equal(memberProject.status,201);
  const memberKey=(await memberProject.json() as any).api_key;
  assert.equal(((await(await api(memberKey,'/connectors')).json()) as any).data.length,0);
  assert.equal((await api(memberKey,'/connectors/github/sessions','POST',{external_user_id:'u'})).status,503);
  assert.equal((await api(memberKey,`/connections/${connectionA}?external_user_id=same-user`)).status,404);
  assert.equal(((await(await admin('/api/projects')).json()) as any).data.some((p:any)=>p.name==='Member project'),false);
  // Deleting keeps the audit trail readable.
  assert.equal((await admin(`/api/users/${member.id}/delete`,'POST',{})).status,200);
  assert.equal((await again.call('/api/projects')).status,401);
  assert.equal((await pool.query('SELECT 1 FROM workspaces WHERE owner_id=$1',[member.id])).rowCount,0);
  assert.equal((await pool.query("SELECT 1 FROM projects WHERE name='Member project'")).rowCount,0);
  assert.equal((await api(memberKey,'/connectors')).status,401);
  const activity=await(await admin('/activity')).text();assert(activity.includes('member@example.com'));assert(activity.includes('project.created'));
  assert.equal((await admin(`/api/users/${member.id}/delete`,'POST',{})).status,404);
});
test('self-service sign-up is closed by default; when opened it creates a signed-in member with its own workspace',async()=>{
  const anon=(path:string,method='GET',body?:unknown)=>app.request(`http://localhost:3000/admin${path}`,{method,headers:{Origin:config.publicBaseUrl,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const form={email:'New.User@example.com',password:'new-user-password',confirm_password:'new-user-password'};
  assert(!(await(await anon('/login')).text()).includes('/admin/signup'));
  assert.equal((await anon('/signup')).status,302);
  const closed=await anon('/api/signup','POST',form);assert.equal(closed.status,403);assert.equal(((await closed.json()) as any).error.code,'signup_disabled');
  // Only administrators change the setting.
  await pool.query("INSERT INTO admin_users(id,email,password_hash,role) VALUES('admin_member_s','member-s@example.com',(SELECT password_hash FROM admin_users WHERE email='admin@example.com'),'member') ON CONFLICT DO NOTHING");
  const memberLogin=await anon('/api/login','POST',{email:'member-s@example.com',password:'test-admin-password-123'});const memberCookie=memberLogin.headers.get('set-cookie')!.split(';')[0];
  const memberHtml=await(await app.request('http://localhost:3000/admin',{headers:{Cookie:memberCookie}})).text();const memberCsrf=memberHtml.match(/name="csrf-token" content="([^"]+)"/)![1];
  assert.equal((await app.request('http://localhost:3000/admin/api/settings/signup',{method:'POST',headers:{Cookie:memberCookie,Origin:config.publicBaseUrl,'Content-Type':'application/json','X-CSRF-Token':memberCsrf},body:JSON.stringify({enabled:true})})).status,403);
  assert.equal((await admin('/api/settings/signup','POST',{enabled:true})).status,200);
  assert((await(await admin('/users')).text()).includes('name="enabled" checked'));
  assert((await(await anon('/login')).text()).includes('/admin/signup'));
  assert.equal((await anon('/signup')).status,200);
  assert.equal((await anon('/api/signup','POST',{...form,confirm_password:'something-else'})).status,400);
  assert.equal((await anon('/api/signup','POST',{...form,password:'short',confirm_password:'short'})).status,400);
  const signed=await anon('/api/signup','POST',form);assert.equal(signed.status,201);
  const newCookie=signed.headers.get('set-cookie')!;assert.match(newCookie,/HttpOnly/);
  const home=await app.request('http://localhost:3000/admin',{headers:{Cookie:newCookie.split(';')[0]}});assert.equal(home.status,200);
  const user=(await pool.query("SELECT u.role,(SELECT count(*)::int FROM workspaces w WHERE w.owner_id=u.id) AS workspaces FROM admin_users u WHERE email='new.user@example.com'")).rows[0];
  assert.deepEqual(user,{role:'member',workspaces:1});
  assert(!(await home.text()).includes('/admin/users'));
  const again=await anon('/api/signup','POST',form);assert.equal(again.status,409);
  assert.equal((await admin('/api/settings/signup','POST',{enabled:false})).status,200);
  assert.equal((await anon('/api/signup','POST',{...form,email:'other@example.com'})).status,403);
  assert.equal((await pool.query("SELECT count(*)::int n FROM admin_audit WHERE action IN ('signup.opened','signup.closed','user.signed_up')")).rows[0].n,3);
});
test('logout and admin password reset revoke sessions, and login attempts are limited',async()=>{
  assert.equal((await admin('/api/logout','POST',{})).status,200);assert.equal((await admin('/api/projects')).status,401);
  const login=await admin('/api/login','POST',{email:'admin@example.com',password:'test-admin-password-123'});cookie=login.headers.get('set-cookie')!.split(';')[0];
  await createAdmin(pool,'admin@example.com','reset-admin-password-123');assert.equal((await admin('/api/projects')).status,401);
  for(let i=0;i<10;i++)await admin('/api/login','POST',{email:'admin@example.com',password:'wrong'});
  assert.equal((await admin('/api/login','POST',{email:'admin@example.com',password:'wrong'})).status,429);
});
