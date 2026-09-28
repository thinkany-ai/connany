import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Service} from '../src/service.js';
import {createApp} from '../src/app.js';
import {AppError} from '../src/errors.js';

test('GitHub OAuth without installations returns to agent or completion page, never forces installation',async()=>{
  let returnUrl:string|null='https://agent.example/done';
  const service={
    initialize:async()=>{},providers:{config:{publicBaseUrl:'http://localhost:3000'}},
    findCallback:async()=>({id:'session',provider:'github',return_url:returnUrl}),
    finish:async()=>({errorCode:null,connection:{identity:{needs_installation:true}}}),
    providerStore:{resolve:async()=>({installUrl:()=> 'https://github.com/apps/original/installations/new'})}
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
    return {provider:'github',provider_app_id:'old-app'} as any;
  };
  service.execute=async()=>({total_count:3,installations:[
    {id:1,account:{login:'org-one',type:'Organization'},html_url:'https://github.com/organizations/org-one/settings/installations/1'},
    {id:2,account:{login:'org-two',type:'Organization'},html_url:'https://evil.example/install'}
  ]});
  service.providerStore={resolve:async(provider: string,appId: string)=>{assert.equal(appId,'old-app');return {installUrl:()=> 'https://github.com/apps/old-app/installations/new'};}} as any;
  const result=await service.githubInstallations('project','owner','conn',1,2);
  assert.equal(result.installation_url,'https://github.com/apps/old-app/installations/new');
  assert.equal(result.next_page,2);assert.equal(result.data.length,2);
  assert.equal(result.data[0].management_url,'https://github.com/organizations/org-one/settings/installations/1');
  assert.equal(result.data[1].management_url,null);
  await assert.rejects(()=>service.githubInstallations('another-project','owner','conn'),{code:'not_found'});
  await assert.rejects(()=>service.githubInstallations('project','another-user','conn'),{code:'not_found'});
});
