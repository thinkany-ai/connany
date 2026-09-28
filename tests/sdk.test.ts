import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Connany, ConnanyError } from '../sdk/client.js';
test('SDK encodes owner identifiers, keeps keys in headers, and preserves structured errors', async () => {
  let seen: { url: string; init?: RequestInit } | undefined;
  const sdk = new Connany({ baseUrl: 'http://localhost:3000', apiKey: 'secret', fetch: async (url,init) => {
    seen={url:String(url),init}; return Response.json({ error:{code:'reauth_required',message:'Reconnect'},request_id:'req-test' },{status:409});
  }});
  await assert.rejects(() => sdk.getConnection('conn/one','user&other=1'), e => e instanceof ConnanyError && e.code==='reauth_required' && e.requestId==='req-test');
  assert.equal(new URL(seen!.url).searchParams.get('external_user_id'),'user&other=1');
  assert(seen!.url.includes('conn%2Fone')); assert(!seen!.url.includes('secret'));
  assert.equal(new Headers(seen!.init?.headers).get('Authorization'),'Bearer secret');
});
test('SDK will not send project keys over insecure remote HTTP', () => {
  assert.throws(() => new Connany({baseUrl:'http://remote.example',apiKey:'secret'}));
});
test('SDK supports filtered connection pagination, legacy cursors and explicit checks',async()=>{
 const calls:{url:URL;init?:RequestInit}[]=[];
 const sdk=new Connany({baseUrl:'https://connany.example',apiKey:'secret',fetch:async(url,init)=>{calls.push({url:new URL(String(url)),init});return Response.json({});}});
 await sdk.listConnections('alice',{provider:'notion',status:'connected',limit:10,after:'conn/1'});
 assert.deepEqual(Object.fromEntries(calls[0].url.searchParams),{external_user_id:'alice',provider:'notion',status:'connected',limit:'10',after:'conn/1'});
 await sdk.listConnections('alice','legacy');assert.equal(calls[1].url.searchParams.get('after'),'legacy');
 await sdk.checkConnection('conn/1','alice');assert.equal(calls[2].url.pathname,'/v1/connections/conn%2F1/check');
 assert.equal(calls[2].init?.method,'POST');assert.deepEqual(JSON.parse(String(calls[2].init?.body)),{external_user_id:'alice'});
});
