import { readFile } from 'node:fs/promises';
import { apiMarkdown, docsPage } from './docs.js';
import { favicon } from './brand.js';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { connectorNames } from './config.js';
import { AppError } from './errors.js';
import { home, resultPage, errorPage, redirectPage, toolSyncPage } from './pages.js';
import { restToolCatalog, restTools, toolNamePattern, type ToolName } from './connectors/index.js';
import { publicConnection, publicSession, Service, type Project } from './service.js';
import type { ToolDefinition } from './connector-store.js';
import { mountAdmin } from './admin/routes.js';
import { id } from './crypto.js';
import { returnUrlSchema } from './projects.js';
import { connectorCatalog, connector as connectorSpec } from './connectors/catalog.js';

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
  app.use('*', bodyLimit({ maxSize: 32 * 1024, onError: c => c.json({ error: { code: 'body_too_large', message: 'Request exceeds 32 KB.' } }, 413) }));
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
  app.get('/docs', async c => {
    c.header('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    return c.html(await docsPage(service.runtime.config.publicBaseUrl,c.req.query('lang')));
  });
  app.get('/docs/', c => c.redirect('/docs', 302));
  app.get('/docs/api.md', async c => {
    c.header('Content-Type','text/markdown; charset=utf-8');
    return c.body(await apiMarkdown(service.runtime.config.publicBaseUrl,c.req.query('lang')));
  });
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
  app.get('/favicon.svg', c => { c.header('Content-Type', 'image/svg+xml'); return c.body(favicon); });
  app.get('/', async c => c.html(home(await service.connectorStore.list())));
  app.get('/health', async c => { await service.pool.query('SELECT 1'); return c.json({ status: 'ok', version: '0.1.0' }); });
  app.use('/v1/*', async (c, next) => {
    const auth = c.req.header('Authorization');
    c.set('project', await service.authenticate(auth?.startsWith('Bearer ') ? auth.slice(7) : ''));
    await next();
  });
  app.get('/v1/connectors', async c => {
    const base = service.runtime.config.publicBaseUrl;
    return c.json({ data: (await service.connectorStore.list()).filter(item => item.enabled).map(item => ({ name: item.name, title: connectorCatalog[item.name].label, avatar_url: `${base}/connectors/${item.name}/avatar.svg`, tools_synced_at: item.tools_synced_at })) });
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
  const pageTools = (tools: ToolDefinition[], input: {query?: string; limit: number; offset: number; read_only?: boolean}) => {
    const words=(input.query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const exact = (input.query || '').trim().toLowerCase();
    const matches=tools.filter(t=>(input.read_only===undefined || t.read_only===input.read_only) && (!words.length || words.some(w=>(t.name+' '+t.description).toLowerCase().includes(w))))
      .sort((a,b)=>Number(b.name.toLowerCase()===exact)-Number(a.name.toLowerCase()===exact) || a.connector.localeCompare(b.connector) || a.name.localeCompare(b.name));
    return {data:matches.slice(input.offset,input.offset+input.limit),total:matches.length,next_offset:input.offset+input.limit<matches.length?input.offset+input.limit:null};
  };
  // Catalog view: what each enabled connector offers, independent of users.
  app.get('/v1/tools', async c => {
    const input = z.object({connector:z.enum(connectorNames).optional(),...toolQuery}).strict().parse(c.req.query());
    return c.json(pageTools((await service.connectorStore.tools()).filter(t=>!input.connector || t.connector===input.connector), input));
  });
  // Runtime view: tools this user can use now through an authorized connection.
  app.get('/v1/connections/:id/tools', async c => {
    const input = z.object({external_user_id:userSchema,...toolQuery}).strict().parse(c.req.query());
    const connection = await service.getConnection(c.get('project').id, input.external_user_id, c.req.param('id'));
    if (connection.status !== 'connected') throw new AppError(connection.status === 'revoked' ? 'connection_revoked' : 'reauth_required', 'Reconnect this account before using its tools.', 409);
    // Without a cached catalog, read it with this connection's credential (which also caches it).
    const tools = await service.connectorStore.catalog(connection.connector)
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
    if (!result.errorCode) {
      if (s.return_url) {
        const returnUrl = new URL(s.return_url);
        returnUrl.searchParams.set('connany_session_id', s.id);
        return c.redirect(returnUrl.toString(), 302);
      }
    }
    const access = connectorSpec(s.connector).access;
    const pending = access && result.connection && access.needsAccess(result.connection.identity) ? { label: access.label, url: access.addUrl(runtime) } : null;
    return c.html(resultPage(s, result.errorCode, pending), result.errorCode ? 400 : 200);
  });
  mountAdmin(app, service);
  app.notFound(c => c.json({ error: { code: 'not_found', message: 'Route not found.' } }, 404));
  return app;
}
