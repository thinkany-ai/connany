import { createPool } from '../src/db.js';
import { hash, id, randomToken } from '../src/crypto.js';
const [name, ...urls] = process.argv.slice(2);
if (!name || !process.env.DATABASE_URL) throw new Error('Usage: npm run project:create -- "Agent name" https://agent.example/settings/connections');
for (const value of urls) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw new Error('Return URLs must use HTTPS (HTTP allowed on localhost), without credentials or fragments.');
}
const pool = createPool(process.env.DATABASE_URL);
try {
  const projectId = id('proj'); const key = `cn_live_${randomToken()}`;
  await pool.query('INSERT INTO projects(id,name,api_key_hash,return_urls,key_prefix) VALUES($1,$2,$3,$4,$5)', [projectId, name, hash(key), JSON.stringify(urls), key.slice(0,16)]);
  console.log(JSON.stringify({ project_id: projectId, api_key: key, return_urls: urls, note: 'Save this key in your agent backend secrets. It will not be shown again.' }, null, 2));
} finally { await pool.end(); }
