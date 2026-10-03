import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { hash, id, randomToken } from '../crypto.js';
import { transaction } from '../db.js';
import { AppError } from '../errors.js';
import { ensureWorkspace } from '../workspaces.js';
import { z } from 'zod';
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(8).max(256);
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve,reject) => scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string) {
  passwordSchema.parse(password); const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [version,salt,expected] = stored.split(':');
  if (version !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(expected)) return false;
  return timingSafeEqual(await derive(password,salt),Buffer.from(expected,'hex'));
}
export function csrfToken(sessionToken: string) { return hash(`admin-csrf:${sessionToken}`); }
/** admin: system administrator who also manages console users; member: workbench only. */
export const roleSchema = z.enum(['admin','member']);
export type AdminRole = z.infer<typeof roleSchema>;
export interface AdminIdentity { id: string; email: string; role: AdminRole; workspace_id: string }
export async function createAdmin(pool: pg.Pool, email: string, password: string) {
  const normalized = emailSchema.parse(email); const passwordHash = await hashPassword(password);
  return transaction(pool, async db => {
    // The CLI provisions system administrators; rerunning it resets the password and restores the role.
    const { rows } = await db.query(`INSERT INTO admin_users(id,email,password_hash,role) VALUES($1,$2,$3,'admin')
      ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash,role='admin' RETURNING id,email,role`, [id('admin'),normalized,passwordHash]);
    rows[0].workspace_id = await ensureWorkspace(db, rows[0]);
    await db.query('DELETE FROM admin_sessions WHERE admin_id=$1',[rows[0].id]);
    return rows[0] as AdminIdentity;
  });
}
/** Counts attempts per bucket in a 15-minute window; returns the count including this attempt. */
async function attempt(db: pg.Pool | pg.PoolClient, bucket: string) {
  const { rows } = await db.query(`INSERT INTO admin_login_limits(bucket,window_start,count) VALUES($1,now(),1)
    ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN admin_login_limits.window_start < now()-interval '15 minutes' THEN 1 ELSE admin_login_limits.count+1 END,
    window_start=CASE WHEN admin_login_limits.window_start < now()-interval '15 minutes' THEN now() ELSE admin_login_limits.window_start END RETURNING count`,[bucket]);
  return rows[0].count as number;
}
async function startSession(db: pg.PoolClient, adminId: string) {
  const token = randomToken();
  await db.query("INSERT INTO admin_sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",[hash(token),adminId]);
  await db.query('DELETE FROM admin_sessions WHERE expires_at < now()');
  return token;
}
export async function signupEnabled(db: pg.Pool | pg.PoolClient) {
  const { rows } = await db.query("SELECT value FROM system_settings WHERE key='signup_enabled'");
  return rows[0]?.value === true;
}
export class AdminAuth {
  constructor(private pool: pg.Pool) {}
  async login(email: string, password: string) {
    const normalized = emailSchema.parse(email);
    z.string().min(1).max(256).parse(password);
    for (const bucket of ['global',hash(normalized)])
      if (await attempt(this.pool, bucket) > (bucket === 'global' ? 100 : 10)) throw new AppError('login_rate_limited','登录尝试过多，请在 15 分钟后重试。',429);
    const user = (await this.pool.query('SELECT * FROM admin_users WHERE email=$1',[normalized])).rows[0];
    const dummy = `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const valid = await verifyPassword(password,user?.password_hash || dummy);
    if (!user || !valid) throw new AppError('invalid_login','邮箱或密码不正确。',401);
    return transaction(this.pool, async db => {
      await db.query('DELETE FROM admin_login_limits WHERE bucket=$1',[hash(normalized)]);
      return startSession(db, user.id);
    });
  }
  /** Self-service registration, when an administrator opened it: a member with their own workspace, signed in. */
  async signup(email: string, password: string) {
    const normalized = emailSchema.parse(email); passwordSchema.parse(password);
    if (!await signupEnabled(this.pool)) throw new AppError('signup_disabled','当前未开放注册，请联系管理员创建账号。',403);
    if (await attempt(this.pool, 'signup') > 30) throw new AppError('signup_rate_limited','注册请求过多，请在 15 分钟后重试。',429);
    const passwordHash = await hashPassword(password);
    return transaction(this.pool, async db => {
      const { rows } = await db.query(`INSERT INTO admin_users(id,email,password_hash,role) VALUES($1,$2,$3,'member') ON CONFLICT(email) DO NOTHING RETURNING id,email,role`, [id('admin'),normalized,passwordHash]);
      if (!rows[0]) throw new AppError('user_exists','该邮箱已注册，请直接登录。',409);
      await ensureWorkspace(db, rows[0]);
      await db.query('INSERT INTO admin_audit(admin_id,actor_email,action,target) VALUES($1,$2,$3,$2)',[rows[0].id,normalized,'user.signed_up']);
      return startSession(db, rows[0].id);
    });
  }
  async current(token?: string): Promise<AdminIdentity | null> {
    if (!token || token.length !== 43) return null;
    const user = (await this.pool.query(`SELECT u.id,u.email,u.role,(SELECT w.id FROM workspaces w WHERE w.owner_id=u.id ORDER BY w.created_at, w.id LIMIT 1) AS workspace_id
      FROM admin_sessions s JOIN admin_users u ON u.id=s.admin_id WHERE s.token_hash=$1 AND s.expires_at>now()`,[hash(token)])).rows[0];
    if (user && !user.workspace_id) user.workspace_id = await ensureWorkspace(this.pool, user);
    return user || null;
  }
  async changePassword(adminId: string, currentPassword: string, newPassword: string) {
    z.string().min(1).max(256).parse(currentPassword);
    passwordSchema.parse(newPassword);
    if (await attempt(this.pool, 'password:'+adminId) > 10) throw new AppError('password_rate_limited','尝试过多，请在 15 分钟后重试。',429);
    await transaction(this.pool, async db => {
      const user = (await db.query('SELECT password_hash FROM admin_users WHERE id=$1 FOR UPDATE',[adminId])).rows[0];
      if (!user || !await verifyPassword(currentPassword,user.password_hash)) throw new AppError('invalid_password','当前密码不正确。',400);
      if (currentPassword === newPassword) throw new AppError('password_unchanged','新密码不能与当前密码相同。',400);
      const passwordHash = await hashPassword(newPassword);
      await db.query('UPDATE admin_users SET password_hash=$1 WHERE id=$2',[passwordHash,adminId]);
      await db.query('DELETE FROM admin_sessions WHERE admin_id=$1',[adminId]);
      await db.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$1)',[adminId,'admin.password_changed']);
    });
  }
  async logout(token: string) { await this.pool.query('DELETE FROM admin_sessions WHERE token_hash=$1',[hash(token)]); }
}

/** Console user management for system administrators. Every change is audited. */
export class ConsoleUsers {
  constructor(private pool: pg.Pool) {}
  list() {
    return this.pool.query(`SELECT u.id,u.email,u.role,u.created_at,(SELECT max(s.created_at) FROM admin_sessions s WHERE s.admin_id=u.id) AS last_login_at
      FROM admin_users u ORDER BY u.role, u.email`).then(r => r.rows);
  }
  async create(actor: AdminIdentity, input: { email: string; password: string; role: AdminRole }) {
    const email = emailSchema.parse(input.email); const passwordHash = await hashPassword(input.password);
    return transaction(this.pool, async db => {
      const { rows } = await db.query(`INSERT INTO admin_users(id,email,password_hash,role) VALUES($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING RETURNING id,email,role`, [id('admin'),email,passwordHash,input.role]);
      if (!rows[0]) throw new AppError('user_exists','该邮箱已存在。',409);
      await ensureWorkspace(db, rows[0]);
      await this.audit(db, actor, 'user.created', email);
      return rows[0];
    });
  }
  async setRole(actor: AdminIdentity, userId: string, role: AdminRole) {
    if (userId === actor.id) throw new AppError('own_role','不能修改自己的身份。',400);
    return transaction(this.pool, async db => {
      const user = await this.lock(db, userId);
      if (user.role === 'admin' && role !== 'admin') await this.keepAnAdmin(db);
      await db.query('UPDATE admin_users SET role=$1 WHERE id=$2',[role,userId]);
      await this.audit(db, actor, `user.role_${role}`, user.email);
      return { ...user, role };
    });
  }
  async resetPassword(actor: AdminIdentity, userId: string, password: string) {
    const passwordHash = await hashPassword(password);
    await transaction(this.pool, async db => {
      const user = await this.lock(db, userId);
      await db.query('UPDATE admin_users SET password_hash=$1 WHERE id=$2',[passwordHash,userId]);
      // A reset signs the user out everywhere.
      await db.query('DELETE FROM admin_sessions WHERE admin_id=$1',[userId]);
      await this.audit(db, actor, 'user.password_reset', user.email);
    });
  }
  /** Deletes the user after `deleteData` removed their workspaces (which may call upstream APIs). */
  async remove(actor: AdminIdentity, userId: string, deleteData: (userId: string) => Promise<void>) {
    if (userId === actor.id) throw new AppError('delete_self','不能删除自己的账号。',400);
    const check = async (db: pg.PoolClient) => { const user = await this.lock(db, userId); if (user.role === 'admin') await this.keepAnAdmin(db); return user; };
    await transaction(this.pool, check);
    await deleteData(userId);
    await transaction(this.pool, async db => {
      const user = await check(db);
      await db.query('UPDATE admin_audit SET actor_email=$1 WHERE admin_id=$2 AND actor_email IS NULL',[user.email,userId]);
      await db.query('DELETE FROM admin_users WHERE id=$1',[userId]);
      await this.audit(db, actor, 'user.deleted', user.email);
    });
  }
  async setSignup(actor: AdminIdentity, enabled: boolean) {
    await transaction(this.pool, async db => {
      await db.query(`INSERT INTO system_settings(key,value) VALUES('signup_enabled',$1) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()`,[JSON.stringify(enabled)]);
      await this.audit(db, actor, enabled ? 'signup.opened' : 'signup.closed', 'signup');
    });
  }
  private async lock(db: pg.PoolClient, userId: string) {
    const user = (await db.query('SELECT id,email,role FROM admin_users WHERE id=$1 FOR UPDATE',[userId])).rows[0];
    if (!user) throw new AppError('not_found','用户不存在。',404);
    return user as AdminIdentity;
  }
  /** Called before removing an administrator: at least one must remain. */
  private async keepAnAdmin(db: pg.PoolClient) {
    const { rows } = await db.query("SELECT id FROM admin_users WHERE role='admin' FOR UPDATE");
    if (rows.length <= 1) throw new AppError('last_admin','至少需要保留一个系统管理员。',409);
  }
  private audit(db: pg.PoolClient, actor: AdminIdentity, action: string, target: string) {
    return db.query('INSERT INTO admin_audit(admin_id,actor_email,action,target) VALUES($1,$2,$3,$4)',[actor.id,actor.email,action,target]);
  }
}
