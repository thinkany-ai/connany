import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HostedMcp as NotionMcp} from '../src/connectors/hosted-mcp.js';
import {notionIdentity} from '../src/connectors/mcp-identity.js';
import {ConnectorStore} from '../src/connector-store.js';
import {ConnectorRuntime} from '../src/connectors/index.js';
import {Vault} from '../src/crypto.js';
import {config} from './support.js';
import {createApp} from '../src/app.js';
import type {Service} from '../src/service.js';
import {Connany,createAgentTools} from '../sdk/client.js';

test('MCP registers exact callback with public client and exchanges codes with PKCE',async()=>{
 const mcp=new NotionMcp(async(url,init)=>{
  assert.equal(String(url),'https://mcp.notion.com/register');
  const body=JSON.parse(String(init?.body));assert.equal(body.token_endpoint_auth_method,'none');
  assert.deepEqual(body.redirect_uris,['https://connany.example/oauth/notion/callback']);
  assert.equal(body.client_name,'Connany');return Response.json({client_id:'registered'});
 });
 assert.deepEqual(await mcp.register('https://connany.example/oauth/notion/callback'),{clientId:'registered',clientSecret:'',authMethod:'none'});
 const runtime=new ConnectorRuntime(config,async()=>Response.json({}, {status:503}));
 const identity=await runtime.identify('notion',{accessToken:'x'},{user_id:'u',workspace_id:'w'});
 assert.equal(identity.workspace_name,'Notion workspace');assert.equal(identity.account_id,'u');assert.equal(typeof identity.identity_checked_at,'string');
 await assert.rejects(()=>runtime.identify('notion',{accessToken:'x'},{bot_id:'legacy',workspace_id:'w'}));
});
test('MCP handles initialization, paginated SSE tools, conservative write flags and tool errors',async()=>{
 let calls=0;
 const mcp=new NotionMcp(async(_url,init)=>{
  const body=JSON.parse(String(init?.body)); const headers=new Headers(init?.headers);
  assert.equal(headers.get('Authorization'),'Bearer private');
  if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-03-26',capabilities:{tools:{}}}},{headers:{'mcp-session-id':'session'}});
  assert.equal(headers.get('mcp-session-id'),'session');
  if(body.method==='notifications/initialized')return new Response(null,{status:202});
  if(body.method==='tools/list') {
   const result=body.params.cursor?{tools:[{name:'write',inputSchema:{type:'object'}}]}:{tools:[{name:'read',description:'Read pages',inputSchema:{type:'object'},annotations:{readOnlyHint:true}}],nextCursor:'next'};
   return new Response(`event: message\ndata: ${JSON.stringify({jsonrpc:'2.0',id:body.id,result})}\n\n`,{headers:{'Content-Type':'text/event-stream'}});
  }
  calls++;assert.equal(body.params.name,'write');return Response.json({jsonrpc:'2.0',id:body.id,result:{isError:true,content:[{type:'text',text:'permission denied'}]}});
 });
 const tools=await mcp.tools({accessToken:'private'});
 assert.deepEqual(tools.map(t=>[t.name,t.read_only]),[['notion.read',true],['notion.write',false]]);
 await assert.rejects(()=>mcp.call('notion.missing',{}, {accessToken:'private'}),{code:'tool_not_found'});assert.equal(calls,0);
 await assert.rejects(()=>mcp.call('notion.write',{}, {accessToken:'private'}),{code:'mcp_tool_error'});assert.equal(calls,1);
});
test('MCP fails closed on upstream auth errors and legacy app credentials',async()=>{
 const mcp=new NotionMcp(async()=>Response.json({error:'invalid_grant',secret:'hidden'},{status:400}));
 await assert.rejects(()=>mcp.token({clientId:'client',clientSecret:'',authMethod:'none'},{grant_type:'refresh_token',refresh_token:'secret'}),{code:'reauth_required',status:401});
 const pool={query:async()=>({rows:[{id:'old',settings:{}}]})} as any;
 const store=new ConnectorStore(pool,new ConnectorRuntime(config),new Vault(config.encryptionKey));
 await assert.rejects(()=>store.resolve('notion','old'),{code:'reauth_required'});
 await assert.rejects(()=>store.resolve('notion',null),{code:'reauth_required'});
});
test('connection check refreshes the Notion tool catalog with the user credential',async()=>{
 const service={initialize:async()=>{},authenticate:async()=>({id:'project'}),execute:async(project:string,user:string,connection:string,action:string)=>{
  assert.deepEqual([project,user,connection,action],['project','user','connection','notion.__discover']);
  return [{name:'notion.read',connector:'notion',description:'Read',read_only:true,input_schema:{type:'object'}}];
 },getConnection:async(_p:string,_u:string,c:string)=>({id:c,connector:'notion'})} as unknown as Service;
 const app=createApp(service);
 const check=await app.request('http://localhost/v1/connections/connection/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({external_user_id:'user'})});
 assert.equal(check.status,200);assert.equal(((await check.json()) as any).tool_count,1);
});

test('MCP registration is reused on save and never accepts legacy client secrets',async()=>{
 let saved:any;let settings:any;let registrations=0;
 const db={release(){},async query(sql:string,args:any[]=[]):Promise<any>{
  if(sql.startsWith('SELECT a.*'))return {rows:saved?[saved]:[]};
  if(sql.startsWith('INSERT INTO connector_apps'))saved={id:args[0],client_id:args[3],settings:JSON.parse(args[5])};
  if(sql.startsWith('INSERT INTO connectors'))settings={appId:args[2],enabled:args[3]};
  return {rows:[]};
 }};
 const pool={connect:async()=>db} as any;
 const runtime=new ConnectorRuntime(config,async()=>{registrations++;return Response.json({client_id:'registered'});});
 const store=new ConnectorStore(pool,runtime,new Vault(config.encryptionKey));
 await store.saveMcp('notion',true,'admin');assert.equal(registrations,1);assert.equal(saved.settings.transport,'mcp');
 await store.saveMcp('notion',false,'admin');assert.equal(settings.enabled,false);
 await store.saveMcp('notion',true,'admin');assert.equal(registrations,1);assert.equal(settings.appId,saved.id);
 await assert.rejects(()=>store.save('notion',{client_id:'old',client_secret:'secret',github_app_slug:'',enabled:true},'admin'),{code:'use_notion_mcp'});
});

test('MCP discovery respects tenant ownership before contacting Notion',async()=>{
 const {Service}=await import('../src/service.js');
 const db={release(){},query:async(sql:string)=>({rows:[],rowCount:0})};
 const pool={connect:async()=>db} as any;
 let upstream=0;
 const service=new Service(pool,new ConnectorRuntime(config,async()=>{upstream++;throw new Error('must not call');}),new Vault(config.encryptionKey));
 await assert.rejects(()=>service.execute('other-project','user','connection','notion.__discover',{}),{code:'not_found'});
 assert.equal(upstream,0);
});


test('Notion identity reads self metadata from text or structured content and rejects mismatched identities',async()=>{
 let structured=false;let workspaceId='w';let fail=false;
 const runtime=new ConnectorRuntime(config,async(_url,init)=>{
  const body=JSON.parse(String(init?.body));
  if(body.method==='notifications/initialized')return new Response(null,{status:202});
  if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-03-26'}});
  assert.deepEqual(body.params,{name:'notion-fetch',arguments:{id:'self'}});
  const payload={self:{workspace:{id:workspaceId,name:'Mike 工作区'},user:{id:'u',name:'Mike',email:'private@example.com'}}};
  return Response.json({jsonrpc:'2.0',id:body.id,result:fail?{isError:true}:structured?{structuredContent:payload}:{content:[{type:'text',text:JSON.stringify(payload)}]}});
 });
 for(const mode of [false,true]){
  structured=mode;
  const identity=await runtime.identify('notion',{accessToken:'x'},{user_id:'u',workspace_id:'w'});
  assert.equal(identity.workspace_name,'Mike 工作区');assert.equal(identity.account_name,'Mike');assert.equal(identity.workspace_id,'w');assert(!JSON.stringify(identity).includes('private@example.com'));
 }
 workspaceId='other';
 await assert.rejects(()=>notionIdentity(runtime.mcp('notion'),{accessToken:'x'},{account_id:'u',workspace_id:'w'}),{code:'notion_identity_mismatch'});
 fail=true;
 assert.equal((await runtime.identify('notion',{accessToken:'x'},{user_id:'u',workspace_id:'w'})).workspace_name,'Notion workspace');
});

test('existing Notion connections lazily enrich names, cache results and skip revoked connections',async()=>{
 const {Service}=await import('../src/service.js');
 const service=Object.create(Service.prototype) as InstanceType<typeof Service>;
 let calls=0;
 const connection={id:'c',project_id:'p',external_user_id:'u',connector:'notion',status:'connected',identity:{transport:'mcp',account_id:'u',workspace_id:'w'}} as any;
 service.execute=async(p,u,c,action)=>{assert.deepEqual([p,u,c,action],['p','u','c','notion.__identity']);calls++;return {};};
 service.getConnection=async()=>({...connection,identity:{...connection.identity,workspace_name:'Actual workspace'}});
 assert.equal((await service.enrichConnection(connection)).identity.workspace_name,'Actual workspace');assert.equal(calls,1);
 await service.enrichConnection({...connection,identity:{...connection.identity,identity_checked_at:new Date().toISOString()}});assert.equal(calls,1);
 await service.enrichConnection({...connection,status:'revoked'});assert.equal(calls,1);
});
