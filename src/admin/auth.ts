import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { hash, id, randomToken } from '../crypto.js';
import { transaction } from '../db.js';
import { AppError } from '../errors.js';
import { z } from 'zod';
export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(12).max(256);
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
export interface AdminIdentity { id: string; email: string }
export async function createAdmin(pool: pg.Pool, email: string, password: string) {
  const normalized = emailSchema.parse(email); const passwordHash = await hashPassword(password);
  return transaction(pool, async db => {
    const { rows } = await db.query(`INSERT INTO admin_users(id,email,password_hash) VALUES($1,$2,$3)
      ON CONFLICT(email) DO UPDATE SET password_hash=EXCLUDED.password_hash RETURNING id,email`, [id('admin'),normalized,passwordHash]);
    await db.query('DELETE FROM admin_sessions WHERE admin_id=$1',[rows[0].id]);
    return rows[0] as AdminIdentity;
  });
}
export class AdminAuth {
  constructor(private pool: pg.Pool) {}
  async login(email: string, password: string) {
    const normalized = emailSchema.parse(email);
    z.string().min(1).max(256).parse(password);
    for (const bucket of ['global',hash(normalized)]) {
      const { rows } = await this.pool.query(`INSERT INTO admin_login_limits(bucket,window_start,count) VALUES($1,now(),1)
        ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN admin_login_limits.window_start < now()-interval '15 minutes' THEN 1 ELSE admin_login_limits.count+1 END,
        window_start=CASE WHEN admin_login_limits.window_start < now()-interval '15 minutes' THEN now() ELSE admin_login_limits.window_start END RETURNING count`,[bucket]);
      if (rows[0].count > (bucket === 'global' ? 100 : 10)) throw new AppError('login_rate_limited','登录尝试过多，请在 15 分钟后重试。',429);
    }
    const user = (await this.pool.query('SELECT * FROM admin_users WHERE email=$1',[normalized])).rows[0];
    const dummy = `scrypt:${'0'.repeat(32)}:${'0'.repeat(128)}`;
    const valid = await verifyPassword(password,user?.password_hash || dummy);
    if (!user || !valid) throw new AppError('invalid_login','邮箱或密码不正确。',401);
    const token = randomToken();
    await transaction(this.pool, async db => {
      await db.query("INSERT INTO admin_sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '8 hours')",[hash(token),user.id]);
      await db.query('DELETE FROM admin_login_limits WHERE bucket=$1',[hash(normalized)]);
      await db.query('DELETE FROM admin_sessions WHERE expires_at < now()');
    });
    return token;
  }
  async current(token?: string): Promise<AdminIdentity | null> {
    if (!token || token.length !== 43) return null;
    return (await this.pool.query('SELECT u.id,u.email FROM admin_sessions s JOIN admin_users u ON u.id=s.admin_id WHERE s.token_hash=$1 AND s.expires_at>now()',[hash(token)])).rows[0] || null;
  }
  async changePassword(adminId: string, currentPassword: string, newPassword: string) {
    z.string().min(1).max(256).parse(currentPassword);
    passwordSchema.parse(newPassword);
    const {rows: limits} = await this.pool.query(`INSERT INTO admin_login_limits(bucket,window_start,count) VALUES($1,now(),1)
      ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN admin_login_limits.window_start < now()-interval '15 minutes' THEN 1 ELSE admin_login_limits.count+1 END,
      window_start=CASE WHEN admin_login_limits.window_start < now()-interval '15 minutes' THEN now() ELSE admin_login_limits.window_start END RETURNING count`, ['password:'+adminId]);
    if (limits[0].count > 10) throw new AppError('password_rate_limited','尝试过多，请在 15 分钟后重试。',429);
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
