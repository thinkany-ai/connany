import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertPublicUrl,discoverServer,guardFetch,isPublicAddress,type HostLookup} from '../src/connectors/remote-mcp.js';
import {ConnectorRuntime} from '../src/connectors/index.js';
import {connector,customDefinitions,isConnectorName} from '../src/connectors/catalog.js';
import {definitionOf,monogram} from '../src/custom-connectors.js';
import {AppError} from '../src/errors.js';
import {config} from './support.js';
import {fakeServer,publicLookup} from './remote-server.js';

const code=async(promise:Promise<unknown>)=>{try{await promise;}catch(error){return error instanceof AppError?error.code:String(error);}return 'resolved';};

test('only public addresses pass: private, loopback, link-local, mapped and NAT64 forms are refused',()=>{
 for(const ip of ['93.184.216.34','8.8.8.8','2606:4700::1111'])assert(isPublicAddress(ip),ip);
 for(const ip of ['10.0.0.1','127.0.0.1','169.254.169.254','172.16.5.4','192.168.1.1','100.64.0.1','0.0.0.0','224.0.0.1','::1','::','fc00::1','fd12::1','fe80::1','ff02::1','::ffff:127.0.0.1','::ffff:7f00:1','64:ff9b::10.0.0.1','2001:db8::1','not-an-ip'])assert(!isPublicAddress(ip),ip);
});

test('the fake-IP range passes only with the development switch',async()=>{
 const fakeIp:HostLookup=async()=>[{address:'198.18.8.116',family:4}];
 assert(!isPublicAddress('198.18.8.116'));assert(isPublicAddress('198.18.8.116',true));assert(!isPublicAddress('10.0.0.1',true));
 assert.equal(await code(assertPublicUrl('https://feeds.example/mcp',fakeIp)),'server_not_public');
 assert.equal((await assertPublicUrl('https://feeds.example/mcp',fakeIp,true)).host,'feeds.example');
});

test('server URLs must be https, credential-free and resolve publicly; the guard checks every request and never follows redirects',async()=>{
 assert.equal(await code(assertPublicUrl('http://feeds.example/mcp',publicLookup)),'invalid_server_url');
 assert.equal(await code(assertPublicUrl('https://u:p@feeds.example/mcp',publicLookup)),'invalid_server_url');
 assert.equal(await code(assertPublicUrl('https://169.254.169.254/latest',publicLookup)),'server_not_public');
 assert.equal(await code(assertPublicUrl('https://[::1]/mcp',publicLookup)),'server_not_public');
 // One private answer among several is enough to refuse (a rebinding-style split answer).
 assert.equal(await code(assertPublicUrl('https://feeds.example/mcp',async()=>[{address:'93.184.216.34',family:4},{address:'10.0.0.5',family:4}])),'server_not_public');
 assert.equal(await code(assertPublicUrl('https://nowhere.example/mcp',async()=>[])),'server_unreachable');
 let init:RequestInit|undefined;
 const guarded=guardFetch(async(_url,i)=>{init=i;return new Response('ok');},async host=>host==='inside.example'?[{address:'10.1.2.3',family:4}]:[{address:'93.184.216.34',family:4}]);
 await guarded('https://feeds.example/x',{redirect:'follow'});assert.equal(init?.redirect,'error');
 assert.equal(await code(guarded('https://inside.example/token')),'server_not_public');
});

test('discovery follows the MCP authorization spec to a hosted-MCP style definition',async()=>{
 const {fetcher}=fakeServer();
 const server=await discoverServer(' https://feeds.example/mcp/ ',fetcher,publicLookup);
 assert.equal(server.url,'https://feeds.example/mcp');assert.equal(server.label,'Feeds');assert.equal(server.website,'https://feeds.example');
 assert.deepEqual(server.mcp,{origin:'https://feeds.example',endpoint:'/mcp',oauth:{authorize:'https://feeds.example/oauth/authorize',token:'https://feeds.example/oauth/token',register:'https://feeds.example/oauth/register'},scope:'feeds',clientAuth:'none',resource:'https://feeds.example/mcp'});
});

test('discovery refuses servers it cannot authorize safely, with closed codes',async()=>{
 const base={issuer:'https://feeds.example',authorization_endpoint:'https://feeds.example/oauth/authorize',token_endpoint:'https://feeds.example/oauth/token',registration_endpoint:'https://feeds.example/oauth/register',code_challenge_methods_supported:['S256']};
 const cases:[Parameters<typeof fakeServer>[0],string][]=[
  [{probe:()=>Response.json({jsonrpc:'2.0',id:1,result:{}})},'server_auth_unsupported'],
  [{probe:()=>new Response('nope',{status:404})},'not_mcp_server'],
  [{resource:null},'server_auth_unsupported'],
  // Metadata naming another server's resource: a server collecting tokens meant for someone else.
  [{resource:{resource:'https://bank.example/mcp',authorization_servers:['https://feeds.example']}},'server_auth_unsupported'],
  [{auth:{...base,issuer:'https://other.example'}},'server_auth_unsupported'],
  [{auth:{...base,registration_endpoint:undefined}},'server_registration_unsupported'],
  [{auth:{...base,code_challenge_methods_supported:['plain']}},'server_auth_unsupported'],
  [{auth:{...base,code_challenge_methods_supported:undefined}},'server_auth_unsupported'],
  [{auth:{...base,token_endpoint:'http://feeds.example/oauth/token'}},'server_auth_unsupported'],
  [{auth:{...base,token_endpoint_auth_methods_supported:['private_key_jwt']}},'server_auth_unsupported'],
 ];
 for(const [overrides,expected] of cases)assert.equal(await code(discoverServer('https://feeds.example/mcp',fakeServer(overrides).fetcher,publicLookup)),expected,JSON.stringify(overrides));
 assert.equal(await code(discoverServer('https://feeds.example/mcp?key=1',fakeServer().fetcher,publicLookup)),'invalid_server_url');
});

test('a custom definition authorizes, exchanges and calls tools through the guarded fetcher only',async()=>{
 const {fetcher,seen}=fakeServer();
 const server=await discoverServer('https://feeds.example/mcp',fetcher,publicLookup);
 const name='mcp_0123456789' as const;
 assert(isConnectorName(name));assert(!isConnectorName('mcp_short'));
 customDefinitions.set(name,definitionOf({label:server.label,website:server.website,spec:server.mcp}));
 try{
  let lookups=0;
  const runtime=new ConnectorRuntime({...config,connectors:{...config.connectors,[name]:{clientId:'feeds-client',clientSecret:'',authMethod:'none'}}},fetcher,async host=>{lookups++;return publicLookup(host);});
  const authorize=new URL(runtime.authorizeUrl(name,'state','verifier'));
  assert.equal(authorize.origin+authorize.pathname,'https://feeds.example/oauth/authorize');
  assert.equal(authorize.searchParams.get('resource'),'https://feeds.example/mcp');assert.equal(authorize.searchParams.get('scope'),'feeds');
  assert.equal(authorize.searchParams.get('redirect_uri'),`http://localhost:3000/oauth/${name}/callback`);
  const {credential}=await runtime.exchange(name,'code','verifier');
  const tools=await runtime.mcp(name).tools(credential);
  assert.deepEqual(tools.map(t=>[t.name,t.read_only]),[[`${name}.list_feeds`,true],[`${name}.add_feed`,false]]);
  const result:any=await runtime.execute(`${name}.list_feeds`,{},credential,true);
  assert.equal(result.content[0].text,'called list_feeds');
  assert(lookups>=4,'every upstream request resolves the host first');
  assert(seen.every(line=>line.includes('https://feeds.example/')));
 }finally{customDefinitions.delete(name);}
});

test('an unknown custom name is not a connector, and monograms escape markup',()=>{
 assert.equal((()=>{try{connector('mcp_aaaaaaaaaa');}catch(error){return (error as AppError).code;}})(),'connector_not_found');
 assert(monogram('<script>').includes('>S</text>'));assert(monogram('飞书').includes('>飞</text>'));assert(monogram('---').includes('>?</text>'));
});
