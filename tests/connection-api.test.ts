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
   return {id,provider:'notion'};
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
 const data=await result.json();assert.equal(data.tool_count,1);assert.equal(data.provider,'notion');assert(data.request_id);assert(Number.isFinite(Date.parse(data.checked_at)));
 expired=true;const denied=await check('alice');assert.equal(denied.status,409);assert.equal((await denied.json()).error.code,'reauth_required');
 const invalid=await app.request('/v1/connections/conn/check',post({external_user_id:'alice',provider:'github'}));assert.equal(invalid.status,400);assert.equal(calls,2);
});

test('exact MCP tool is discoverable beyond the first twenty related descriptions',async()=>{
 let executed=false;
 const tools=Array.from({length:30},(_,i)=>({name:`github.a${i}`,provider:'github',description:'Related to github.target',read_only:true,input_schema:{},required_permissions:[]}));
 tools.push({...tools[0],name:'github.target',description:'Target'});
 const app=createApp({initialize:async()=>{},authenticate:async()=>({id:'project'}),execute:async(p:string,u:string,c:string,a:string)=>{
  assert.deepEqual([p,u,c],['project','alice','conn']);
  if(a==='github.__discover')return tools;
  assert.equal(a,'github.target');executed=true;return {ok:true};
 }} as unknown as Service);
 const client=new Connany({baseUrl:'https://connany.example',apiKey:'test',fetch:async(url,init)=>app.request(String(url),init)});
 await createAgentTools(client,{externalUserId:'alice',connectionId:'conn',provider:'github'}).call('execute_action',{action:'github.target',input:{}});
 assert(executed);
});

test('connection filter validation rejects unknown providers and statuses before database access',async()=>{
 let queries=0;
 const app=createApp({initialize:async()=>{},authenticate:async()=>({id:'p'}),pool:{query:async()=>{queries++;return {rows:[]};}}} as unknown as Service);
 for(const filter of ['provider=unknown','status=healthy','limit=101'])assert.equal((await app.request('/v1/connections?external_user_id=alice&'+filter)).status,400);
 assert.equal(queries,0);
});
