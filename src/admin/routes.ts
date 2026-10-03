import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { AdminAuth, ConsoleUsers, csrfToken, passwordSchema, roleSchema, emailSchema, type AdminIdentity } from './auth.js';
import { layout, loginPage, overview, connectorList, connectorHref, projectList, connectionsPage, activityPage, agentDocsPage, docsPage, testPage, projectDetail, usersPage } from './pages.js';
import { connectorNames } from '../config.js';
import { connector as connectorSpec } from '../connectors/catalog.js';
import { connectorAppInput } from '../connector-store.js';
import { maxActiveApiKeys, projectInput, publicApiKeyColumns, publicProjectColumns } from '../projects.js';
import { AppError } from '../errors.js';
import { apiMarkdown, renderDocs } from '../docs.js';
import { hash, id, randomToken } from '../crypto.js';
import { transaction } from '../db.js';
import { publicConnection, type Service } from '../service.js';

export function mountAdmin(root: Hono<any>, service: Service) {
  const app = new Hono<{ Variables: { admin: AdminIdentity; csrf: string; sessionToken: string } }>();
  const auth = new AdminAuth(service.pool);
  const users = new ConsoleUsers(service.pool);
  const base = () => service.runtime.config.publicBaseUrl;
  const secure = () => base().startsWith('https:');
  const cookieOptions = () => ({ httpOnly: true, secure: secure(), sameSite: 'Strict' as const, path: '/admin', maxAge: 8 * 3600 });
  app.use('*', async (c,next) => {
    c.header('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const path = c.req.path.replace(/^\/admin/, '') || '/';
    if (path.startsWith('/assets/')) return next();
    if (!['GET','HEAD'].includes(c.req.method)) {
      if (c.req.header('Origin') !== base()) throw new AppError('invalid_origin','管理操作必须从本站页面发起。',403);
      if (!c.req.header('Content-Type')?.startsWith('application/json')) throw new AppError('invalid_content_type','请使用 JSON 请求。',415);
    }
    const token = getCookie(c,'connany_admin');
    const admin = await auth.current(token);
    if (path === '/login' && c.req.method === 'GET') return admin ? c.redirect('/admin') : next();
    if (path === '/api/login' && c.req.method === 'POST') return next();
    if (!admin || !token) {
      if (path.startsWith('/api/')) throw new AppError('admin_unauthorized','请登录管理员账号。',401);
      return c.redirect('/admin/login');
    }
    c.set('admin',admin); c.set('sessionToken',token); c.set('csrf',csrfToken(token));
    // The System section (user management) is for administrators only.
    if (admin.role !== 'admin' && (path === '/users' || path.startsWith('/users/') || path.startsWith('/api/users'))) {
      if (path.startsWith('/api/')) throw new AppError('forbidden','需要系统管理员权限。',403);
      return c.redirect('/admin');
    }
    if (!['GET','HEAD'].includes(c.req.method) && c.req.header('X-CSRF-Token') !== csrfToken(token)) throw new AppError('invalid_csrf','页面已失效，请刷新后重试。',403);
    await next();
  });
  app.get('/assets/admin.css', async c => { c.header('Content-Type','text/css; charset=utf-8'); return c.body(await readFile('public/admin.css','utf8')); });
  app.get('/assets/admin-preferences.js', async c => { c.header('Content-Type','text/javascript; charset=utf-8'); return c.body(await readFile('public/admin-preferences.js','utf8')); });
  app.get('/assets/admin-i18n.js', async c => { c.header('Content-Type','text/javascript; charset=utf-8'); return c.body(await readFile('public/admin-i18n.js','utf8')); });
  app.get('/assets/admin.js', async c => { c.header('Content-Type','text/javascript; charset=utf-8'); return c.body(await readFile('public/admin.js','utf8')); });
  app.get('/login', c => c.html(loginPage()));
  app.post('/api/login', async c => {
    const input = z.object({email:z.string(),password:z.string()}).strict().parse(await c.req.json());
    const token = await auth.login(input.email,input.password);
    setCookie(c,'connany_admin',token,cookieOptions());
    return c.json({ok:true});
  });
  app.post('/api/logout', async c => {
    await auth.logout(c.get('sessionToken')); deleteCookie(c,'connany_admin',{path:'/admin',secure:secure()}); return c.json({ok:true});
  });
  app.post('/api/account/password', async c => {
    const input = z.object({current_password:z.string().min(1).max(256),new_password:z.string().min(8).max(256),confirm_password:z.string().min(8).max(256)}).strict().parse(await c.req.json());
    if (input.new_password !== input.confirm_password) throw new AppError('password_mismatch','两次输入的新密码不一致。',400);
    await auth.changePassword(c.get('admin').id,input.current_password,input.new_password);
    deleteCookie(c,'connany_admin',{path:'/admin',secure:secure()});
    return c.json({ok:true});
  });
  // Everything in the console is scoped to the signed-in user's workspace.
  const ws = (c: any): string => c.get('admin').workspace_id;
  const store = (c: any) => service.connectorStore.in(ws(c));
  const render = (c: any, title: string, active: string, content: string) => c.html(layout(title,active,c.get('admin').email,c.get('csrf'),content,c.get('admin').role));
  app.get('/', async c => {
    const [connectors, counts] = await Promise.all([store(c).list(), service.pool.query(`SELECT (SELECT count(*) FROM projects WHERE workspace_id=$1)::int AS projects,(SELECT count(*) FROM projects WHERE workspace_id=$1 AND enabled)::int AS active_projects,(SELECT count(*) FROM connections c JOIN projects p ON p.id=c.project_id WHERE p.workspace_id=$1 AND c.status='connected')::int AS connections`,[ws(c)])]);
    return render(c,'总览','overview',overview(connectors,counts.rows[0]));
  });
  app.get('/connectors', async c => render(c,'连接器','connectors',connectorList(await store(c).list())));
  app.get('/connectors/:connector', async c => {
    const connector = z.enum(connectorNames).parse(c.req.param('connector'));
    return c.redirect(connectorHref(connector), 302);
  });
  app.get('/api/connectors', async c => c.json({data:await store(c).list()}));
  app.post('/api/connectors/:connector', async c => {
    const connector = z.enum(connectorNames).parse(c.req.param('connector'));
    if (connectorSpec(connector).auth === 'mcp') {
      const input=z.object({enabled:z.boolean()}).strict().parse(await c.req.json());
      try { await store(c).saveMcp(connector,input.enabled,c.get('admin').id); }
      catch (error) {
        // Registration happens on the connector's servers; show what they answered.
        if (!(error instanceof AppError) || !error.details?.upstream_status) throw error;
        const reason = [error.details.upstream_status, error.details.upstream_error, error.details.upstream_error_description].filter(Boolean).join(' · ');
        throw new AppError('connector_registration_failed',`${connectorSpec(connector).label} 拒绝了客户端注册（${reason}）。`,502,error.details);
      }
    } else {
      const body = await c.req.json();
      const toggle = z.object({enabled:z.boolean()}).strict().safeParse(body);
      if (toggle.success) await store(c).setEnabled(connector,toggle.data.enabled,c.get('admin').id);
      else await store(c).save(connector,connectorAppInput.parse(body),c.get('admin').id);
    }
    return c.json({ok:true});
  });
  app.post('/api/connectors/:connector/tool-sync', async c => {
    const connector = z.enum(connectorNames).parse(c.req.param('connector'));
    const { session, browser, url } = await service.beginToolSync(connector, c.get('admin').id, ws(c));
    setCookie(c, `connany_${session.id}`, browser, { httpOnly: true, secure: secure(), sameSite: 'Lax', path: `/oauth/${connector}/callback`, maxAge: 900 });
    return c.json({ redirect_url: url });
  });
  const audit = (db: { query: (sql: string, values: unknown[]) => Promise<unknown> }, adminId: string, action: string, target: string) =>
    db.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$3)',[adminId,action,target]);
  async function listProjects(workspaceId: string, after='') {
    return (await service.pool.query(`SELECT ${publicProjectColumns.split(',').map(column=>`p.${column}`).join(',')},
      (SELECT count(*) FROM connections c WHERE c.project_id=p.id)::int AS connection_count,
      (SELECT count(*) FROM api_keys k WHERE k.project_id=p.id AND k.revoked_at IS NULL)::int AS api_key_count
      FROM projects p WHERE p.workspace_id=$1 AND p.id>$2 ORDER BY p.id LIMIT 51`,[workspaceId,after])).rows;
  }
  async function getProject(workspaceId: string, projectId: string) {
    const {rows} = await service.pool.query(`SELECT ${publicProjectColumns},(SELECT count(*) FROM connections c WHERE c.project_id=projects.id)::int AS connection_count FROM projects WHERE id=$1 AND workspace_id=$2`,[projectId,workspaceId]);
    if (!rows[0]) throw new AppError('not_found','Project 不存在。',404);
    return rows[0];
  }
  async function issueApiKey(db: any, projectId: string, name = '') {
    const key = `cn_live_${randomToken()}`; const keyId = id('key');
    const {rows} = await db.query(`INSERT INTO api_keys(id,project_id,name,key_hash,key_prefix) VALUES($1,$2,$3,$4,$5) RETURNING ${publicApiKeyColumns}`,[keyId,projectId,name,hash(key),key.slice(0,16)]);
    return {apiKey:rows[0],key};
  }
  app.get('/projects', async c => {
    const rows = await listProjects(ws(c),c.req.query('after'));
    return render(c,'项目','projects',projectList(rows.slice(0,50),rows.length>50?rows[49].id:null));
  });
  app.get('/projects/:id', async c => {
    const project = await getProject(ws(c),c.req.param('id'));
    const {rows: keys} = await service.pool.query(`SELECT ${publicApiKeyColumns} FROM api_keys WHERE project_id=$1 ORDER BY revoked_at IS NOT NULL, created_at DESC`,[project.id]);
    return render(c,project.name,'projects',projectDetail(project,keys));
  });
  app.get('/keys', c => c.redirect('/admin/projects', 301));
  app.get('/api/projects', async c => {
    const rows = await listProjects(ws(c),c.req.query('after')); return c.json({data:rows.slice(0,50),next_cursor:rows.length>50?rows[49].id:null});
  });
  app.post('/api/projects', async c => {
    const input = projectInput.parse(await c.req.json()); const projectId = id('proj');
    const result = await transaction(service.pool,async db => {
      const {rows} = await db.query(`INSERT INTO projects(id,workspace_id,name,return_urls) VALUES($1,$2,$3,$4) RETURNING ${publicProjectColumns}`, [projectId,ws(c),input.name,JSON.stringify(input.return_urls ?? [])]);
      const issued = await issueApiKey(db,projectId);
      await audit(db,c.get('admin').id,'project.created',projectId);
      return {project:rows[0],...issued};
    });
    return c.json({project:result.project,api_key:result.key},201);
  });
  app.post('/api/projects/:id', async c => {
    const input = projectInput.parse(await c.req.json());
    const project = await transaction(service.pool,async db => {
      const {rows} = await db.query(`UPDATE projects SET name=$1,return_urls=COALESCE($2::jsonb,return_urls),updated_at=now() WHERE id=$3 AND workspace_id=$4 RETURNING ${publicProjectColumns}`,[input.name,input.return_urls ? JSON.stringify(input.return_urls) : null,c.req.param('id'),ws(c)]);
      if (!rows[0]) throw new AppError('not_found','Project 不存在。',404);
      await audit(db,c.get('admin').id,'project.updated',c.req.param('id'));return rows[0];
    });
    return c.json({project});
  });
  app.post('/api/projects/:id/status', async c => {
    const input = z.object({enabled:z.boolean()}).strict().parse(await c.req.json());
    const project = await transaction(service.pool,async db => {
      const {rows} = await db.query(`UPDATE projects SET enabled=$1,updated_at=now() WHERE id=$2 AND workspace_id=$3 RETURNING ${publicProjectColumns}`,[input.enabled,c.req.param('id'),ws(c)]);
      if (!rows[0]) throw new AppError('not_found','Project 不存在。',404);
      if (!input.enabled) await db.query("UPDATE connect_sessions SET status='error',error_code='project_disabled',state_hash=NULL,browser_hash=NULL,verifier_ciphertext=NULL WHERE project_id=$1 AND status IN ('pending','authorizing')",[c.req.param('id')]);
      await audit(db,c.get('admin').id,input.enabled?'project.enabled':'project.disabled',c.req.param('id'));return rows[0];
    });
    return c.json({project});
  });
  app.post('/api/projects/:id/delete', async c => {
    const project = await getProject(ws(c),c.req.param('id'));
    const result = await service.deleteProject(project.id);
    await audit(service.pool,c.get('admin').id,'project.deleted',project.id);
    return c.json({ok:true,...result});
  });
  app.post('/api/projects/:id/api-keys', async c => {
    const input = z.object({name:z.string().trim().max(100).default('')}).strict().parse(await c.req.json());
    const project = await getProject(ws(c),c.req.param('id'));
    const result = await transaction(service.pool,async db => {
      await db.query('SELECT 1 FROM projects WHERE id=$1 FOR UPDATE',[project.id]);
      const active = (await db.query('SELECT count(*)::int AS count FROM api_keys WHERE project_id=$1 AND revoked_at IS NULL',[project.id])).rows[0].count;
      if (active >= maxActiveApiKeys) throw new AppError('api_key_limit',`每个项目最多 ${maxActiveApiKeys} 个有效 API Key，请先吊销旧的。`,409);
      const issued = await issueApiKey(db,project.id,input.name);
      await audit(db,c.get('admin').id,'api_key.created',issued.apiKey.id);
      return issued;
    });
    return c.json({api_key:result.key,key:result.apiKey},201);
  });
  app.post('/api/api-keys/:id/revoke', async c => {
    const key = await transaction(service.pool,async db => {
      const {rows} = await db.query(`UPDATE api_keys k SET revoked_at=COALESCE(k.revoked_at,now()) FROM projects p WHERE k.id=$1 AND p.id=k.project_id AND p.workspace_id=$2 RETURNING ${publicApiKeyColumns.split(',').map(column=>`k.${column}`).join(',')}`,[c.req.param('id'),ws(c)]);
      if (!rows[0]) throw new AppError('not_found','API Key 不存在。',404);
      await audit(db,c.get('admin').id,'api_key.revoked',c.req.param('id'));return rows[0];
    });
    return c.json({key});
  });
  async function connectionRows(workspaceId: string, project='',connector='',after='') {
    return (await service.pool.query(`SELECT c.*,p.name AS project_name FROM connections c JOIN projects p ON p.id=c.project_id WHERE p.workspace_id=$4 AND ($1='' OR c.project_id=$1) AND ($2='' OR c.connector=$2) AND c.id>$3 ORDER BY c.id LIMIT 51`,[project,connector,after,workspaceId])).rows;
  }
  app.get('/connections', async c => {
    const project=c.req.query('project_id') || ''; const connector=c.req.query('connector') || '';
    const [rows,projects]=await Promise.all([connectionRows(ws(c),project,connector,c.req.query('after')),service.pool.query('SELECT id,name FROM projects WHERE workspace_id=$1 ORDER BY name',[ws(c)])]);
    return render(c,'用户连接','connections',connectionsPage(rows.slice(0,50),projects.rows,project,connector,rows.length>50?rows[49].id:null));
  });
  app.get('/api/connections', async c => {
    const rows=await connectionRows(ws(c),c.req.query('project_id'),c.req.query('connector'),c.req.query('after'));
    return c.json({data:rows.slice(0,50).map(row=>({...publicConnection(row),project_id:row.project_id,project_name:row.project_name})),next_cursor:rows.length>50?rows[49].id:null});
  });
  app.post('/api/connections/:id/disconnect', async c => {
    const connection=(await service.pool.query('SELECT c.project_id,c.external_user_id FROM connections c JOIN projects p ON p.id=c.project_id WHERE c.id=$1 AND p.workspace_id=$2',[c.req.param('id'),ws(c)])).rows[0];
    if (!connection) throw new AppError('not_found','连接不存在。',404);
    const result=await service.disconnect(connection.project_id,connection.external_user_id,c.req.param('id'));
    await service.pool.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$3)',[c.get('admin').id,'connection.disconnected',c.req.param('id')]);
    return c.json(result);
  });
  app.get('/users', async c => render(c,'用户管理','users',usersPage(await users.list(),c.get('admin'))));
  app.get('/api/users', async c => c.json({data:await users.list()}));
  app.post('/api/users', async c => {
    const input = z.object({email:emailSchema,password:passwordSchema,role:roleSchema.default('member')}).strict().parse(await c.req.json());
    return c.json({user:await users.create(c.get('admin'),input)},201);
  });
  app.post('/api/users/:id/role', async c => {
    const {role} = z.object({role:roleSchema}).strict().parse(await c.req.json());
    return c.json({user:await users.setRole(c.get('admin'),c.req.param('id'),role)});
  });
  app.post('/api/users/:id/password', async c => {
    const {password} = z.object({password:passwordSchema}).strict().parse(await c.req.json());
    await users.resetPassword(c.get('admin'),c.req.param('id'),password); return c.json({ok:true});
  });
  app.post('/api/users/:id/delete', async c => {
    await users.remove(c.get('admin'),c.req.param('id'),async userId => {
      const { rows } = await service.pool.query('SELECT id FROM workspaces WHERE owner_id=$1',[userId]);
      for (const workspace of rows) await service.deleteWorkspace(workspace.id);
    });
    return c.json({ok:true});
  });
  app.get('/activity', async c => {
    const [events,audits]=await Promise.all([service.pool.query('SELECT e.*,p.name AS project_name FROM events e JOIN projects p ON p.id=e.project_id WHERE p.workspace_id=$1 ORDER BY e.seq DESC LIMIT 100',[ws(c)]),service.pool.query('SELECT a.*,COALESCE(u.email,a.actor_email) AS email FROM admin_audit a LEFT JOIN admin_users u ON u.id=a.admin_id WHERE a.admin_id=$1 ORDER BY a.seq DESC LIMIT 100',[c.get('admin').id])]);
    return render(c,'操作记录','activity',activityPage(events.rows,audits.rows));
  });
  app.get('/test', async c => {
    const connectors = await store(c).list();
    const selected = z.enum(connectorNames).optional().parse(c.req.query('connector')) || connectors.find(p=>p.enabled)?.name || 'notion';
    return render(c,'连接测试','test',testPage(connectors, selected));
  });
  const agentPrompt = async () => `请在当前 agent 产品中实现 Connany 连接功能，先检查现有用户认证、后端路由和工具执行器，再按下方协议完成实现和验证。
服务地址：${base()}
环境变量：CONNANY_BASE_URL=${base()}；CONNANY_API_KEY 由管理员单独配置到后端，不要询问或输出密钥值。
${new URL(base()).hostname === 'localhost' || new URL(base()).hostname === '127.0.0.1' ? '注意：当前是本地服务地址，仅运行在同一台机器上的后端可直接使用。远程部署需换成可访问的 HTTPS 服务地址，并同步配置平台 OAuth callback。' : ''}
需要实现：设置页的连接器列表与连接按钮、授权结果确认、已连接账号管理（检查、重新授权、断开、补充资源访问），以及对话中的工具调用：每轮对话按当前用户的有效连接注册工具，未连接时在对话中展示授权按钮，授权失效时引导重新连接。用户 ID 必须来自服务端登录会话，工具执行器固定用户和连接，模型只能填写工具参数。优先使用 SDK 的 createAgentTools；写操作由后端按产品策略开启并在执行前向用户确认。后台任务轮询 GET /v1/events 同步状态变化。当前是 HTTP API，不是 MCP 端点；不要把管理员页面当成无需登录的 API 文档地址。
按下方文档第 7 节的清单完成验收。

` + (await readFile('docs/agent-integration.md','utf8')).replaceAll('https://connect.your-domain.com',base());
  app.get('/docs', async c => render(c,'API 文档','guide',docsPage(await Promise.all(['en','zh-CN'].map(async language => ({ language, ...renderDocs(await apiMarkdown(base(),language),language,`docs-${language}`) }))))));
  app.get('/docs/agent', async c => render(c,'Agent 接入指南','guide',agentDocsPage(renderDocs((await readFile('docs/agent-integration.md','utf8')).replaceAll('https://connect.your-domain.com',base()),'zh-CN','agent'),await agentPrompt())));
  app.get('/guide', c => c.redirect('/admin/docs/agent', 301));
  app.get('/guide/sdk', async c => {
    c.header('Content-Type','text/plain; charset=utf-8'); c.header('Content-Disposition','attachment; filename="connany-client.ts"');
    return c.body(await readFile('sdk/client.ts','utf8'));
  });
  app.get('/guide/download', async c => {
    c.header('Content-Type','text/markdown; charset=utf-8');c.header('Content-Disposition','attachment; filename="connany-agent-integration.md"');
    return c.body(await agentPrompt());
  });
  root.get('/admin/', c => c.redirect('/admin'));
  root.route('/admin',app);
}
