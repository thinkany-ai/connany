import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Service,publicConnection} from '../src/service.js';
import {createApp} from '../src/app.js';
import {AppError} from '../src/errors.js';

test('GitHub OAuth without installations returns to agent or completion page, never forces installation',async()=>{
  let returnUrl:string|null='https://agent.example/done';
  const service={
    initialize:async()=>{},runtime:{config:{publicBaseUrl:'http://localhost:3000'}},
    findCallback:async()=>({id:'session',connector:'github',return_url:returnUrl}),
    finish:async()=>({errorCode:null,connection:{identity:{needs_installation:true}}}),
    connectorStore:{resolve:async()=>({installUrl:()=> 'https://github.com/apps/original/installations/new'})}
  } as unknown as Service;
  const app=createApp(service);
  const request=()=>app.request('http://localhost:3000/oauth/github/callback?state='+'a'.repeat(43)+'&code=code');
  const response=await request();assert.equal(response.status,302);
  assert.equal(response.headers.get('location'),'https://agent.example/done?connany_session_id=session');
  returnUrl=null;
  const completed=await request();assert.equal(completed.status,200);
  const html=await completed.text();assert(html.includes('账号已连接'));assert(html.includes('添加组织 / 仓库'));assert.equal(completed.headers.get('location'),null);
});

test('installation capabilities stay pinned to the connection app and expose only GitHub management URLs',async()=>{
  const service=Object.create(Service.prototype) as Service;
  service.getConnection=async(project,user)=>{
    if(project!=='project'||user!=='owner')throw new AppError('not_found','Not found',404);
    return {connector:'github',connector_app_id:'old-app'} as any;
  };
  service.execute=async()=>({total_count:3,installations:[
    {id:1,account:{login:'org-one',type:'Organization'},html_url:'https://github.com/organizations/org-one/settings/installations/1'},
    {id:2,account:{login:'org-two',type:'Organization'},html_url:'https://evil.example/install'}
  ]});
  service.connectorStore={resolve:async(connector: string,appId: string)=>{assert.equal(appId,'old-app');return {installUrl:()=> 'https://github.com/apps/old-app/installations/new'};}} as any;
  const result=await service.listAccess('project','owner','conn',1,2);
  assert.equal(result.add_url,'https://github.com/apps/old-app/installations/new');
  assert.equal(result.next_page,2);assert.equal(result.data.length,2);
  assert.equal(result.data[0].manage_url,'https://github.com/organizations/org-one/settings/installations/1');
  assert.equal(result.data[1].manage_url,null);
  assert.deepEqual(result.data[0],{id:'1',type:'organization',name:'org-one',selection:'selected',suspended:false,manage_url:'https://github.com/organizations/org-one/settings/installations/1'});
  await assert.rejects(()=>service.listAccess('another-project','owner','conn'),{code:'not_found'});
  await assert.rejects(()=>service.listAccess('project','another-user','conn'),{code:'not_found'});
});

test('connectors without a post-authorization access step report no access work',async()=>{
  const service=Object.create(Service.prototype) as Service;
  service.getConnection=async()=>({connector:'notion',connector_app_id:'app'} as any);
  service.execute=async()=>{throw new Error('must not call upstream');};
  assert.deepEqual(await service.listAccess('project','owner','conn'),{add_url:null,total:0,next_page:null,data:[]});
  const base={id:'c',external_user_id:'u',status:'connected',expires_at:null,revocation_status:'not_requested',created_at:new Date(),updated_at:new Date()};
  assert.equal(publicConnection({...base,connector:'notion',identity:{}} as any).needs_access,false);
  assert.equal(publicConnection({...base,connector:'github',identity:{needs_installation:true}} as any).needs_access,true);
  assert.equal(publicConnection({...base,connector:'github',identity:{needs_installation:false}} as any).needs_access,false);
});
