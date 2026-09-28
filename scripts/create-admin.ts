import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { createPool } from '../src/db.js';
import { createAdmin, emailSchema } from '../src/admin/auth.js';
const email=emailSchema.parse(process.argv[2]);
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
async function passwordInput() {
  if (process.argv.includes('--password-stdin')) {
    let value='';for await (const chunk of process.stdin) { value+=chunk; if (value.length>1024) throw new Error('Password input too long'); }
    return value.replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY) throw new Error('Use an interactive terminal, or --password-stdin for automated provisioning.');
  const silent=new Writable({write(_chunk,_encoding,callback){callback();}});
  const rl=createInterface({input:process.stdin,output:silent,terminal:true});
  const prompt=(text:string)=>new Promise<string>(resolve=>{process.stdout.write(text);rl.question('',answer=>{process.stdout.write('\n');resolve(answer);});});
  try { const first=await prompt('Password (at least 12 characters, hidden): ');const second=await prompt('Confirm password: ');if(first!==second)throw new Error('Passwords do not match.');return first; }
  finally {rl.close();}
}
const password=await passwordInput();
const pool=createPool(process.env.DATABASE_URL);
try {const admin=await createAdmin(pool,email,password);console.log(`Administrator ${admin.email} is ready. Sign in at /admin. Existing sessions for this account have been revoked.`);}
finally {await pool.end();}
