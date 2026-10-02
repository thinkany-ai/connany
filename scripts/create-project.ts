import { createPool } from '../src/db.js';
import { hash, id, randomToken } from '../src/crypto.js';
import { transaction } from '../src/db.js';
import { defaultWorkspaceId } from '../src/workspaces.js';
const [name, ...urls] = process.argv.slice(2);
if (!name || !process.env.DATABASE_URL) throw new Error('Usage: npm run project:create -- "Agent name" https://agent.example/settings/connections');
for (const value of urls) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw new Error('Return URLs must use HTTPS (HTTP allowed on localhost), without credentials or fragments.');
}
const pool = createPool(process.env.DATABASE_URL);
try {
  const projectId = id('proj'); const key = `cn_live_${randomToken()}`;
  await transaction(pool, async db => {
    await db.query('INSERT INTO projects(id,workspace_id,name,return_urls) VALUES($1,$2,$3,$4)', [projectId, defaultWorkspaceId, name, JSON.stringify(urls)]);
    await db.query('INSERT INTO api_keys(id,project_id,key_hash,key_prefix) VALUES($1,$2,$3,$4)', [id('key'), projectId, hash(key), key.slice(0,16)]);
  });
  console.log(JSON.stringify({ project_id: projectId, api_key: key, return_urls: urls, note: 'Save this key in your agent backend secrets. It will not be shown again.' }, null, 2));
} finally { await pool.end(); }
