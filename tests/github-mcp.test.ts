import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ConnectorRuntime} from '../src/connectors/index.js';
import {config} from './support.js';
import {AppError} from '../src/errors.js';
import {createApp} from '../src/app.js';
import type {Service} from '../src/service.js';
import {Connany,createAgentTools} from '../sdk/client.js';

test('GitHub official MCP uses existing user token and all-tool endpoint; tool errors remain errors',async()=>{
 let denied=false;let writes=0;
 const runtime=new ConnectorRuntime(config,async(url,init)=>{
  assert.equal(String(url),'https://api.githubcopilot.com/mcp/x/all');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer user-token');
  const rpc=JSON.parse(String(init?.body));
  if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
  if(rpc.method==='tools/call'){writes++;assert.equal(rpc.params.name,'create_issue');assert.deepEqual(rpc.params.arguments,{title:'Test'});}
  const result=rpc.method==='initialize'?{protocolVersion:'2025-03-26'}:rpc.method==='tools/list'?{tools:[{name:'get_me',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},{name:'create_issue',inputSchema:{type:'object'}}]}:{isError:denied,content:[{type:'text',text:'result'}]};
  return Response.json({jsonrpc:'2.0',id:rpc.id,result});
 });
 const tools=await runtime.mcp('github').tools({accessToken:'user-token'});assert.deepEqual(tools.map(t=>[t.name,t.read_only]),[['github.get_me',true],['github.create_issue',false]]);
 await runtime.execute('github.create_issue',{title:'Test'},{accessToken:'user-token'});assert.equal(writes,1);
 denied=true;await assert.rejects(()=>runtime.execute('github.create_issue',{title:'Test'},{accessToken:'user-token'}),{code:'mcp_tool_error'});assert.equal(writes,2);
 const auth=new URL(runtime.authorizeUrl('github','state','verifier'));assert.equal(auth.origin,'https://github.com');assert.equal(auth.searchParams.get('client_id'),config.connectors.github.clientId);
 await assert.rejects(()=>runtime.mcp('github').register('https://example.com'),{code:'github_app_required'});
});
test('catalog lists every connector, connection tools are scoped to the user, and the SDK adapter uses the connection',async()=>{
 const catalog=[{name:'github.get_me',connector:'github',description:'Me',read_only:true,required_permissions:[],input_schema:{type:'object'}},{name:'github.create_issue',connector:'github',description:'Create issue',read_only:false,required_permissions:[],input_schema:{type:'object'}},{name:'notion.notion-search',connector:'notion',description:'Search',read_only:true,required_permissions:[],input_schema:{type:'object'}}];
 let cached:any=catalog.filter(t=>t.connector==='github');let discovered=0;let status='connected';
 const service={initialize:async()=>{},authenticate:async()=>({id:'p'}),connectorStore:{tools:async()=>catalog,catalog:async()=>cached},
  getConnection:async(p:string,u:string,c:string)=>{if(u!=='u')throw new AppError('not_found','Connection not found.',404);return {id:c,connector:'github',status};},
  execute:async(_p:string,_u:string,_c:string,tool:string)=>{assert.equal(tool,'github.__discover');discovered++;return catalog.filter(t=>t.connector==='github');}} as unknown as Service;
 const app=createApp(service);
 const list=async(query:string)=>(await (await app.request('http://localhost/v1/tools'+query)).json() as any);
 assert.equal((await list('')).total,3);
 assert.deepEqual((await list('?connector=github')).data.map((t:any)=>t.name),['github.create_issue','github.get_me']);
 assert.deepEqual((await list('?connector=github&read_only=true')).data.map((t:any)=>t.name),['github.get_me']);
 assert.equal((await app.request('http://localhost/v1/tools?connector=unknown')).status,400);
 assert.equal((await app.request('http://localhost/v1/tools?external_user_id=u')).status,400);
 const own=async(query='')=>app.request('http://localhost/v1/connections/c/tools?external_user_id=u'+query);
 assert.deepEqual(((await (await own()).json()) as any).data.map((t:any)=>t.name),['github.create_issue','github.get_me']);assert.equal(discovered,0);
 assert.equal((await app.request('http://localhost/v1/connections/c/tools?external_user_id=other')).status,404);
 cached=null;assert.equal(((await (await own('&read_only=true')).json()) as any).total,1);assert.equal(discovered,1);
 status='revoked';assert.equal((await own()).status,409);status='connected';
 assert.equal((await app.request('http://localhost/v1/connections/c/tools/github.__discover/call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({external_user_id:'u'})})).status,400);
 const client=new Connany({baseUrl:'https://example.com',apiKey:'key',fetch:async(url)=>{
  const target=new URL(String(url));assert.equal(target.pathname,'/v1/connections/c/tools');assert.equal(target.searchParams.get('external_user_id'),'u');assert.equal(target.searchParams.get('read_only'),'true');return Response.json({data:[],total:0,next_offset:null});
 }});
 await createAgentTools(client,{connector:'github',externalUserId:'u',connectionId:'c'}).call('list_tools',{});
});
