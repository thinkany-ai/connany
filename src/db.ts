import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
export const createPool = (connectionString: string) => new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 });
export async function migrate(pool: pg.Pool) {
  await transaction(pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(804217331)");
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const files = (await readdir('migrations')).filter(name => /^\d+.*\.sql$/.test(name)).sort();
    for (const name of files) {
      if ((await db.query('SELECT name FROM schema_migrations WHERE name=$1', [name])).rowCount) continue;
      await db.query(await readFile(`migrations/${name}`, 'utf8'));
      await db.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    }
  });
}
export async function transaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
export async function event(db: pg.Pool | pg.PoolClient, project: string, user: string, type: string, connection: string | null, data: Record<string, unknown> = {}) {
  await db.query('INSERT INTO events(project_id, external_user_id, type, connection_id, data) VALUES($1,$2,$3,$4,$5)', [project, user, type, connection, JSON.stringify(data)]);
}
