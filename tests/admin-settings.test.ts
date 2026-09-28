import {test} from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {AdminAuth,hashPassword,verifyPassword} from '../src/admin/auth.js';

test('password change requires current password, stores hash and invalidates sessions atomically',async()=>{
 const old='original-password-123';const next='replacement-password-456';
 let stored=await hashPassword(old);let revoked=false;let audited=false;const statements:string[]=[];
 const client={release(){},async query(sql:string,params:unknown[]=[]){
  statements.push(sql);
  if(sql.startsWith('SELECT password_hash'))return {rows:[{password_hash:stored}]};
  if(sql.startsWith('UPDATE admin_users')){assert.equal(params[1],'admin-1');stored=String(params[0]);}
  if(sql.startsWith('DELETE FROM admin_sessions')){assert.deepEqual(params,['admin-1']);revoked=true;}
  if(sql.startsWith('INSERT INTO admin_audit')){assert.deepEqual(params,['admin-1','admin.password_changed']);audited=true;}
  return {rows:[]};
 }};
 const auth=new AdminAuth({query:async()=>({rows:[{count:1}]}),connect:async()=>client} as unknown as pg.Pool);
 await assert.rejects(()=>auth.changePassword('admin-1','wrong',next),{code:'invalid_password'});
 assert.equal(revoked,false);assert(statements.includes('ROLLBACK'));
 await assert.rejects(()=>auth.changePassword('admin-1',old,old),{code:'password_unchanged'});
 await auth.changePassword('admin-1',old,next);
 assert.equal(await verifyPassword(next,stored),true);assert.equal(await verifyPassword(old,stored),false);
 assert(revoked&&audited);assert.equal(statements.at(-1),'COMMIT');assert(!statements.some(s=>s.includes(next)));
});

test('password changes enforce strength and attempt limits before acquiring a transaction',async()=>{
 const auth=new AdminAuth({query:async()=>({rows:[{count:11}]}),connect:async()=>{throw new Error('must not connect');}} as unknown as pg.Pool);
 await assert.rejects(()=>auth.changePassword('admin-1','old','short'));
 await assert.rejects(()=>auth.changePassword('admin-1','old','long-new-password'),{code:'password_rate_limited'});
});
