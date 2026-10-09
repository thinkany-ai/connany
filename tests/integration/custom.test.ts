import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { randomBytes } from 'node:crypto';
import { migrate } from '../../src/db.js';
import { createApp } from '../../src/app.js';
import { Vault, hash } from '../../src/crypto.js';
import { Service } from '../../src/service.js';
import { ConnectorRuntime } from '../../src/connectors/index.js';
import { customDefinitions } from '../../src/connectors/catalog.js';
import { config } from '../support.js';
import { fakeServer, publicLookup } from '../remote-server.js';
if (!process.env.TEST_DATABASE_URL) throw new Error('TEST_DATABASE_URL is required. Tests create and remove an isolated schema.');
const schema = `custom_${randomBytes(8).toString('hex')}`;
const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
const vault = new Vault(config.encryptionKey);
const server = fakeServer();
const service = new Service(pool, new ConnectorRuntime(config, server.fetcher, publicLookup), vault);
const app = createApp(service);
const api = (path: string, method = 'GET', body?: unknown, key = 'key-a') => app.request(`http://localhost:3000${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await pool.query('INSERT INTO projects(id,name,return_urls) VALUES($1,$2,$3),($4,$5,$6)', ['a', 'Agent A', JSON.stringify(['http://localhost:3001/done']), 'b', 'Agent B', '[]']);
  await pool.query("INSERT INTO api_keys(id,project_id,key_hash,key_prefix) VALUES('key_a','a',$1,'cn_live_a'),('key_b','b',$2,'cn_live_b')", [hash('key-a'), hash('key-b')]);
});
after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

async function add(user = 'alice', key = 'key-a') {
  return api('/v1/custom-connectors', 'POST', { external_user_id: user, url: 'https://feeds.example/mcp' }, key);
}
async function connect(name: string, user = 'alice') {
  const created = await api(`/v1/connectors/${name}/sessions`, 'POST', { external_user_id: user, return_url: 'http://localhost:3001/done' });
  assert.equal(created.status, 201); const session = await created.json() as any;
  const launch = await app.request(session.connect_url); assert.equal(launch.status, 302);
  const location = new URL(launch.headers.get('location')!);
  assert.equal(location.origin + location.pathname, 'https://feeds.example/oauth/authorize');
  const callback = `http://localhost:3000/oauth/${name}/callback?state=${location.searchParams.get('state')}&code=code`;
  const result = await app.request(callback, { headers: { Cookie: launch.headers.get('set-cookie')!.split(';')[0] } });
  assert.equal(result.status, 302);
  const done = await (await api(`/v1/connectors/${name}/sessions/${session.id}?external_user_id=${user}`)).json() as any;
  assert.equal(done.status, 'connected');
  return done.connection_id as string;
}

test('a user adds a server by URL, connects it and calls its tools like any connector', async () => {
  const created = await add(); assert.equal(created.status, 201);
  const connector = await created.json() as any;
  assert.match(connector.name, /^mcp_[a-z0-9]{10}$/);
  assert.equal(connector.title, 'Feeds'); assert.equal(connector.url, 'https://feeds.example/mcp');
  // Adding the same URL again returns the same connector and registers no second client.
  const registrations = server.seen.filter(line => line.endsWith('/oauth/register')).length;
  assert.equal((await (await add()).json() as any).name, connector.name);
  assert.equal(server.seen.filter(line => line.endsWith('/oauth/register')).length, registrations);

  const listed = await (await api('/v1/custom-connectors?external_user_id=alice')).json() as any;
  assert.deepEqual(listed.data.map((c: any) => c.name), [connector.name]);
  const avatar = await app.request(connector.avatar_url);
  assert.equal(avatar.status, 200); assert((await avatar.text()).includes('>F</text>'));

  const connectionId = await connect(connector.name);
  const connections = await (await api('/v1/connections?external_user_id=alice')).json() as any;
  assert.deepEqual(connections.data.map((c: any) => c.connector), [connector.name]);
  const tools = await (await api(`/v1/connections/${connectionId}/tools?external_user_id=alice`)).json() as any;
  assert.deepEqual(tools.data.map((t: any) => [t.name, t.read_only]).sort(), [[`${connector.name}.add_feed`, false], [`${connector.name}.list_feeds`, true]]);
  const call = await api(`/v1/connections/${connectionId}/tools/${connector.name}.list_feeds/call`, 'POST', { external_user_id: 'alice', input: {} });
  assert.equal(call.status, 200); assert.equal(((await call.json()) as any).data.content[0].text, 'called list_feeds');

  // Another process that never saw the definition loads it from the database on first use.
  customDefinitions.delete(connector.name);
  const again = await api(`/v1/connections/${connectionId}/tools/${connector.name}.list_feeds/call`, 'POST', { external_user_id: 'alice', input: {} });
  assert.equal(again.status, 200);
});

test('a custom server is invisible to every other user and project, and to the shared catalogs', async () => {
  const name = (await (await add()).json() as any).name;
  for (const [user, key] of [['bob', 'key-a'], ['alice', 'key-b']]) {
    const session = await api(`/v1/connectors/${name}/sessions`, 'POST', { external_user_id: user }, key);
    assert.equal(session.status, 404); assert.equal(((await session.json()) as any).error.code, 'connector_not_found');
    assert.deepEqual(((await (await api(`/v1/custom-connectors?external_user_id=${user}`, 'GET', undefined, key)).json()) as any).data, []);
    const removed = await api(`/v1/custom-connectors/${name}?external_user_id=${user}`, 'DELETE', undefined, key);
    assert.equal(removed.status, 404);
  }
  // Bob adding the same URL gets his own connector, not Alice's.
  const bobs = (await (await add('bob')).json() as any).name;
  assert.notEqual(bobs, name);
  const catalog = await (await api('/v1/connectors')).json() as any;
  assert(!catalog.data.some((c: any) => c.name.startsWith('mcp_')));
  const tools = await (await api('/v1/tools')).json() as any;
  assert(!tools.data.some((t: any) => t.connector.startsWith('mcp_')));
});

test('servers that are not public or not OAuth MCP are refused with closed codes', async () => {
  const refused = await api('/v1/custom-connectors', 'POST', { external_user_id: 'alice', url: 'https://169.254.169.254/mcp' });
  assert.equal(refused.status, 422); assert.equal(((await refused.json()) as any).error.code, 'server_not_public');
  const plain = await api('/v1/custom-connectors', 'POST', { external_user_id: 'alice', url: 'http://feeds.example/mcp' });
  assert.equal(((await plain.json()) as any).error.code, 'invalid_server_url');
});

test('removing a server revokes and deletes its connections and every row it owns', async () => {
  const name = (await (await add('carol')).json() as any).name;
  const connectionId = await connect(name, 'carol');
  const removed = await api(`/v1/custom-connectors/${name}?external_user_id=carol`, 'DELETE');
  assert.equal(removed.status, 200); assert.deepEqual(await removed.json(), { name, removed: true, revoked: 1 });
  for (const [table, column] of [['custom_connectors', 'name'], ['connectors', 'name'], ['connector_apps', 'connector'], ['connector_tools', 'connector'], ['connections', 'connector'], ['connect_sessions', 'connector']])
    assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [name])).rowCount, 0, table);
  assert.equal((await api(`/v1/connections/${connectionId}?external_user_id=carol`)).status, 404);
  assert.equal((await api(`/v1/connectors/${name}/sessions`, 'POST', { external_user_id: 'carol' })).status, 404);
});

test('deleting a project removes its custom servers with it', async () => {
  const name = (await (await add('dave', 'key-b')).json() as any).name;
  await service.deleteProject('b');
  for (const [table, column] of [['custom_connectors', 'name'], ['connectors', 'name'], ['connector_apps', 'connector']])
    assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE ${column}=$1`, [name])).rowCount, 0, table);
});
