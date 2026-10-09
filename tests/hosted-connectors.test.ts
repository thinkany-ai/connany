import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HostedMcp} from '../src/connectors/hosted-mcp.js';
import {ConnectorRuntime} from '../src/connectors/index.js';
import {connector,connectorNames} from '../src/connectors/catalog.js';
import {genericIdentity} from '../src/connectors/mcp-identity.js';
import {config,connectorClients} from './support.js';

const jwt=(claims:object)=>`${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

test('every hosted MCP connector declares HTTPS endpoints, a resource on its own origin and a usable icon',()=>{
 for(const name of connectorNames){
  const spec=connector(name);
  assert(spec.icon.startsWith('<svg')&&spec.icon.includes('xmlns'),name);
  if(spec.auth!=='mcp')continue;
  const mcp=new HostedMcp(fetch,name);
  for(const kind of ['authorize','token','register'] as const)assert.match(mcp.oauthUrl(kind)!,/^https:\/\//,`${name} ${kind}`);
  if(typeof spec.mcp!.resource==='string')assert.equal(new URL(spec.mcp!.resource).origin,spec.mcp!.origin,name);
 }
});

test('confidential clients register with metadata endpoints and authenticate token requests with their secret',async()=>{
 const seen:{url:string;body:string;auth:string|null}[]=[];
 const fetcher:typeof fetch=async(url,init)=>{
  seen.push({url:String(url),body:String(init?.body),auth:new Headers(init?.headers).get('Authorization')});
  if(String(url).endsWith('/register'))return Response.json({client_id:'vc',client_secret:'vs',token_endpoint_auth_method:'client_secret_post'});
  return Response.json({access_token:'at',refresh_token:'rt',expires_in:3600});
 };
 const client=await new HostedMcp(fetcher,'vercel').register('https://connany.example/oauth/vercel/callback');
 assert.deepEqual(client,{clientId:'vc',clientSecret:'vs',authMethod:'client_secret_post'});
 assert.equal(seen[0].url,'https://api.vercel.com/login/oauth/register');
 const registration=JSON.parse(seen[0].body);assert.equal(registration.token_endpoint_auth_method,'client_secret_post');assert.equal(registration.scope,'openid email profile offline_access');
 const runtime=new ConnectorRuntime({...config,connectors:connectorClients({vercel:{clientId:'vc',clientSecret:'vs',authMethod:'client_secret_post'}})},fetcher);
 const authorize=new URL(runtime.authorizeUrl('vercel','state','verifier'));
 assert.equal(authorize.origin+authorize.pathname,'https://vercel.com/oauth/authorize');
 assert.equal(authorize.searchParams.get('scope'),'openid email profile offline_access');assert.equal(authorize.searchParams.get('resource'),'https://mcp.vercel.com/');
 assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
 await runtime.exchange('vercel','code','verifier');
 const exchange=seen.at(-1)!;assert.equal(exchange.url,'https://api.vercel.com/login/oauth/token');
 const fields=new URLSearchParams(exchange.body);assert.equal(fields.get('client_secret'),'vs');assert.equal(fields.get('resource'),'https://mcp.vercel.com/');assert.equal(fields.get('code_verifier'),'verifier');
 // Basic authentication keeps the secret out of the body.
 const basic=new HostedMcp(fetcher,'vercel');await basic.token({clientId:'vc',clientSecret:'vs',authMethod:'client_secret_basic'},{grant_type:'refresh_token',refresh_token:'rt'});
 assert.equal(seen.at(-1)!.auth,`Basic ${Buffer.from('vc:vs').toString('base64')}`);assert(!seen.at(-1)!.body.includes('vs'));
 // A confidential registration without a secret is rejected instead of silently degrading.
 await assert.rejects(()=>new HostedMcp(async()=>Response.json({client_id:'x'}),'gitlab').register('https://connany.example/oauth/gitlab/callback'),{code:'invalid_client_registration'});
});

test('public clients register without a secret, and revocation uses the revocation endpoint or is skipped',async()=>{
 const urls:string[]=[];
 const fetcher:typeof fetch=async(url,init)=>{urls.push(String(url));return String(url).endsWith('/register')?Response.json({client_id:'pub'}):Response.json({});};
 assert.deepEqual(await new HostedMcp(fetcher,'sentry').register('https://connany.example/oauth/sentry/callback'),{clientId:'pub',clientSecret:'',authMethod:'none'});
 assert.equal(urls[0],'https://mcp.sentry.dev/oauth/register');
 await new HostedMcp(fetcher,'posthog').revoke({clientId:'pub',clientSecret:'',authMethod:'none'},{accessToken:'a',refreshToken:'r'});
 assert.equal(urls.at(-1),'https://oauth.posthog.com/oauth/revoke/');
 const before=urls.length;await new HostedMcp(fetcher,'clickup').revoke({clientId:'pub',clientSecret:'',authMethod:'none'},{accessToken:'a'});
 assert.equal(urls.length,before);
});

test('generic identity prefers userinfo, then id_token, then the JWT access token, and otherwise marks the account unverified',async()=>{
 const userinfo=new HostedMcp(async()=>Response.json({sub:'u-1',name:'Mike',email:'mike@example.com'}),'posthog');
 assert.deepEqual(await genericIdentity(userinfo,{accessToken:jwt({sub:'other'})},{},'PostHog'),{account_id:'u-1',account_name:'Mike',email:'mike@example.com',transport:'mcp'});
 const todoist=new HostedMcp(async()=>Response.json({id:42,full_name:'Mike Tang'}),'todoist');
 assert.equal((await genericIdentity(todoist,{accessToken:'opaque'},{},'Todoist')).account_name,'Mike Tang');
 const offline=new HostedMcp(async()=>{throw new Error('down');},'miro');
 assert.equal((await genericIdentity(offline,{accessToken:'opaque'},{id_token:jwt({sub:'m-1',email:'m@example.com'})},'Miro')).account_id,'m-1');
 assert.equal((await genericIdentity(new HostedMcp(fetch,'sentry'),{accessToken:jwt({sub:'s-1',preferred_username:'mike'})},{},'Sentry')).account_name,'mike');
 const unknown=await genericIdentity(new HostedMcp(fetch,'stripe'),{accessToken:'opaque'},{},'Stripe');
 assert.match(unknown.account_id,/^unverified_/);assert.equal(unknown.unverified,true);assert.equal(unknown.account_name,'Stripe 账号');
 // An expired token during the userinfo lookup is still an authorization failure.
 await assert.rejects(()=>genericIdentity(new HostedMcp(async()=>new Response('{}',{status:401}),'posthog'),{accessToken:'x'},{},'PostHog'),{status:401});
});

test('registration failures keep the upstream OAuth error for administrators',async()=>{
 const rejecting=new HostedMcp(async()=>Response.json({error:'invalid_redirect_uri',error_description:'Redirect URI must use an allowed domain'},{status:400}),'atlassian');
 await assert.rejects(()=>rejecting.register('https://connany.example/oauth/atlassian/callback'),(error:any)=>{
  assert.equal(error.code,'upstream_error');assert.equal(error.details.upstream_status,400);
  assert.equal(error.details.upstream_error,'invalid_redirect_uri');assert.equal(error.details.upstream_error_description,'Redirect URI must use an allowed domain');
  return true;
 });
});

test('the SDK names every catalog connector and every connector has a category',async()=>{
 const {readFile}=await import('node:fs/promises');const sdk=await readFile('sdk/client.ts','utf8');
 const union=sdk.match(/export type ConnectorName = ([^;]+);/)![1];
 assert.deepEqual([...union.matchAll(/'([a-z_]+)'/g)].map(m=>m[1]).sort(),[...connectorNames].sort());
 const {connectorCategories}=await import('../src/connectors/catalog.js');
 for(const name of connectorNames)assert((connectorCategories as readonly string[]).includes(connector(name).category),name);
});

test('connector descriptions and category titles exist in every supported language',async()=>{
 const {categoryTitles,connectorCategories,locales,pickLocale}=await import('../src/connectors/catalog.js');
 for(const locale of locales){
  for(const name of connectorNames)assert(connector(name).description[locale]?.trim(),`${name} ${locale}`);
  for(const category of connectorCategories)assert(categoryTitles[category][locale]?.trim(),`${category} ${locale}`);
 }
 assert.equal(pickLocale(undefined,'fr-FR,zh-CN;q=0.8'),'zh-CN');assert.equal(pickLocale('en','zh-CN'),'en');assert.equal(pickLocale(undefined,undefined),'en');
});

test('connector MCP headers are sent on every request and large tool catalogs are accepted',async()=>{
 const seen:(string|null)[]=[];
 const big='x'.repeat(5*1024*1024);
 const fetcher=async(_url:any,init:any)=>{
  const headers=new Headers(init.headers);seen.push(headers.get('x-posthog-mcp-mode'));
  const body=JSON.parse(init.body);
  if(body.method==='initialize')return Response.json({jsonrpc:'2.0',id:body.id,result:{protocolVersion:'2025-06-18'}});
  if(body.method==='tools/list')return Response.json({jsonrpc:'2.0',id:body.id,result:{tools:[{name:'query-trends',description:big,inputSchema:{type:'object'},annotations:{readOnlyHint:true}}]}});
  return new Response(null,{status:202});
 };
 const tools=await new HostedMcp(fetcher as any,'posthog').tools({accessToken:'a'});
 assert.deepEqual(tools.map(t=>[t.name,t.read_only]),[['posthog.query-trends',true]]);
 assert.deepEqual(seen,['tools','tools','tools']);
});

test('a server may grant a public client when a secret was requested, and a missing secret is otherwise rejected',async()=>{
 const reply=(body:object)=>async()=>Response.json(body,{status:201});
 const pub=await new HostedMcp(reply({client_id:'cl_1',token_endpoint_auth_method:'none'}),'vercel').register('https://connany.example/oauth/vercel/callback');
 assert.deepEqual(pub,{clientId:'cl_1',clientSecret:'',authMethod:'none'});
 await assert.rejects(()=>new HostedMcp(reply({client_id:'cl_2',token_endpoint_auth_method:'client_secret_post'}),'vercel').register('https://connany.example/oauth/vercel/callback'),{code:'invalid_client_registration'});
});

test('public clients skip revocation where the server only revokes for confidential clients',async()=>{
 const urls:string[]=[];const headers:(string|null)[]=[];
 const fetcher=async(url:any,init:any)=>{urls.push(String(url));headers.push(new Headers(init.headers).get('authorization'));return new Response('{}');};
 await new HostedMcp(fetcher as any,'todoist').revoke({clientId:'pub',clientSecret:'',authMethod:'none'},{accessToken:'a'});
 assert.deepEqual(urls,[]);
 await new HostedMcp(fetcher as any,'todoist').revoke({clientId:'tdd',clientSecret:'s',authMethod:'client_secret_basic'},{accessToken:'a'});
 assert.deepEqual(urls,['https://todoist.com/api/v1/revoke']);
 assert.equal(headers[0],`Basic ${Buffer.from('tdd:s').toString('base64')}`);
});
