import type pg from 'pg';
import { id } from './crypto.js';
/**
 * A workspace belongs to one console user and owns that user's connectors (with their OAuth
 * apps), projects and, through projects, user connections. Every console query is scoped to
 * the signed-in user's workspace.
 */
export const defaultWorkspaceId = 'ws_default';
/**
 * The user's workspace, creating it on first use. The first user claims the default workspace
 * so data created before accounts existed (or imported from env) stays with them.
 */
export async function ensureWorkspace(db: pg.Pool | pg.PoolClient, user: { id: string; email: string }): Promise<string> {
  const owned = (await db.query('SELECT id FROM workspaces WHERE owner_id=$1 ORDER BY created_at, id LIMIT 1', [user.id])).rows[0];
  if (owned) return owned.id;
  const claimed = (await db.query('UPDATE workspaces SET owner_id=$1 WHERE id=$2 AND owner_id IS NULL RETURNING id', [user.id, defaultWorkspaceId])).rows[0];
  if (claimed) return claimed.id;
  const workspaceId = id('ws');
  await db.query('INSERT INTO workspaces(id,name,owner_id) VALUES($1,$2,$3)', [workspaceId, user.email, user.id]);
  return workspaceId;
}
