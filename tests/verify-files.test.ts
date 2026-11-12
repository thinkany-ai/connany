import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../src/app.js';
import type {Service} from '../src/service.js';

test('domain verification files are served at the root', async () => {
  const app=createApp({runtime:{config:{publicBaseUrl:'https://connect.example'}},initialize:async()=>{},authenticate:async()=>{throw new Error('must not authenticate');}} as unknown as Service);
  const ok=await app.request('/35ba8d47d8ba5edaa2041f991df90776.txt');
  assert.equal(ok.status,200);
  assert.equal(ok.headers.get('Content-Type'),'text/plain; charset=utf-8');
  assert.equal(await ok.text(),'4778fdeb17e630a8d54cfa574ae4e1be489f1209');
  assert.equal((await app.request('/00000000000000000000000000000000.txt')).status,404);
  // Only <32 hex>.txt names: no other file under public/ leaks this way.
  for(const path of ['/admin.css','/..%2Fpackage.json','/verify/35ba8d47d8ba5edaa2041f991df90776.txt'])assert.notEqual((await app.request(path)).status,200);
});
