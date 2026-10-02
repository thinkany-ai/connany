import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
const source = await readFile('.env.example', 'utf8');
try {
  await writeFile('.env', source.replace('TOKEN_ENCRYPTION_KEY=', `TOKEN_ENCRYPTION_KEY=${randomBytes(32).toString('base64')}`), { flag: 'wx', mode: 0o600 });
console.log('Created .env with a random encryption key. Existing .env files are never overwritten. Configure connector credentials in /admin before connecting.');

} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  console.log('.env already exists; kept the existing configuration and encryption key.');
}
