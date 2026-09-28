import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Providers} from '../src/providers/index.js';
import {config} from './support.js';
import {createApp} from '../src/app.js';
import type {Service} from '../src/service.js';
import {Connany,createAgentTools} from '../sdk/client.js';

test('GitHub official MCP uses existing user token and all-tool endpoint; tool errors remain errors',async()=>{
 let denied=false;let writes=0;
 const providers=new Providers(config,async(url,init)=>{
  assert.equal(String(url),'https://api.githubcopilot.com/mcp/x/all');assert.equal(new Headers(init?.headers).get('Authorization'),'Bearer user-token');
  const rpc=JSON.parse(String(init?.body));
  if(rpc.method==='notifications/initialized')return new Response(null,{status:202});
  if(rpc.method==='tools/call'){writes++;assert.equal(rpc.params.name,'create_issue');assert.deepEqual(rpc.params.arguments,{title:'Test'});}
  const result=rpc.method==='initialize'?{protocolVersion:'2025-03-26'}:rpc.method==='tools/list'?{tools:[{name:'get_me',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},{name:'create_issue',inputSchema:{type:'object'}}]}:{isError:denied,content:[{type:'text',text:'result'}]};
  return Response.json({jsonrpc:'2.0',id:rpc.id,result});
 });
 const tools=await providers.mcp('github').tools({accessToken:'user-token'});assert.deepEqual(tools.map(t=>[t.name,t.read_only]),[['github.get_me',true],['github.create_issue',false]]);
 await providers.execute('github.create_issue',{title:'Test'},{accessToken:'user-token'});assert.equal(writes,1);
 denied=true;await assert.rejects(()=>providers.execute('github.create_issue',{title:'Test'},{accessToken:'user-token'}),{code:'mcp_tool_error'});assert.equal(writes,2);
 const auth=new URL(providers.authorizeUrl('github','state','verifier'));assert.equal(auth.origin,'https://github.com');assert.equal(auth.searchParams.get('client_id'),config.providers.github.clientId);
 await assert.rejects(()=>providers.mcp('github').register('https://example.com'),{code:'github_app_required'});
});
test('GitHub discovery requires bound connection, does not expose internal action, and SDK supplies context',async()=>{
 const service={initialize:async()=>{},authenticate:async()=>({id:'p'}),execute:async(p:string,u:string,c:string,a:string)=>{
  assert.deepEqual([p,u,c,a],['p','u','c','github.__discover']);return [];
 }} as unknown as Service;
 const app=createApp(service);
 const req=(path:string,body:any)=>app.request('http://localhost'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 assert.equal((await req('/v1/actions/discover',{provider:'github'})).status,400);
 assert.equal((await req('/v1/actions/discover',{provider:'github',external_user_id:'u',connection_id:'c'})).status,200);
 assert.equal((await req('/v1/actions/execute',{external_user_id:'u',connection_id:'c',action:'github.__discover'})).status,400);
 const client=new Connany({baseUrl:'https://example.com',apiKey:'key',fetch:async(_url,init)=>{
  const body=JSON.parse(String(init?.body));assert.equal(body.external_user_id,'u');assert.equal(body.connection_id,'c');assert.equal(body.read_only,true);return Response.json({data:[],total:0,next_offset:null});
 }});
 await createAgentTools(client,{provider:'github',externalUserId:'u',connectionId:'c'}).call('discover_actions',{});
});
