import { serve } from '@hono/node-server';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { Vault } from './crypto.js';
import { ConnectorRuntime } from './connectors/index.js';
import { Service } from './service.js';
import { createApp } from './app.js';
const config = loadConfig();
const pool = createPool(config.databaseUrl);
// Apply pending migrations before serving. Runs under an advisory lock, so concurrent
// replicas and an external migrate step are safe; set MIGRATE_ON_START=false to skip.
if (process.env.MIGRATE_ON_START !== 'false') { await migrate(pool); console.log('Database migration complete.'); }
await pool.query('SELECT 1 FROM projects LIMIT 1');
const service = new Service(pool, new ConnectorRuntime(config), new Vault(config.encryptionKey));
await service.initialize();
const app = createApp(service);
const server = serve({ fetch: app.fetch, port: config.port }, info => console.log(`Connany listening on port ${info.port}`));
for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => { server.close(() => { void pool.end().then(() => process.exit(0)); }); });
