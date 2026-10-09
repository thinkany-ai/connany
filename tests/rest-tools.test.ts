import {test} from 'node:test';
import assert from 'node:assert/strict';
import {restTools,restToolCatalog,ConnectorRuntime} from '../src/connectors/index.js';
import {Connany,createAgentTools} from '../sdk/client.js';
import {config} from './support.js';

test('REST compatibility tools expose schemas, write flags and permissions under stable names',()=>{
 const catalog=restToolCatalog();
 assert.equal(catalog.filter(t=>t.connector==='github').length,18);
 const create=catalog.find(t=>t.name==='github.pull_requests.create')!;
 assert.equal(create.connector,'github');assert.equal(create.read_only,false);assert(create.input_schema.properties);
 assert(create.required_permissions.includes('Pull requests: write'));
 assert(restTools['github.repositories.list']);
});

test('GitHub operations encode paths, preserve query values, and validate writes before sending requests',async()=>{
 const calls:{url:string,init:RequestInit}[]=[];
 const runtime=new ConnectorRuntime(config,async(url,init)=>{calls.push({url:String(url),init:init!});return Response.json({ok:true});});
 const credential={accessToken:'secret'};
 await runtime.execute('github.files.get',{owner:'owner',repo:'repo',path:'folder/中文 #.txt',ref:'feature/a'},credential);
 assert(calls[0].url.includes('folder/%E4%B8%AD%E6%96%87%20%23.txt'));
 assert.equal(new URL(calls[0].url).searchParams.get('ref'),'feature/a');
 await runtime.execute('github.pull_requests.create',{owner:'owner',repo:'repo',title:'PR',head:'feature/a',base:'main'},credential);
 assert.equal(calls[1].init.method,'POST');assert.deepEqual(JSON.parse(String(calls[1].init.body)),{title:'PR',head:'feature/a',base:'main',draft:false});
 await runtime.execute('github.files.put',{owner:'owner',repo:'repo',path:'a.txt',branch:'feature/a',message:'update',content:'aGk=',sha:'a'.repeat(40)},credential);
 assert.equal(calls[2].init.method,'PUT');assert.equal(JSON.parse(String(calls[2].init.body)).sha,'a'.repeat(40));
 await assert.rejects(()=>runtime.execute('github.files.get',{owner:'owner',repo:'..',path:'x'},credential));
 await assert.rejects(()=>runtime.execute('github.files.put',{owner:'owner',repo:'repo',path:'../x',message:'x',content:'invalid'},credential));
 assert.equal(calls.length,3);
});

test('two-tool adapter binds identity and prevents model overrides and writes unless backend enables them',async()=>{
 let execution:any;
 const client=new Connany({baseUrl:'https://connany.example',apiKey:'key',fetch:async(url,init)=>{
  const target=new URL(String(url));
  if(!init?.body){const query=target.searchParams.get('query'),readOnly=target.searchParams.get('read_only');const data=restToolCatalog().filter(t=>(!query||t.name===query)&&(readOnly===null||String(t.read_only)===readOnly));return Response.json({data,total:data.length,next_offset:null});}
  execution={...JSON.parse(String(init.body)),path:target.pathname};return Response.json({data:{ok:true},request_id:'req'});
 }});
 const bound={externalUserId:'alice',connectionId:'conn-alice',connector:'github' as const};
 const readonly=createAgentTools(client,bound);
 assert.equal(readonly.tools.length,2);
 await assert.rejects(()=>readonly.call('call_tool',{tool:'github.issues.create',input:{}}),/disallowed/);
 await assert.rejects(()=>readonly.call('call_tool',{tool:'github.me.get',input:{},external_user_id:'bob'}),/Invalid/);
 const write=createAgentTools(client,{...bound,allowWrites:true,allowedTools:['github.issues.create']});
 await write.call('call_tool',{tool:'github.issues.create',input:{owner:'org',repo:'repo',title:'hello'}});
 assert.equal(execution.external_user_id,'alice');assert.equal(execution.path,'/v1/connections/conn-alice/tools/github.issues.create/call');
 await assert.rejects(()=>write.call('call_tool',{tool:'github.files.put',input:{}}),/disallowed/);
});
