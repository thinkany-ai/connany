import { randomUUID } from 'node:crypto';
import { AppError, UpstreamError } from '../errors.js';
import type { HostedMcp } from './hosted-mcp.js';
import type { Credentials } from './index.js';

// Connector-specific identity lookups over official MCP tools. Referenced from the catalog.
export async function linearIdentity(mcp: HostedMcp, credential: Credentials, expected?: {account_id: string; workspace_id?: string}) {
  const unpack = (result: any) => {
    const candidates: any[] = [result.structuredContent];
    for (const block of result.content || []) if (block.type === 'text') { try { candidates.push(JSON.parse(block.text)); } catch {} }
    return candidates;
  };
  const name = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 500 ? value.trim() : undefined;
  const result = await mcp.call('linear.get_user', {query:'me'}, credential);
  for (const payload of unpack(result)) {
    const user = payload?.user || payload?.data?.user || payload?.data || payload;
    if (typeof user?.id !== 'string' || !user.id || !name(user.name)) continue;
    if (expected && user.id !== expected.account_id) throw new UpstreamError('linear_identity_mismatch');
    let organization = user.organization || payload?.organization;
    // The user tool does not normally include the workspace. Ask the official
    // workspace tool explicitly; optional display metadata must not break login.
    let workspaceResult;
    try { workspaceResult = await mcp.call('linear.get_workspace', {}, credential); }
    catch (error) { if (!(error instanceof AppError) || error.status === 401) throw error; }
    if (workspaceResult) {
      for (const value of unpack(workspaceResult)) {
        const workspace = value?.workspace || value?.data?.workspace || value?.organization || value?.data?.organization || value?.data || value;
        if (!name(workspace?.id) || !name(workspace?.name)) continue;
        if ((expected?.workspace_id && workspace.id !== expected.workspace_id) || (organization?.id && workspace.id !== organization.id)) throw new UpstreamError('linear_identity_mismatch');
        organization = workspace;
        break;
      }
    }
    if (expected?.workspace_id && organization?.id && organization.id !== expected.workspace_id) throw new UpstreamError('linear_identity_mismatch');
    return {account_id:user.id,account_name:name(user.name)!,transport:'mcp',
      ...(name(organization?.id) ? {workspace_id:organization.id} : {}),
      ...(name(organization?.id) && name(organization?.name) ? {workspace_name:name(organization.name)!} : {})};
  }
  throw new UpstreamError('invalid_upstream_identity');
}
export async function notionIdentity(mcp: HostedMcp, credential: Credentials, expected: {account_id: string; workspace_id: string}) {
  const result = await mcp.callTool('notion-fetch', {id:'self'}, credential);
  if (result.isError) throw new UpstreamError('notion_identity_unavailable');
  const candidates: any[] = [result.structuredContent];
  for (const block of result.content || []) {
    if (block.type === 'text') { try { candidates.push(JSON.parse(block.text)); } catch {} }
  }
  const name = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 500 ? value.trim() : undefined;
  const sameId = (a: unknown, b: string) => typeof a === 'string' && a.replaceAll('-','').toLowerCase() === b.replaceAll('-','').toLowerCase();
  for (const value of candidates) {
    const data = value?.self || value?.data?.self || value?.data || value;
    if (!data || typeof data !== 'object') continue;
    const workspace = data.workspace;
    const user = data.user;
    // Display metadata must never change the OAuth identity or come from another workspace.
    if ((workspace?.id && !sameId(workspace.id,expected.workspace_id)) ||
        (user?.id && !sameId(user.id,expected.account_id)) ||
        (data.workspace_id && !sameId(data.workspace_id,expected.workspace_id)) ||
        (data.user_id && !sameId(data.user_id,expected.account_id))) throw new UpstreamError('notion_identity_mismatch');
    const workspaceName = name(workspace?.name || data.workspace_name);
    const accountName = name(user?.name || data.user_name);
    if (workspaceName || accountName) return {...(workspaceName?{workspace_name:workspaceName}:{}),...(accountName?{account_name:accountName}:{})};
  }
  throw new UpstreamError('notion_identity_unavailable');
}

/** Claims of a JWT without verification; only used to name the account the token was issued for. */
function jwtClaims(token: unknown): Record<string, unknown> {
  if (typeof token !== 'string' || token.split('.').length !== 3) return {};
  try { const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); return claims && typeof claims === 'object' ? claims : {}; } catch { return {}; }
}
/**
 * Identity for hosted MCP connectors without a bespoke lookup. Sources in order of authority:
 * OIDC userinfo, the id_token, user fields of the token response, then a JWT access token.
 * Without any of them the connection still works but is marked unverified: it is never merged
 * with another connection and reconnect cannot confirm the original account.
 */
export async function genericIdentity(mcp: HostedMcp, credential: Credentials, raw: any, label: string): Promise<Record<string, unknown> & {account_id: string; account_name: string}> {
  let userinfo: Record<string, unknown> = {};
  try { userinfo = await mcp.userinfo(credential) || {}; } catch (error) { if (error instanceof AppError && error.status === 401) throw error; }
  const user = raw?.user && typeof raw.user === 'object' ? raw.user : {};
  const sources: Record<string, unknown>[] = [userinfo, jwtClaims(raw?.id_token), { sub: raw?.user_id ?? user.id, name: user.name, email: user.email ?? raw?.email }, jwtClaims(credential.accessToken)];
  const text = (value: unknown) => (typeof value === 'string' || typeof value === 'number') && String(value).trim() && String(value).length <= 500 ? String(value).trim() : undefined;
  const pick = (...keys: string[]) => { for (const source of sources) for (const key of keys) { const value = text(source[key]); if (value) return value; } return undefined; };
  const accountId = pick('sub', 'user_id', 'id', 'uid');
  const email = pick('email');
  const name = pick('name', 'full_name', 'preferred_username', 'nickname', 'username', 'login') || email;
  if (accountId) return { account_id: accountId, account_name: name || accountId, ...(email ? { email } : {}), transport: 'mcp' };
  return { account_id: `unverified_${randomUUID()}`, account_name: `${label} 账号`, unverified: true, transport: 'mcp' };
}
