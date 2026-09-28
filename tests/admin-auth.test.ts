import {test} from 'node:test';
import assert from 'node:assert/strict';
import {hashPassword,verifyPassword,csrfToken} from '../src/admin/auth.js';
test('admin passwords use salted scrypt; wrong passwords and malformed hashes fail',async()=>{
  const password='test-only-admin-password';const one=await hashPassword(password);const two=await hashPassword(password);
  assert.notEqual(one,two);assert(!one.includes(password));assert.equal(await verifyPassword(password,one),true);
  assert.equal(await verifyPassword('wrong',one),false);assert.equal(await verifyPassword(password,'broken'),false);
  assert.notEqual(csrfToken('first'),csrfToken('second'));
});
