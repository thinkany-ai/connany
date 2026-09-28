import {test} from 'node:test';
import assert from 'node:assert/strict';
import {actions,actionCatalog,discoverActions,Providers} from '../src/providers/index.js';
import {Connany,createAgentTools} from '../sdk/client.js';
import {config} from './support.js';

test('discovery finds write operations in Chinese, provides schemas and paginates without changing legacy names',()=>{
 const result=discoverActions({provider:'github',query:'创建 PR',limit:1});
 assert.equal(result.data[0].name,'github.pull_requests.create');
 assert.equal(result.data[0].read_only,false);assert(result.data[0].input_schema.properties);
 assert(result.data[0].required_permissions.includes('Pull requests: write'));
 assert(discoverActions({provider:'github',read_only:true,limit:20}).data.every(a=>a.read_only));
 const first=discoverActions({limit:3});const second=discoverActions({limit:3,offset:first.next_offset!});
 assert(!second.data.some(a=>first.data.some(b=>a.name===b.name)));
 assert.equal(actionCatalog().length,18);
 assert(actions['github.repositories.list']);
});

test('GitHub operations encode paths, preserve query values, and validate writes before sending requests',async()=>{
 const calls:{url:string,init:RequestInit}[]=[];
 const providers=new Providers(config,async(url,init)=>{calls.push({url:String(url),init:init!});return Response.json({ok:true});});
 const credential={accessToken:'secret'};
 await providers.execute('github.files.get',{owner:'owner',repo:'repo',path:'folder/中文 #.txt',ref:'feature/a'},credential);
 assert(calls[0].url.includes('folder/%E4%B8%AD%E6%96%87%20%23.txt'));
 assert.equal(new URL(calls[0].url).searchParams.get('ref'),'feature/a');
 await providers.execute('github.pull_requests.create',{owner:'owner',repo:'repo',title:'PR',head:'feature/a',base:'main'},credential);
 assert.equal(calls[1].init.method,'POST');assert.deepEqual(JSON.parse(String(calls[1].init.body)),{title:'PR',head:'feature/a',base:'main',draft:false});
 await providers.execute('github.files.put',{owner:'owner',repo:'repo',path:'a.txt',branch:'feature/a',message:'update',content:'aGk=',sha:'a'.repeat(40)},credential);
 assert.equal(calls[2].init.method,'PUT');assert.equal(JSON.parse(String(calls[2].init.body)).sha,'a'.repeat(40));
 await assert.rejects(()=>providers.execute('github.files.get',{owner:'owner',repo:'..',path:'x'},credential));
 await assert.rejects(()=>providers.execute('github.files.put',{owner:'owner',repo:'repo',path:'../x',message:'x',content:'invalid'},credential));
 assert.equal(calls.length,3);
});

test('two-tool adapter binds identity and prevents model overrides and writes unless backend enables them',async()=>{
 let execution:any;
 const client=new Connany({baseUrl:'https://connany.example',apiKey:'key',fetch:async(url,init)=>{
  const input=JSON.parse(String(init?.body));
  if(String(url).endsWith('/discover'))return Response.json(discoverActions(input));
  execution=input;return Response.json({data:{ok:true},request_id:'req'});
 }});
 const bound={externalUserId:'alice',connectionId:'conn-alice',provider:'github' as const};
 const readonly=createAgentTools(client,bound);
 assert.equal(readonly.tools.length,2);
 await assert.rejects(()=>readonly.call('execute_action',{action:'github.issues.create',input:{}}),/disallowed/);
 await assert.rejects(()=>readonly.call('execute_action',{action:'github.me.get',input:{},external_user_id:'bob'}),/Invalid/);
 const write=createAgentTools(client,{...bound,allowWrites:true,allowedActions:['github.issues.create']});
 await write.call('execute_action',{action:'github.issues.create',input:{owner:'org',repo:'repo',title:'hello'}});
 assert.equal(execution.external_user_id,'alice');assert.equal(execution.connection_id,'conn-alice');
 await assert.rejects(()=>write.call('execute_action',{action:'github.files.put',input:{}}),/disallowed/);
});
