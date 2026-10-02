import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';
import type {Service} from '../src/service.js';
import {AppError} from '../src/errors.js';
import {Connany,createAgentTools} from '../sdk/client.js';

const post = (body: unknown) => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});

test('connection check preserves ownership and upstream errors without executing business tools',async()=>{
 let calls=0;
 let expired=false;
 const app=createApp({initialize:async()=>{},authenticate:async()=>({id:'project'}),
  getConnection:async(p:string,u:string,id:string)=>{
   assert.equal(p,'project');
   if(u!=='alice'||id!=='conn')throw new AppError('not_found','Connection not found.',404);
   return {id,connector:'notion'};
  },
  execute:async(...args:unknown[])=>{
   calls++;assert.deepEqual(args,['project','alice','conn','notion.__discover',{}]);
   if(expired)throw new AppError('reauth_required','Reconnect.',409);
   return [{name:'notion.search'}];
  }
 } as unknown as Service);
 const check=(user:string)=>app.request('/v1/connections/conn/check',post({external_user_id:user}));
 assert.equal((await check('bob')).status,404);assert.equal(calls,0);
 const result=await check('alice');assert.equal(result.status,200);
 const data=await result.json();assert.equal(data.tool_count,1);assert.equal(data.connector,'notion');assert(data.request_id);assert(Number.isFinite(Date.parse(data.checked_at)));
 expired=true;const denied=await check('alice');assert.equal(denied.status,409);assert.equal((await denied.json()).error.code,'reauth_required');
 const invalid=await app.request('/v1/connections/conn/check',post({external_user_id:'alice',connector:'github'}));assert.equal(invalid.status,400);assert.equal(calls,2);
});

test('exact catalog tool is found beyond the first twenty related descriptions and called through the connection',async()=>{
 let executed=false;
 const tools=Array.from({length:30},(_,i)=>({name:`github.a${i}`,connector:'github',description:'Related to github.target',read_only:true,input_schema:{},required_permissions:[]}));
 tools.push({...tools[0],name:'github.target',description:'Target'});
 const app=createApp({initialize:async()=>{},authenticate:async()=>({id:'project'}),connectorStore:{in(){return this},catalog:async()=>tools},getConnection:async(_p:string,_u:string,c:string)=>({id:c,connector:'github',status:'connected'}),execute:async(p:string,u:string,c:string,a:string)=>{
  assert.deepEqual([p,u,c],['project','alice','conn']);
  assert.equal(a,'github.target');executed=true;return {ok:true};
 }} as unknown as Service);
 const client=new Connany({baseUrl:'https://connany.example',apiKey:'test',fetch:async(url,init)=>app.request(String(url),init)});
 await createAgentTools(client,{externalUserId:'alice',connectionId:'conn',connector:'github'}).call('call_tool',{tool:'github.target',input:{}});
 assert(executed);
});

test('connection filter validation rejects unknown runtime and statuses before database access',async()=>{
 let queries=0;
 const app=createApp({initialize:async()=>{},authenticate:async()=>({id:'p'}),pool:{query:async()=>{queries++;return {rows:[]};}}} as unknown as Service);
 for(const filter of ['connector=unknown','status=healthy','limit=101'])assert.equal((await app.request('/v1/connections?external_user_id=alice&'+filter)).status,400);
 assert.equal(queries,0);
});

test('connectors list only enabled connectors with title, description and public avatar',async()=>{
 const app=createApp({initialize:async()=>{},authenticate:async()=>({id:'project'}),runtime:{config:{publicBaseUrl:'https://connany.example'}},connectorStore:{in(){return this},list:async()=>[
  {name:'notion',enabled:true},{name:'github',enabled:true,installation_url:'https://github.com/apps/demo/installations/new'},{name:'linear',enabled:false},
 ]}} as unknown as Service);
 const body=await (await app.request('/v1/connectors')).json() as any;
 assert.deepEqual(body.data,[
  {name:'notion',title:'Notion',description:'页面、数据库与工作区搜索',avatar_url:'https://connany.example/connectors/notion/avatar.svg'},
  {name:'github',title:'GitHub',description:'仓库、Issue 与 Pull Request',avatar_url:'https://connany.example/connectors/github/avatar.svg'},
 ]);
 const avatar=await app.request('/connectors/linear/avatar.svg');
 assert.equal(avatar.status,200);assert.equal(avatar.headers.get('Content-Type'),'image/svg+xml');assert((await avatar.text()).startsWith('<svg'));
 assert.equal((await app.request('/connectors/unknown/avatar.svg')).status,400);
});

test('connector sessions read the connector from the path',async()=>{
 const created:any[]=[];
 const app=createApp({initialize:async()=>{},authenticate:async()=>({id:'project'}),createSession:async(_p:unknown,input:any)=>{created.push(input);return {id:'cs_1',connector:input.connector};}} as unknown as Service);
 assert.equal((await app.request('/v1/connectors/linear/sessions',post({external_user_id:'u'}))).status,201);
 assert.equal((await app.request('/v1/connectors/unknown/sessions',post({external_user_id:'u'}))).status,404);
 assert.equal((await app.request('/v1/connectors/linear/sessions',post({external_user_id:'u',connector:'notion'}))).status,400);
 assert.deepEqual(created.map(i=>i.connector),['linear']);
 const client=new Connany({baseUrl:'https://connany.example',apiKey:'key',fetch:async(url,init)=>app.request(String(url),init)});
 assert.equal((await client.createSession('github',{external_user_id:'u'})).connector,'github');
});
