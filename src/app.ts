import { readFile } from 'node:fs/promises';
import { agentPrompt, apiMarkdown, docsMarkdown, docsPage, type DocsPageName } from './docs.js';
import { favicon } from './brand.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { connectorNames } from './config.js';
import { AppError } from './errors.js';
import { resultPage, errorPage, redirectPage, toolSyncPage } from './pages.js';
import { restToolCatalog, restTools, toolNamePattern, type ToolName } from './connectors/index.js';
import { publicConnection, publicSession, Service, type Project } from './service.js';
import type { ToolDefinition } from './connector-store.js';
import { mountAdmin } from './admin/routes.js';
import { attempt } from './admin/auth.js';
import { id } from './crypto.js';
import { returnUrlSchema } from './projects.js';
import { searchTools } from './tool-search.js';
import { OAuthError, OAuthServer, mcpScope } from './mcp/oauth.js';
import { McpServer } from './mcp/server.js';
import { categoryTitles, connectorCatalog, connectorCategories, connector as connectorSpec, locales, pickLocale, type ConnectorDefinition } from './connectors/catalog.js';

const userSchema = z.string().min(1).max(200);
const sessionInput = z.object({ external_user_id: userSchema, return_url: returnUrlSchema.optional() }).strict();
export function createApp(service: Service) {
  const app = new Hono<{ Variables: { project: Project; requestId: string } }>();
  app.use('*', async (c, next) => {
    c.set('requestId', id('req'));
    c.header('X-Request-Id', c.get('requestId'));
    c.header('Cache-Control', 'no-store');
    // Preserve Origin on same-origin form POSTs without leaking link tokens or OAuth codes.
    c.header('Referrer-Policy', 'strict-origin');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (!(c.req.path === '/docs' || c.req.path.startsWith('/docs/'))) await service.initialize();
    await next();
  });
  const defaultLimit = bodyLimit({ maxSize: 32 * 1024, onError: c => c.json({ error: { code: 'body_too_large', message: 'Request exceeds 32 KB.' } }, 413) });
  // MCP tool calls can carry documents (a page body, an issue description).
  const mcpLimit = bodyLimit({ maxSize: 1024 * 1024, onError: c => c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Request exceeds 1 MB.' } }, 413) });
  app.use('*', (c, next) => c.req.path === '/mcp' ? mcpLimit(c, next) : defaultLimit(c, next));
  app.onError((error, c) => {
    const validation = error instanceof z.ZodError || error instanceof SyntaxError;
    const known = error instanceof AppError;
    const status = validation ? 400 : known ? error.status : 500;
    const code = validation ? 'invalid_request' : known ? error.code : 'internal_error';
    const message = validation ? 'Request parameters are invalid.' : known ? error.message : 'An internal error occurred. Use the request ID when contacting the operator.';
    if (!validation && !known) console.error(JSON.stringify({ level: 'error', request_id: c.get('requestId'), code: 'internal_error' }));
    if (known && error.details?.retry_after) c.header('Retry-After', String(error.details.retry_after));
    if (c.req.path.startsWith('/connect/') || c.req.path.startsWith('/oauth/')) return c.html(errorPage(message), status as 400);
    return c.json({ error: { code, message, ...(known && error.details ? { details: error.details } : {}), ...(error instanceof z.ZodError ? { fields: error.issues.map(i => ({ path: i.path, message: i.message })) } : {}) }, request_id: c.get('requestId') }, status as 400);
  });
  const docsCsp = "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'";
  const docs = (page: DocsPageName) => async (c: any) => { c.header('Content-Security-Policy', docsCsp); return c.html(await docsPage(service.runtime.config.publicBaseUrl, c.req.query('lang'), page)); };
  app.get('/docs', docs('api'));
  app.get('/docs/agent', docs('agent'));
  app.get('/docs/mcp', docs('mcp'));
  app.get('/docs/', c => c.redirect('/docs', 302));
  const markdown = (filename: string, body: (lang?: string) => Promise<string>) => async (c: any) => {
    c.header('Content-Type','text/markdown; charset=utf-8');
    if (filename) c.header('Content-Disposition', `attachment; filename="${filename}"`);
    return c.body(await body(c.req.query('lang')));
  };
  app.get('/docs/api.md', markdown('', lang => apiMarkdown(service.runtime.config.publicBaseUrl, lang)));
  app.get('/docs/agent.md', markdown('connany-agent-integration.md', () => agentPrompt(service.runtime.config.publicBaseUrl)));
  app.get('/docs/mcp.md', markdown('', lang => docsMarkdown('mcp', service.runtime.config.publicBaseUrl, lang)));
  app.get('/docs/sdk.ts', async c => {
    c.header('Content-Type','text/plain; charset=utf-8');
    c.header('Content-Disposition','attachment; filename="connany-client.ts"');
    return c.body(await readFile('sdk/client.ts','utf8'));
  });
  app.get('/docs/assets/docs.css', async c => { c.header('Content-Type','text/css; charset=utf-8');return c.body(await readFile('public/docs.css','utf8')); });
  app.get('/docs/assets/docs.js', async c => { c.header('Content-Type','text/javascript; charset=utf-8');return c.body(await readFile('public/docs.js','utf8')); });
  app.get('/connectors/:name/avatar.svg', c => {
    const name = z.enum(connectorNames).parse(c.req.param('name'));
    c.header('Content-Type', 'image/svg+xml'); c.header('Cache-Control', 'public, max-age=86400'); c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    return c.body(connectorCatalog[name].icon);
  });
  // The agent skill, with this deployment's MCP URL filled in.
  app.get('/skills/connany/SKILL.md', async c => {
    c.header('Content-Type', 'text/markdown; charset=utf-8');
    return c.body((await readFile('skills/connany/SKILL.md', 'utf8')).replaceAll('{{CONNANY_MCP_URL}}', `${service.runtime.config.publicBaseUrl}/mcp`));
  });
  app.get('/favicon.svg', c => { c.header('Content-Type', 'image/svg+xml'); return c.body(favicon); });
  app.get('/', c => c.redirect('/admin', 302));
  mountMcp(app, service);
  app.get('/health', async c => { await service.pool.query('SELECT 1'); return c.json({ status: 'ok', version: '0.1.0' }); });
  app.use('/v1/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    c.set('project', await service.authenticate(auth?.startsWith('Bearer ') ? auth.slice(7) : ''));
    await next();
  });
  app.get('/v1/connectors', async c => {
    const base = service.runtime.config.publicBaseUrl;
    const { lang } = z.object({ lang: z.enum(locales).optional() }).strict().parse(c.req.query());
    const locale = pickLocale(lang, c.req.header('Accept-Language'));
    const enabled = (await service.connectorStore.in(c.get('project').workspace_id).list()).filter(item => item.enabled);
    const data = enabled.map(item => { const spec = connectorCatalog[item.name] as ConnectorDefinition; return { name: item.name, title: spec.label, category: spec.category, description: spec.description[locale], avatar_url: `${base}/connectors/${item.name}/avatar.svg`, tools_synced_at: item.tools_synced_at }; });
    // Only categories that contain an enabled connector, in display order.
    const categories = connectorCategories.filter(category => data.some(item => item.category === category)).map(name => ({ name, title: categoryTitles[name][locale] }));
    c.header('Content-Language', locale); c.header('Vary', 'Accept-Language');
    return c.json({ categories, data });
  });
  app.post('/v1/connectors/:name/sessions', async c => {
    const connector = z.enum(connectorNames).safeParse(c.req.param('name'));
    if (!connector.success) throw new AppError('connector_not_found','Unknown connector.',404);
    const input = sessionInput.parse(await c.req.json());
    return c.json(await service.createSession(c.get('project'), { ...input, connector: connector.data }), 201);
  });
  app.get('/v1/connectors/:name/sessions/:id', async c => {
    const user = userSchema.parse(c.req.query('external_user_id'));
    const { rows } = await service.pool.query('SELECT * FROM connect_sessions WHERE id=$1 AND connector=$2 AND project_id=$3 AND external_user_id=$4', [c.req.param('id'), c.req.param('name'), c.get('project').id, user]);
    if (!rows[0]) throw new AppError('not_found', 'Session not found.', 404);
    return c.json(publicSession(rows[0]));
  });
  app.get('/v1/connections', async c => {
    const user = userSchema.parse(c.req.query('external_user_id'));
    const limit = z.coerce.number().int().min(1).max(100).parse(c.req.query('limit') || 50);
    const after = c.req.query('after') || '';
    const connector = z.enum(connectorNames).optional().parse(c.req.query('connector'));
    const status = z.enum(['connected','reauth_required','revoked']).optional().parse(c.req.query('status'));
    const { rows } = await service.pool.query('SELECT * FROM connections WHERE project_id=$1 AND external_user_id=$2 AND id>$3 AND ($5::text IS NULL OR connector=$5) AND ($6::text IS NULL OR status=$6) ORDER BY id LIMIT $4', [c.get('project').id, user, after, limit + 1, connector ?? null, status ?? null]);
    return c.json({ data: (await Promise.all(rows.slice(0, limit).map(row=>service.enrichConnection(row)))).map(publicConnection), next_cursor: rows.length > limit ? rows[limit-1].id : null });
  });
  app.get('/v1/connections/:id', async c => c.json(publicConnection(await service.enrichConnection(await service.getConnection(c.get('project').id, userSchema.parse(c.req.query('external_user_id')), c.req.param('id'))))));
  app.post('/v1/connections/:id/check', async c => {
    const { external_user_id: user } = z.object({ external_user_id: userSchema }).strict().parse(await c.req.json());
    const connection = await service.getConnection(c.get('project').id, user, c.req.param('id'));
    // Uses the normal owner check, refresh, locking and error handling. No business tool is executed.
    const tools = await service.execute(c.get('project').id, user, connection.id, `${connection.connector}.__discover`, {}) as ReturnType<typeof restToolCatalog>;
    return c.json({ connection_id: connection.id, connector: connection.connector, checked_at: new Date().toISOString(), tool_count: tools.length, request_id: c.get('requestId') });
  });
  app.get('/v1/connections/:id/access', async c => {
    const user = userSchema.parse(c.req.query('external_user_id'));
    const page = z.coerce.number().int().min(1).max(10000).parse(c.req.query('page') || 1);
    const limit = z.coerce.number().int().min(1).max(100).parse(c.req.query('limit') || 20);
    return c.json(await service.listAccess(c.get('project').id, user, c.req.param('id'), page, limit));
  });
  app.post('/v1/connections/:id/reconnect', async c => {
    const input = sessionInput.parse(await c.req.json());
    const connection = await service.getConnection(c.get('project').id, input.external_user_id, c.req.param('id'));
    if (connection.status === 'revoked') throw new AppError('connection_revoked', 'Create a new connection after disconnecting.', 409);
    return c.json(await service.createSession(c.get('project'), { ...input, connector: connection.connector }, connection.id), 201);
  });
  app.delete('/v1/connections/:id', async c => c.json(await service.disconnect(c.get('project').id, userSchema.parse(c.req.query('external_user_id')), c.req.param('id'))));
  const toolName = z.string().max(150).refine(name=>Object.hasOwn(restTools,name) || toolNamePattern.test(name) && !/\.__(discover|identity)$/.test(name)).transform(name=>name as ToolName);
  const toolQuery = {query:z.string().max(500).optional(),limit:z.coerce.number().int().min(1).max(100).default(20),offset:z.coerce.number().int().min(0).default(0),read_only:z.enum(['true','false']).transform(v=>v==='true').optional()};
  const pageTools = searchTools;
  // Catalog view: what each enabled connector offers, independent of users.
  app.get('/v1/tools', async c => {
    const input = z.object({connector:z.enum(connectorNames).optional(),...toolQuery}).strict().parse(c.req.query());
    return c.json(pageTools((await service.connectorStore.in(c.get('project').workspace_id).tools()).filter(t=>!input.connector || t.connector===input.connector), input));
  });
  // Runtime view: tools this user can use now through an authorized connection.
  app.get('/v1/connections/:id/tools', async c => {
    const input = z.object({external_user_id:userSchema,...toolQuery}).strict().parse(c.req.query());
    const connection = await service.getConnection(c.get('project').id, input.external_user_id, c.req.param('id'));
    if (connection.status !== 'connected') throw new AppError(connection.status === 'revoked' ? 'connection_revoked' : 'reauth_required', 'Reconnect this account before using its tools.', 409);
    // Without a cached catalog, read it with this connection's credential (which also caches it).
    const tools = await service.connectorStore.in(c.get('project').workspace_id).catalog(connection.connector)
      ?? await service.execute(c.get('project').id, input.external_user_id, connection.id, `${connection.connector}.__discover`, {}) as ToolDefinition[];
    return c.json(pageTools(tools, input));
  });
  app.post('/v1/connections/:id/tools/:name/call', async c => {
    const tool = toolName.parse(c.req.param('name'));
    const input = z.object({ external_user_id: userSchema, input: z.record(z.string(), z.unknown()).default({}) }).strict().parse(await c.req.json());
    const data = await service.execute(c.get('project').id, input.external_user_id, c.req.param('id'), tool, input.input);
    return c.json({ data, request_id: c.get('requestId') });
  });
  app.get('/v1/events', async c => {
    const input = z.object({ external_user_id: userSchema.optional(), connection_id: z.string().min(1).max(200).optional(), type: z.string().regex(/^[a-z_]+\.[a-z_]+$/).optional(),
      after: z.string().regex(/^\d{1,18}$/).default('0'), limit: z.coerce.number().int().min(1).max(100).default(100) }).strict().parse(c.req.query());
    const { rows } = await service.pool.query(`SELECT seq,type,external_user_id,connection_id,data,created_at FROM events
      WHERE project_id=$1 AND seq>$2 AND ($3::text IS NULL OR external_user_id=$3) AND ($4::text IS NULL OR connection_id=$4) AND ($5::text IS NULL OR type=$5)
      ORDER BY seq LIMIT $6`, [c.get('project').id, input.after, input.external_user_id ?? null, input.connection_id ?? null, input.type ?? null, input.limit]);
    return c.json({ data: rows, next_cursor: rows.at(-1)?.seq || input.after });
  });
  app.get('/connect/:token', async c => {
    const token = z.string().length(43).parse(c.req.param('token'));
    const { session, browser, url } = await service.begin(token);
    setCookie(c, `connany_${session.id}`, browser, { httpOnly: true, secure: service.runtime.config.publicBaseUrl.startsWith('https:'), sameSite: 'Lax', path: `/oauth/${session.connector}/callback`, maxAge: 900 });
    return c.redirect(url, 302);
  });
  app.post('/connect/:token/start', async c => {
    if (c.req.header('Origin') !== service.runtime.config.publicBaseUrl) throw new AppError('invalid_origin', 'Open the connection link directly in your browser.', 403);
    const token = z.string().length(43).parse(c.req.param('token'));
    const { session, browser, url } = await service.begin(token);
    setCookie(c, `connany_${session.id}`, browser, { httpOnly: true, secure: service.runtime.config.publicBaseUrl.startsWith('https:'), sameSite: 'Lax', path: `/oauth/${session.connector}/callback`, maxAge: 900 });
    // Finish the same-origin POST before starting a new GET navigation. Upstream login
    // redirects may cross domains and must not inherit the form submission's CSP.
    c.header('Refresh', `0;url=${url}`);
    return c.html(redirectPage(url));
  });
  app.get('/oauth/:connector/callback', async c => {
    const connector = z.enum(connectorNames).parse(c.req.param("connector"));
    const state = z.string().length(43).parse(c.req.query('state'));
    const s = await service.findCallback(connector, state);
    const browser = getCookie(c, `connany_${s.id}`) || '';
    const result = await service.finish(s, browser, c.req.query('code'), !!c.req.query('error'));
    deleteCookie(c, `connany_${s.id}`, { path: `/oauth/${connector}/callback`, secure: service.runtime.config.publicBaseUrl.startsWith('https:') });
    if (s.purpose === 'tool_sync') return c.html(toolSyncPage(s.connector, result.errorCode, result.toolCount ?? 0), result.errorCode ? 400 : 200);
    const runtime = await service.connectorStore.resolve(s.connector, s.connector_app_id);
    // With a return_url the agent shows the outcome, including failures, so users
    // stay in its own UI. The query only hints the outcome; the agent confirms it.
    if (s.return_url) {
      const returnUrl = new URL(s.return_url);
      returnUrl.searchParams.set('connany_session_id', s.id);
      if (result.errorCode) {
        returnUrl.searchParams.set('connany_status', 'error');
        returnUrl.searchParams.set('connany_error', result.errorCode);
      }
      return c.redirect(returnUrl.toString(), 302);
    }
    const access = connectorSpec(s.connector).access;
    const pending = access && result.connection && access.needsAccess(result.connection.identity) ? { label: access.label, url: access.addUrl(runtime) } : null;
    return c.html(resultPage(s, result.errorCode, pending), result.errorCode ? 400 : 200);
  });
  mountAdmin(app, service);
  app.notFound(c => c.json({ error: { code: 'not_found', message: 'Route not found.' } }, 404));
  return app;
}

/**
 * Connany as an MCP server: OAuth discovery and endpoints, then the Streamable HTTP endpoint.
 * Bearer tokens only (no cookies), so cross-origin requests are allowed for browser clients.
 */
function mountMcp(app: Hono<any>, service: Service) {
  // Read lazily: tests mount the app with partial services.
  const base = () => service.runtime.config.publicBaseUrl;
  const server = () => new OAuthServer(service.pool, base());
  const mcp = new McpServer(service);
  const cors = ['/.well-known/*', '/oauth2/register', '/oauth2/token', '/oauth2/revoke', '/mcp'];
  for (const path of cors) app.use(path, async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID');
    c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    c.header('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
  });
  app.get('/.well-known/oauth-protected-resource', c => c.json(server().protectedResource()));
  app.get('/.well-known/oauth-protected-resource/mcp', c => c.json(server().protectedResource()));
  app.get('/.well-known/oauth-authorization-server', c => c.json(server().metadata()));
  app.get('/.well-known/oauth-authorization-server/mcp', c => c.json(server().metadata()));
  const oauthError = (c: any, error: unknown) => {
    if (!(error instanceof OAuthError)) throw error;
    return c.json({ error: error.error, error_description: error.description }, error.status);
  };
  const form = async (c: any): Promise<Record<string, string>> => {
    const type = c.req.header('Content-Type') || '';
    const fields: Record<string, string> = type.includes('application/json') ? await c.req.json() : Object.fromEntries(new URLSearchParams(await c.req.text()));
    // Public clients may still send their id with HTTP Basic and an empty secret.
    const basic = c.req.header('Authorization');
    if (!fields.client_id && basic?.startsWith('Basic ')) fields.client_id = decodeURIComponent(Buffer.from(basic.slice(6), 'base64').toString().split(':')[0]);
    return fields;
  };
  app.post('/oauth2/register', async c => {
    try {
      if (await attempt(service.pool, 'oauth_register') > 200) throw new OAuthError('temporarily_unavailable', 'Too many registrations. Retry later.', 429);
      return c.json(await server().register(await c.req.json()), 201);
    } catch (error) { if (error instanceof SyntaxError) return c.json({ error: 'invalid_client_metadata', error_description: 'Send JSON.' }, 400); return oauthError(c, error); }
  });
  // The user signs in and approves the client in the console.
  app.get('/oauth2/authorize', c => c.redirect(`/admin/oauth2/authorize?${new URL(c.req.url).searchParams}`, 302));
  app.post('/oauth2/token', async c => {
    try { return c.json(await server().token(await form(c))); } catch (error) { return oauthError(c, error); }
  });
  app.post('/oauth2/revoke', async c => {
    const fields = await form(c);
    if (fields.token) await server().revoke(fields.token);
    return c.body(null, 200);
  });
  const unauthorized = (c: any) => {
    c.header('WWW-Authenticate', `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource/mcp", scope="${mcpScope}"`);
    return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Sign in to Connany: authorization required.' } }, 401);
  };
  app.post('/mcp', async c => {
    const auth = c.req.header('Authorization');
    const user = auth?.startsWith('Bearer ') ? await server().verify(auth.slice(7)) : null;
    if (!user) return unauthorized(c);
    let message: unknown;
    try { message = await c.req.json(); } catch { return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
    if (Array.isArray(message)) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batch requests are not supported.' } }, 400);
    try {
      const response = await mcp.handle(user, message);
      return response ? c.json(response) : c.body(null, 202);
    } catch (error) {
      console.error(JSON.stringify({ level: 'error', request_id: c.get('requestId'), code: 'mcp_internal_error' }));
      return c.json({ jsonrpc: '2.0', id: (message as any)?.id ?? null, error: { code: -32603, message: 'Internal error' } });
    }
  });
  // Stateless server: no server-initiated stream and no sessions to end.
  app.get('/mcp', c => { c.header('Allow', 'POST'); return c.body(null, 405); });
  app.delete('/mcp', c => { c.header('Allow', 'POST'); return c.body(null, 405); });
}
