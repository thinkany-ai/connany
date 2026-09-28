import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Providers} from '../src/providers/index.js';
import {ProviderStore} from '../src/provider-store.js';
import {Vault} from '../src/crypto.js';
import {config} from './support.js';
import {Connany,createAgentTools} from '../sdk/client.js';
import {providerList} from '../src/admin/pages.js';

test('Linear MCP OAuth requests read/write with PKCE, resource binding and no legacy app secret',async()=>{
 const calls:any[]=[];
 const provider=new Providers(config,async(url,init)=>{calls.push({url:String(url),body:String(init?.body)});return Response.json({access_token:'new',refresh_token:'rotated',expires_in:3600});});
 const url=new URL(provider.authorizeUrl('linear','state','verifier'));
 assert.equal(url.origin,'https://mcp.linear.app');assert.equal(url.searchParams.get('scope'),'read write');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.equal(url.searchParams.get('actor'),null);
 await provider.exchange('linear','code','verifier');
 const fields=new URLSearchParams(calls[0].body);assert.equal(fields.get('client_secret'),null);assert.equal(fields.get('resource'),'https://mcp.linear.app/mcp');assert.equal(fields.get('code_verifier'),'verifier');
 assert.equal((await provider.refresh('linear',{accessToken:'old',refreshToken:'refresh'})).refreshToken,'rotated');
 await provider.revoke('linear',{accessToken:'new',refreshToken:'rotated'});
 assert(calls.every(c=>c.url==='https://mcp.linear.app/token'));assert.equal(new URLSearchParams(calls.at(-1).body).get('token'),'rotated');
});
test('Linear discovers official read/write tools, identifies current user and executes tools through MCP',async()=>{
 const provider=new Providers(config,async(url,init)=>{
  assert.equal(String(url),'https://mcp.linear.app/mcp');const rpc=JSON.parse(String(init?.body));
  if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
  const result=rpc.method==='initialize'?{protocolVersion:'2025-03-26'}:rpc.method==='tools/list'?{tools:[{name:'get_user',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},{name:'save_issue',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:JSON.stringify({id:'u',name:'Alice',organization:{id:'w',name:'ThinkAny'}})}]};
  if(rpc.method==='tools/call')assert.deepEqual(rpc.params,{name:'get_user',arguments:{query:'me'}});
  return Response.json({jsonrpc:'2.0',id:rpc.id,result});
 });
 const {identity_checked_at,...identity}=await provider.identify('linear',{accessToken:'token'},{});
 assert.equal(typeof identity_checked_at,'string');
 assert.deepEqual(identity,{account_id:'u',account_name:'Alice',workspace_id:'w',workspace_name:'ThinkAny',transport:'mcp'});
 const tools=await provider.mcp('linear').tools({accessToken:'token'});assert.deepEqual(tools.map(t=>[t.name,t.read_only]),[['linear.get_user',true],['linear.save_issue',false]]);
 await assert.rejects(()=>provider.execute('linear.teams.list',{}, {accessToken:'token'}),{code:'action_not_found'});
});
test('Linear registration saves MCP settings, reuses client, and rejects old credentials',async()=>{
 let saved:any;let requests=0;
 const db={release(){},async query(sql:string,args:any[]=[]):Promise<any>{
  if(sql.startsWith('SELECT a.*')){assert.equal(args[0],'linear');return {rows:saved?[saved]:[]};}
  if(sql.startsWith('INSERT INTO provider_apps')){assert.equal(args[4],'linear');saved={id:args[0],client_id:args[1],settings:JSON.parse(args[3])};}
  if(sql.startsWith('SELECT * FROM provider_apps'))return {rows:[{id:'old',settings:{}}]};
  return {rows:[]};
 }};
 const store=new ProviderStore({connect:async()=>db,query:db.query} as any,new Providers(config,async(url,init)=>{
  requests++;assert.equal(String(url),'https://mcp.linear.app/register');const body=JSON.parse(String(init?.body));assert.equal(body.token_endpoint_auth_method,'none');assert.deepEqual(body.redirect_uris,['http://localhost:3000/oauth/linear/callback']);return Response.json({client_id:'linear-mcp-client'});
 }),new Vault(config.encryptionKey));
 await store.saveMcp('linear',true,'admin');await store.saveMcp('linear',true,'admin');assert.equal(requests,1);assert.equal(saved.settings.transport,'mcp');
 await assert.rejects(()=>store.resolve('linear','old'),{code:'reauth_required'});
});
test('Linear SDK discovery binds user/connection and admin no longer asks for app credentials',async()=>{
 const client=new Connany({baseUrl:'https://connany.example',apiKey:'key',fetch:async(_url,init)=>{
  const body=JSON.parse(String(init?.body));assert.equal(body.external_user_id,'u');assert.equal(body.connection_id,'c');assert.equal(body.provider,'linear');return Response.json({data:[],next_offset:null,total:0});
 }});
 await createAgentTools(client,{provider:'linear',externalUserId:'u',connectionId:'c'}).call('discover_actions',{});
 const html=providerList([{name:'linear',configured:false,enabled:false,client_id:'',has_secret:false,github_app_slug:'',callback_url:'http://localhost:3100/oauth/linear/callback',updated_at:null}]);
 assert(html.includes('>启用</button>'));assert(!html.includes('name="client_secret"'));assert(html.includes('/admin/api/providers/linear'));
});

test('Linear explicitly reads workspace metadata without relying on get_user organization',async()=>{
 const {HostedMcp}=await import('../src/providers/hosted-mcp.js');
 const {linearIdentity}=await import('../src/providers/mcp-identity.js');
 let workspaceId='w',accountId='u',failed=false,structured=false;
 const calls:string[]=[];
 const mcp=new HostedMcp(async(_url,init)=>{
  const rpc=JSON.parse(String(init?.body));
  if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
  let result:any;
  if(rpc.method==='initialize')result={protocolVersion:'2025-03-26'};
  else if(rpc.method==='tools/list')result={tools:['get_user','get_workspace'].map(name=>({name,inputSchema:{type:'object'},annotations:{readOnlyHint:true}}))};
  else {
   calls.push(rpc.params.name);
   const workspace=rpc.params.name==='get_workspace';
   assert.deepEqual(rpc.params.arguments,workspace?{}:{query:'me'});
   const value=workspace?{id:workspaceId,name:'ThinkAny',url:'https://linear.app/thinkany'}:{id:accountId,name:'idoubi'};
   result=workspace&&failed?{isError:true}:structured?{structuredContent:{data:value}}:{content:[{type:'text',text:JSON.stringify(value)}]};
  }
  return Response.json({jsonrpc:'2.0',id:rpc.id,result});
 },'linear');
 for(const mode of [false,true]){
  structured=mode;
  assert.deepEqual(await linearIdentity(mcp,{accessToken:'t'}),{account_id:'u',account_name:'idoubi',workspace_id:'w',workspace_name:'ThinkAny',transport:'mcp'});
 }
 assert(calls.includes('get_workspace'));
 workspaceId='foreign';
 await assert.rejects(()=>linearIdentity(mcp,{accessToken:'t'},{account_id:'u',workspace_id:'w'}),{code:'linear_identity_mismatch'});
 accountId='foreign';
 await assert.rejects(()=>linearIdentity(mcp,{accessToken:'t'},{account_id:'u'}),{code:'linear_identity_mismatch'});
 accountId='u';failed=true;
 assert.equal((await linearIdentity(mcp,{accessToken:'t'})).account_name,'idoubi');
});

test('existing Linear connections enrich once per hour and skip disconnected accounts',async()=>{
 const {Service}=await import('../src/service.js');
 const service=Object.create(Service.prototype) as InstanceType<typeof Service>;
 const c={id:'c',project_id:'p',external_user_id:'u',provider:'linear',status:'connected',identity:{transport:'mcp',account_id:'u'}} as any;
 let calls=0;
 service.execute=async(p,u,id,action)=>{assert.deepEqual([p,u,id,action],['p','u','c','linear.__identity']);calls++;return {};};
 service.getConnection=async()=>({...c,identity:{...c.identity,workspace_name:'ThinkAny'}});
 assert.equal((await service.enrichConnection(c)).identity.workspace_name,'ThinkAny');
 await service.enrichConnection({...c,identity:{...c.identity,identity_checked_at:new Date().toISOString()}});
 await service.enrichConnection({...c,status:'revoked'});
 assert.equal(calls,1);
});
