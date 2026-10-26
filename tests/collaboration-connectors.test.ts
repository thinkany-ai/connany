import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorRuntime, restToolCatalog } from '../src/connectors/index.js';
import { HostedMcp } from '../src/connectors/hosted-mcp.js';
import { config, connectorClients } from './support.js';

const credential = { accessToken: 'access', refreshToken: 'refresh' };
function setup(respond: (url: string, init: RequestInit) => Response = () => Response.json({})) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const runtime = new ConnectorRuntime({ ...config, connectors: connectorClients({slack:{clientId:'slack-client',clientSecret:'slack-secret'},figma:{clientId:'figma-client',clientSecret:'figma-secret',authMethod:'client_secret_post'},microsoft_365:{clientId:'ms-client',clientSecret:'ms-secret'}}) }, async(url, init) => {
    calls.push({ url:String(url),init:init!,body:init?.body && String(init.body).startsWith('{') ? JSON.parse(String(init.body)) : String(init?.body || '') });
    return respond(String(url),init!);
  });
  return {runtime,calls};
}
function mcpResponse(init: RequestInit) {
  const req=JSON.parse(String(init.body));
  if (req.method==='notifications/initialized') return new Response(null,{status:202});
  const result=req.method==='initialize' ? {protocolVersion:'2025-03-26',capabilities:{},serverInfo:{name:'official',version:'1'}} : req.method==='tools/list' ? {tools:[{name:'search',description:'Search',inputSchema:{type:'object'},annotations:{readOnlyHint:true}},{name:'create',inputSchema:{type:'object'}}]} : {content:[{type:'text',text:'done'}]};
  return Response.json({jsonrpc:'2.0',id:req.id,result});
}

test('Slack uses manually configured user OAuth, PKCE, workspace identity and rotating tokens', async()=>{
  const raw={ok:true,access_token:'new',refresh_token:'rotated',expires_in:3600,authed_user:{id:'U1',scope:'chat:write,canvases:read'},team:{id:'T1',name:'Acme'}};
  const {runtime,calls}=setup(()=>Response.json(raw));
  const auth=new URL(runtime.authorizeUrl('slack','state','verifier'));
  assert.equal(auth.origin+auth.pathname,'https://slack.com/oauth/v2_user/authorize');
  assert.equal(auth.searchParams.get('resource'),'https://mcp.slack.com');assert.equal(auth.searchParams.get('code_challenge_method'),'S256');assert(auth.searchParams.get('scope')!.includes('canvases:write'));
  const exchange=await runtime.exchange('slack','code','verifier');
  assert.equal(calls[0].url,'https://slack.com/api/oauth.v2.user.access');assert.equal(new URLSearchParams(calls[0].body).get('client_secret'),'slack-secret');
  assert.deepEqual(exchange.credential.scopes,['chat:write','canvases:read']);
  assert.deepEqual(await runtime.identify('slack',exchange.credential,exchange.raw),{account_id:'U1',account_name:'U1',workspace_id:'T1',workspace_name:'Acme',transport:'mcp'});
  assert.equal((await runtime.refresh('slack',credential)).refreshToken,'rotated');
  await runtime.revoke('slack',credential);assert.equal(calls.at(-1)!.url,'https://slack.com/api/auth.revoke');assert.equal(new URLSearchParams(calls.at(-1)!.body).get('token'),'access');
  await assert.rejects(()=>runtime.identify('slack',credential,{...raw,team:{}}),{code:'invalid_upstream_identity'});
  await assert.rejects(()=>runtime.mcp('slack').register('https://example.com/callback'),{code:'oauth_client_required'});
});

test('Slack rejects HTTP 200 OAuth failures and invalid refresh tokens',async()=>{
  const {runtime}=setup(()=>Response.json({ok:false,error:'invalid_refresh_token'}));
  await assert.rejects(()=>runtime.refresh('slack',credential),{code:'reauth_required',status:401});
  const failed=setup(()=>Response.json({ok:false}));
  await assert.rejects(()=>failed.runtime.exchange('slack','code','verifier'),{code:'upstream_error'});
});

test('Slack and Figma load official MCP tool schemas and route calls without dynamic registration for Slack',async()=>{
  for (const name of ['slack','figma'] as const) {
    const {runtime,calls}=setup((_url,init)=>mcpResponse(init));
    const tools=await runtime.tools(name,credential);
    assert.deepEqual(tools.map(t=>[t.name,t.read_only]),[[`${name}.search`,true],[`${name}.create`,false]]);
    await runtime.execute(`${name}.search`,{query:'test'},credential,true);
    assert(calls.every(c=>c.url===`https://mcp.${name}.com/mcp`));
    assert(calls.every(c=>new Headers(c.init.headers).get('Authorization')==='Bearer access'));
    assert.deepEqual(calls.at(-1)!.body.params,{name:'search',arguments:{query:'test'}});
  }
});

test('Figma registers a confidential client and uses official OAuth endpoints and resource',async()=>{
  const registration:any[]=[];
  const client=await new HostedMcp(async(url,init)=>{registration.push({url:String(url),body:JSON.parse(String(init!.body))});return Response.json({client_id:'fc',client_secret:'fs',token_endpoint_auth_method:'client_secret_post'});},'figma').register('https://example.com/oauth/figma/callback');
  assert.equal(client.authMethod,'client_secret_post');assert.equal(registration[0].url,'https://api.figma.com/v1/oauth/mcp/register');assert.equal(registration[0].body.scope,'mcp:connect');
  const {runtime,calls}=setup(()=>Response.json({access_token:'at',expires_in:3600}));
  const auth=new URL(runtime.authorizeUrl('figma','state','verifier'));
  assert.equal(auth.origin+auth.pathname,'https://www.figma.com/oauth/mcp');assert.equal(auth.searchParams.get('resource'),'https://mcp.figma.com/mcp');
  await runtime.exchange('figma','code','verifier');assert.equal(calls[0].url,'https://api.figma.com/v1/oauth/token');assert.equal(new URLSearchParams(calls[0].body).get('client_secret'),'figma-secret');
  assert.equal((await runtime.refresh('figma',credential)).refreshToken,'refresh');
  const before=calls.length;await runtime.revoke('figma',credential);assert.equal(calls.length,before);
});

test('Microsoft 365 uses organizational OAuth and exposes both Outlook and collaboration tools',async()=>{
  const {runtime,calls}=setup(url=>url.endsWith('/token')?Response.json({access_token:'new',refresh_token:'rotated'}):Response.json({id:'u1',mail:'me@example.com'}));
  const auth=new URL(runtime.authorizeUrl('microsoft_365','state','verifier'));
  assert.equal(auth.pathname,'/organizations/oauth2/v2.0/authorize');
  for(const scope of ['Mail.Send','Sites.Read.All','Files.Read.All','Chat.Read','ChannelMessage.Read.All','ChatMessage.Send'])assert(auth.searchParams.get('scope')!.includes(scope));
  await runtime.exchange('microsoft_365','code','verifier');assert.equal(new URLSearchParams(calls[0].body).get('redirect_uri'),'http://localhost:3000/oauth/microsoft_365/callback');
  assert.equal((await runtime.refresh('microsoft_365',credential)).refreshToken,'rotated');
  assert.equal((await runtime.identify('microsoft_365',credential,{})).account_id,'u1');
  const tools=restToolCatalog('microsoft_365');assert.equal(tools.length,32);assert(tools.every(t=>t.connector==='microsoft_365'&&t.input_schema.type==='object'));
  assert.equal(tools.find(t=>t.name==='microsoft_365.search')?.read_only,true);
  assert.equal(tools.find(t=>t.name==='microsoft_365.send_chat_message')?.read_only,false);
  await runtime.execute('microsoft_365.send_message',{to:['a@example.com'],subject:'Hi',body:'Hello'},credential);
  assert.equal(calls.at(-1)!.url,'https://graph.microsoft.com/v1.0/me/sendMail');
});

test('Microsoft 365 scopes files to a drive, expands list fields and encodes site and channel IDs',async()=>{
  const {runtime,calls}=setup(()=>Response.json({value:[{id:'1'}],'@odata.nextLink':'next'}));
  assert.deepEqual(await runtime.execute('microsoft_365.list_files',{drive_id:'b!drive',folder_id:'folder'},credential),{items:[{id:'1'}],next_page_url:'next'});
  assert.equal(new URL(calls[0].url).pathname,'/v1.0/drives/b!drive/items/folder/children');
  await runtime.execute('microsoft_365.list_list_items',{site_id:'host,id1,id2',list_id:'list1'},credential);
  assert.equal(new URL(calls[1].url).searchParams.get('$expand'),'fields');assert(calls[1].url.includes('host%2Cid1%2Cid2'));
  await runtime.execute('microsoft_365.search',{query:'annual report',entity_type:'driveItem',from:25,size:25},credential);
  assert.deepEqual(calls[2].body,{requests:[{entityTypes:['driveItem'],query:{queryString:'annual report'},from:25,size:25}]});
  await runtime.execute('microsoft_365.send_channel_message',{team_id:'team1',channel_id:'19:channel@thread.tacv2',message_id:'123',body:{content:'Hello'}},credential);
  assert(calls[3].url.endsWith('/channels/19%3Achannel%40thread.tacv2/messages/123/replies'));assert.deepEqual(calls[3].body,{body:{contentType:'text',content:'Hello'}});
});

test('Microsoft 365 pagination rejects other origins and resources before using a bearer token',async()=>{
  const {runtime,calls}=setup();
  const page_url='https://graph.microsoft.com/v1.0/me/drive/root/children?$skiptoken=abc';
  await runtime.execute('microsoft_365.list_files',{page_url},credential);assert.equal(calls[0].url,page_url);
  for(const bad of ['https://evil.example/v1.0/me/drive/root/children','https://graph.microsoft.com/v1.0/users','http://graph.microsoft.com/v1.0/me/drive/root/children','https://attacker@graph.microsoft.com/v1.0/me/drive/root/children'])await assert.rejects(()=>runtime.execute('microsoft_365.list_files',{page_url:bad},credential),{code:'invalid_page_url'});
  await assert.rejects(()=>runtime.execute('microsoft_365.get_file',{item_id:'..'},credential));assert.equal(calls.length,1);
});
