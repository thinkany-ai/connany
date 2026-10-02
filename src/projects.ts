import { z } from 'zod';
// Schemes that can execute code or read local data in the browser; never redirect to them.
const blockedSchemes = new Set(['javascript:','data:','vbscript:','file:','blob:','about:','filesystem:','ftp:','ws:','wss:']);
const loopback = new Set(['localhost','127.0.0.1','[::1]']);
/**
 * Where the browser returns after authorization. Supplied per request by the key holder:
 * HTTPS, HTTP on loopback (any port, RFC 8252) or a native app scheme like myapp://callback.
 */
export const returnUrlSchema = z.string().url().max(2048).refine(value => {
  const url = new URL(value);
  if (url.username || url.password || url.hash || blockedSchemes.has(url.protocol)) return false;
  return url.protocol !== 'http:' || loopback.has(url.hostname);
}, '返回地址需为 HTTPS、本机 HTTP 或应用自定义协议，不能含用户名、密码或 fragment。');
export const projectInput = z.object({ name: z.string().trim().min(1).max(100), return_urls: z.array(returnUrlSchema).max(20).optional() }).strict();
export const publicProjectColumns = 'id,workspace_id,name,enabled,return_urls,created_at,updated_at';
export const publicApiKeyColumns = 'id,project_id,name,key_prefix,created_at,last_used_at,revoked_at';
/** Two active keys allow rotation without downtime: issue a new key, deploy it, revoke the old one. */
export const maxActiveApiKeys = 2;
