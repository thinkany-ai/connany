import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from '../errors.js';
import type { ClientAuthMethod, McpSpec } from './catalog.js';
import type { Fetcher } from './index.js';

/**
 * Remote MCP servers a user adds by URL (docs/custom-connectors.md). Everything here talks to a
 * server nobody vetted, so:
 * - every request goes through `guardFetch`: HTTPS only, no credentials in the URL, and the host
 *   must resolve only to public addresses, so a server cannot point Connany at its own network;
 * - discovery follows the MCP authorization spec (RFC 9728 protected resource metadata, then
 *   RFC 8414 authorization server metadata) and accepts only servers with dynamic client
 *   registration (RFC 7591) and PKCE S256 — the same shape as the hosted MCP connectors.
 */

export type HostLookup = (hostname: string) => Promise<{ address: string; family: number }[]>;
export const systemLookup: HostLookup = hostname => dnsLookup(hostname, { all: true, verbatim: true });

const v4 = (ip: string) => ip.split('.').map(Number);
function publicV4(ip: string) {
  const [a, b, c] = v4(ip);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}
/**
 * Whether an address is reachable on the public internet (not loopback, private, link local, …).
 * `allowFakeIp`: also accept 198.18.0.0/15, which a local proxy in fake-IP mode answers every
 * name with. Development only (CUSTOM_MCP_ALLOW_FAKE_IP); never on a server.
 */
export function isPublicAddress(ip: string, allowFakeIp = false): boolean {
  const family = isIP(ip);
  if (family === 4) return publicV4(ip) || (allowFakeIp && /^198\.(18|19)\./.test(ip));
  if (family !== 6) return false;
  const lower = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) addresses carry an IPv4 target.
  const embedded = lower.match(/^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (embedded) return publicV4(embedded[1]);
  if (/^::ffff:/.test(lower) || /^64:ff9b:/.test(lower)) return false;
  if (lower === '::' || lower === '::1') return false;
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if ((first & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((first & 0xffc0) === 0xfe80) return false; // link local fe80::/10
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (first === 0x2001 && parseInt(lower.split(':')[1] || '0', 16) === 0xdb8) return false; // documentation
  return true;
}

/** Validate a URL for a remote MCP request and check where its host resolves. */
export async function assertPublicUrl(raw: string, lookup: HostLookup, allowFakeIp = false): Promise<URL> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError('invalid_server_url', 'Give the full https:// URL of the MCP server.'); }
  if (url.protocol !== 'https:') throw new AppError('invalid_server_url', 'The MCP server must use https://.');
  if (url.username || url.password) throw new AppError('invalid_server_url', 'Remove credentials from the URL.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host).catch(() => [])).map(a => a.address);
  if (!addresses.length) throw new AppError('server_unreachable', 'The MCP server host could not be resolved.', 422);
  if (!addresses.every(a => isPublicAddress(a, allowFakeIp))) throw new AppError('server_not_public', 'The MCP server must be on the public internet.', 422);
  return url;
}

/**
 * A fetcher that refuses non-public destinations. The address is checked when each request
 * starts; redirects are never followed (callers already pass `redirect: 'error'`, and this
 * enforces it).
 */
export function guardFetch(fetcher: Fetcher, lookup: HostLookup = systemLookup, allowFakeIp = false): Fetcher {
  return (async (input: Parameters<Fetcher>[0], init?: Parameters<Fetcher>[1]) => {
    await assertPublicUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, lookup, allowFakeIp);
    return fetcher(input, { ...init, redirect: 'error' });
  }) as Fetcher;
}

export interface DiscoveredServer {
  /** Normalized server URL: origin + path, no query or fragment. */
  url: string;
  label: string;
  website: string;
  mcp: McpSpec;
}

const MAX_METADATA = 64 * 1024;
async function getJson(fetcher: Fetcher, url: string): Promise<Record<string, any> | null> {
  let response: Response;
  try { response = await fetcher(url, { headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000) }); }
  catch (error) { if (error instanceof AppError) throw error; return null; }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return null; }
  const text = await response.text();
  if (text.length > MAX_METADATA) return null;
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : null; } catch { return null; }
}
const httpsUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : undefined; } catch { return undefined; }
};
/** `key="value"` parameters of a WWW-Authenticate Bearer challenge. */
function challengeParams(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const m of header.matchAll(/([a-zA-Z_]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g)) out[m[1].toLowerCase()] = m[2] ?? m[3];
  return out;
}
/** A display name from server metadata: one short line of printable text. */
function displayName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').replace(/\s+/g, ' ').trim();
  return clean && clean.length <= 60 ? clean : fallback;
}

/** Normalize what a user typed into the canonical server URL (same check as every later request). */
export async function normalizeServerUrl(raw: string, lookup: HostLookup, allowFakeIp = false): Promise<URL> {
  const url = await assertPublicUrl(raw.trim(), lookup, allowFakeIp);
  if (url.search || url.hash) throw new AppError('invalid_server_url', 'Use the MCP server URL without query or fragment.');
  if (url.href.length > 500) throw new AppError('invalid_server_url', 'The URL is too long.');
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url;
}

/**
 * Find how to authorize against a remote MCP server. Throws a closed AppError code when the
 * server is not reachable, not an MCP server, or does not support the flow Connany implements.
 */
export async function discoverServer(raw: string, baseFetcher: Fetcher, lookup: HostLookup = systemLookup, allowFakeIp = false): Promise<DiscoveredServer> {
  const fetcher = guardFetch(baseFetcher, lookup, allowFakeIp);
  const url = await normalizeServerUrl(raw, lookup, allowFakeIp);
  const endpoint = url.origin + (url.pathname === '/' ? '' : url.pathname);

  // 1. An unauthenticated initialize: an OAuth-protected server answers 401 with its metadata URL.
  let probe: Response;
  try {
    probe = await fetcher(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'connany', version: '0.1.0' } } }) });
  } catch (error) { if (error instanceof AppError) throw error; throw new AppError('server_unreachable', 'The MCP server did not respond.', 422); }
  await probe.body?.cancel().catch(() => {});
  if (probe.ok) throw new AppError('server_auth_unsupported', 'This MCP server needs no sign-in; only servers that use OAuth sign-in can be added.', 422);
  if (probe.status !== 401) throw new AppError('not_mcp_server', 'This URL did not answer like an MCP server.', 422, { upstream_status: probe.status });
  const challenge = challengeParams(probe.headers.get('www-authenticate'));

  // 2. Protected resource metadata (RFC 9728): from the challenge, else the well-known locations.
  const path = url.pathname === '/' ? '' : url.pathname;
  const resourceCandidates = [httpsUrl(challenge.resource_metadata), `${url.origin}/.well-known/oauth-protected-resource${path}`, `${url.origin}/.well-known/oauth-protected-resource`].filter(Boolean) as string[];
  let resource: Record<string, any> | null = null;
  for (const candidate of [...new Set(resourceCandidates)]) if ((resource = await getJson(fetcher, candidate))) break;
  const issuer = httpsUrl(resource?.authorization_servers?.[0]);
  if (!resource || !issuer) throw new AppError('server_auth_unsupported', 'The MCP server does not publish OAuth metadata.', 422);
  // The metadata must describe this server, not another one whose tokens it wants to collect.
  const resourceId = httpsUrl(resource.resource);
  if (resourceId && new URL(resourceId).origin !== url.origin) throw new AppError('server_auth_unsupported', 'The MCP server metadata names a different server.', 422);

  // 3. Authorization server metadata (RFC 8414, then OpenID discovery).
  const issuerUrl = new URL(issuer);
  const issuerPath = issuerUrl.pathname === '/' ? '' : issuerUrl.pathname.replace(/\/+$/, '');
  const authCandidates = [`${issuerUrl.origin}/.well-known/oauth-authorization-server${issuerPath}`, `${issuerUrl.origin}/.well-known/openid-configuration${issuerPath}`, `${issuerUrl.origin}${issuerPath}/.well-known/openid-configuration`];
  let auth: Record<string, any> | null = null;
  for (const candidate of [...new Set(authCandidates)]) {
    const value = await getJson(fetcher, candidate);
    // RFC 8414 §3.3: the metadata must be about the issuer it was fetched for.
    if (value && typeof value.issuer === 'string' && value.issuer.replace(/\/+$/, '') === issuer.replace(/\/+$/, '')) { auth = value; break; }
  }
  if (!auth) throw new AppError('server_auth_unsupported', 'The authorization server metadata could not be read.', 422);
  const authorize = httpsUrl(auth.authorization_endpoint);
  const token = httpsUrl(auth.token_endpoint);
  const register = httpsUrl(auth.registration_endpoint);
  if (!authorize || !token) throw new AppError('server_auth_unsupported', 'The authorization server metadata is incomplete.', 422);
  if (!register) throw new AppError('server_registration_unsupported', 'The MCP server does not allow apps to register themselves (dynamic client registration).', 422);
  // The MCP authorization spec: refuse to proceed without advertised S256 support.
  if (!Array.isArray(auth.code_challenge_methods_supported) || !auth.code_challenge_methods_supported.includes('S256'))
    throw new AppError('server_auth_unsupported', 'The authorization server does not support PKCE S256.', 422);
  const methods: unknown[] = Array.isArray(auth.token_endpoint_auth_methods_supported) ? auth.token_endpoint_auth_methods_supported : ['client_secret_basic'];
  const clientAuth = (['none', 'client_secret_post', 'client_secret_basic'] as ClientAuthMethod[]).find(m => methods.includes(m));
  if (!clientAuth) throw new AppError('server_auth_unsupported', 'The authorization server uses an unsupported client authentication.', 422);
  const scopes = challenge.scope || (Array.isArray(resource.scopes_supported) ? resource.scopes_supported.filter((s: unknown) => typeof s === 'string').join(' ') : '');
  const revoke = httpsUrl(auth.revocation_endpoint);
  const userinfo = httpsUrl(auth.userinfo_endpoint);

  return {
    url: endpoint,
    label: displayName(resource.resource_name, url.hostname),
    website: url.origin,
    mcp: {
      origin: url.origin, endpoint: path || '/',
      oauth: { authorize, token, register, ...(revoke ? { revoke } : {}), ...(userinfo ? { userinfo } : {}) },
      ...(scopes ? { scope: scopes.slice(0, 2000) } : {}),
      clientAuth, resource: resourceId || endpoint,
    },
  };
}
