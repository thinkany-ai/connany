import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { AdminAuth, csrfToken, type AdminIdentity } from './auth.js';
import { layout, loginPage, overview, providerList, providerHref, projectList, connectionsPage, activityPage, guidePage, testPage } from './pages.js';
import { providerNames } from '../config.js';
import { provider as providerSpec } from '../providers/catalog.js';
import { providerInput } from '../provider-store.js';
import { projectInput, publicProjectColumns } from '../projects.js';
import { AppError } from '../errors.js';
import { hash, id, randomToken } from '../crypto.js';
import { transaction } from '../db.js';
import { publicConnection, type Service } from '../service.js';

export function mountAdmin(root: Hono<any>, service: Service) {
  const app = new Hono<{ Variables: { admin: AdminIdentity; csrf: string; sessionToken: string } }>();
  const auth = new AdminAuth(service.pool);
  const base = () => service.providers.config.publicBaseUrl;
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
    const input = z.object({current_password:z.string().min(1).max(256),new_password:z.string().min(12).max(256),confirm_password:z.string().min(12).max(256)}).strict().parse(await c.req.json());
    if (input.new_password !== input.confirm_password) throw new AppError('password_mismatch','两次输入的新密码不一致。',400);
    await auth.changePassword(c.get('admin').id,input.current_password,input.new_password);
    deleteCookie(c,'connany_admin',{path:'/admin',secure:secure()});
    return c.json({ok:true});
  });
  const render = (c: any, title: string, active: string, content: string) => c.html(layout(title,active,c.get('admin').email,c.get('csrf'),content));
  app.get('/', async c => {
    const [providers, counts] = await Promise.all([service.providerStore.list(), service.pool.query(`SELECT (SELECT count(*) FROM projects)::int AS projects,(SELECT count(*) FROM projects WHERE enabled)::int AS active_projects,(SELECT count(*) FROM connections WHERE status='connected')::int AS connections`)]);
    return render(c,'总览','overview',overview(providers,counts.rows[0]));
  });
  app.get('/connectors', async c => render(c,'连接器','providers',providerList(await service.providerStore.list())));
  app.get('/providers', c => c.redirect('/admin/connectors', 301));
  app.get('/providers/:provider', async c => {
    const provider = z.enum(providerNames).parse(c.req.param('provider'));
    return c.redirect(providerHref(provider), 302);
  });
  app.get('/api/providers', async c => c.json({data:await service.providerStore.list()}));
  app.post('/api/providers/:provider', async c => {
    const provider = z.enum(providerNames).parse(c.req.param('provider'));
    if (providerSpec(provider).auth === 'mcp') {
      const input=z.object({enabled:z.boolean()}).strict().parse(await c.req.json());
      await service.providerStore.saveMcp(provider,input.enabled,c.get('admin').id);
    } else {
      const body = await c.req.json();
      const toggle = z.object({enabled:z.boolean()}).strict().safeParse(body);
      if (toggle.success) await service.providerStore.setEnabled(provider,toggle.data.enabled,c.get('admin').id);
      else await service.providerStore.save(provider,providerInput.parse(body),c.get('admin').id);
    }
    return c.json({ok:true});
  });
  async function listProjects(after='') {
    return (await service.pool.query(`SELECT p.id,p.name,p.enabled,p.key_prefix,p.key_created_at,p.return_urls,p.created_at,p.updated_at,(SELECT count(*) FROM connections c WHERE c.project_id=p.id)::int AS connection_count FROM projects p WHERE p.id>$1 ORDER BY p.id LIMIT 51`,[after])).rows;
  }
  app.get('/keys', async c => {
    const rows = await listProjects(c.req.query('after'));
    return render(c,'API Keys','projects',projectList(rows.slice(0,50),rows.length>50?rows[49].id:null));
  });
  for (const base of ['/api-keys','/projects']) {
    app.get(base, c => c.redirect('/admin/keys', 301));
    app.get(`${base}/new`, c => c.redirect('/admin/keys#new-key', 301));
    app.get(`${base}/:id`, c => c.redirect(`/admin/keys#edit-${encodeURIComponent(c.req.param('id'))}`, 301));
  }
  app.get('/api/projects', async c => {
    const rows = await listProjects(c.req.query('after')); return c.json({data:rows.slice(0,50),next_cursor:rows.length>50?rows[49].id:null});
  });
  app.post('/api/projects', async c => {
    const input = projectInput.parse(await c.req.json()); const projectId = id('proj'); const key = `cn_live_${randomToken()}`;
    const project = await transaction(service.pool,async db => {
      const {rows} = await db.query(`INSERT INTO projects(id,name,api_key_hash,key_prefix,return_urls) VALUES($1,$2,$3,$4,$5) RETURNING ${publicProjectColumns}`, [projectId,input.name,hash(key),key.slice(0,16),JSON.stringify(input.return_urls ?? [])]);
      await db.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$3)',[c.get('admin').id,'project.created',projectId]); return rows[0];
    });
    return c.json({project,api_key:key},201);
  });
  app.post('/api/projects/:id', async c => {
    const input = projectInput.parse(await c.req.json());
    const project = await transaction(service.pool,async db => {
      const {rows} = await db.query(`UPDATE projects SET name=$1,return_urls=COALESCE($2::jsonb,return_urls),updated_at=now() WHERE id=$3 RETURNING ${publicProjectColumns}`,[input.name,input.return_urls ? JSON.stringify(input.return_urls) : null,c.req.param('id')]);
      if (!rows[0]) throw new AppError('not_found','API Key 接入记录不存在。',404);
      await db.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$3)',[c.get('admin').id,'project.updated',c.req.param('id')]);return rows[0];
    });
    return c.json({project});
  });
  app.post('/api/projects/:id/status', async c => {
    const input = z.object({enabled:z.boolean()}).strict().parse(await c.req.json());
    const project = await transaction(service.pool,async db => {
      const {rows} = await db.query(`UPDATE projects SET enabled=$1,updated_at=now() WHERE id=$2 RETURNING ${publicProjectColumns}`,[input.enabled,c.req.param('id')]);
      if (!rows[0]) throw new AppError('not_found','API Key 接入记录不存在。',404);
      if (!input.enabled) await db.query("UPDATE connect_sessions SET status='error',error_code='project_disabled',state_hash=NULL,browser_hash=NULL,verifier_ciphertext=NULL WHERE project_id=$1 AND status IN ('pending','authorizing')",[c.req.param('id')]);
      await db.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$3)',[c.get('admin').id,input.enabled?'project.enabled':'project.disabled',c.req.param('id')]);return rows[0];
    });
    return c.json({project});
  });
  app.post('/api/projects/:id/delete', async c => {
    const projectId = c.req.param('id');
    const result = await service.deleteProject(projectId);
    await service.pool.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$3)',[c.get('admin').id,'project.deleted',projectId]);
    return c.json({ok:true,...result});
  });
  app.post('/api/projects/:id/rotate-key', async c => {
    const key = `cn_live_${randomToken()}`;
    const project = await transaction(service.pool,async db => {
      const {rows} = await db.query(`UPDATE projects SET api_key_hash=$1,key_prefix=$2,key_created_at=now(),updated_at=now() WHERE id=$3 RETURNING ${publicProjectColumns}`,[hash(key),key.slice(0,16),c.req.param('id')]);
      if (!rows[0]) throw new AppError('not_found','API Key 接入记录不存在。',404);
      await db.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$3)',[c.get('admin').id,'project.key_rotated',c.req.param('id')]);return rows[0];
    });
    return c.json({project,api_key:key});
  });
  async function connectionRows(project='',provider='',after='') {
    return (await service.pool.query(`SELECT c.*,p.name AS project_name FROM connections c JOIN projects p ON p.id=c.project_id WHERE ($1='' OR c.project_id=$1) AND ($2='' OR c.provider=$2) AND c.id>$3 ORDER BY c.id LIMIT 51`,[project,provider,after])).rows;
  }
  app.get('/connections', async c => {
    const project=c.req.query('project_id') || ''; const provider=c.req.query('provider') || '';
    const rows=await connectionRows(project,provider,c.req.query('after'));
    return render(c,'用户连接','connections',connectionsPage(rows.slice(0,50),project,provider,rows.length>50?rows[49].id:null));
  });
  app.get('/api/connections', async c => {
    const rows=await connectionRows(c.req.query('project_id'),c.req.query('provider'),c.req.query('after'));
    return c.json({data:rows.slice(0,50).map(row=>({...publicConnection(row),project_id:row.project_id,project_name:row.project_name})),next_cursor:rows.length>50?rows[49].id:null});
  });
  app.post('/api/connections/:id/disconnect', async c => {
    const connection=(await service.pool.query('SELECT project_id,external_user_id FROM connections WHERE id=$1',[c.req.param('id')])).rows[0];
    if (!connection) throw new AppError('not_found','连接不存在。',404);
    const result=await service.disconnect(connection.project_id,connection.external_user_id,c.req.param('id'));
    await service.pool.query('INSERT INTO admin_audit(admin_id,action,target) VALUES($1,$2,$3)',[c.get('admin').id,'connection.disconnected',c.req.param('id')]);
    return c.json(result);
  });
  app.get('/activity', async c => {
    const [events,audits]=await Promise.all([service.pool.query('SELECT e.*,p.name AS project_name FROM events e JOIN projects p ON p.id=e.project_id ORDER BY e.seq DESC LIMIT 100'),service.pool.query('SELECT a.*,u.email FROM admin_audit a JOIN admin_users u ON u.id=a.admin_id ORDER BY a.seq DESC LIMIT 100')]);
    return render(c,'操作记录','activity',activityPage(events.rows,audits.rows));
  });
  app.get('/test', async c => {
    const providers = await service.providerStore.list();
    const selected = z.enum(providerNames).optional().parse(c.req.query('provider')) || providers.find(p=>p.enabled)?.name || 'notion';
    return render(c,'连接测试','test',testPage(providers, selected));
  });
  const agentPrompt = async () => `请在当前 agent 产品中实现 Connany 连接功能，先检查现有用户认证、后端路由和工具执行器，再按下方协议完成实现和验证。
服务地址：${base()}
环境变量：CONNANY_BASE_URL=${base()}；CONNANY_API_KEY 由管理员单独配置到后端，不要询问或输出密钥值。
${new URL(base()).hostname === 'localhost' || new URL(base()).hostname === '127.0.0.1' ? '注意：当前是本地服务地址，仅运行在同一台机器上的后端可直接使用。远程部署需换成可访问的 HTTPS 服务地址，并同步配置平台 OAuth callback。' : ''}
实现连接按钮、授权状态查询、账号/工作区选择、动态工具调用、重连与断开。用户 ID 来自服务端登录会话，工具执行器固定用户和连接归属。return_url 可省略，每次创建会话时由后端传入：HTTPS、本机 HTTP（任意端口）或应用自定义协议（如 myapp://callback）。不要把管理员页面当成无需登录的 API 文档地址。
验收时覆盖用户和 API Key 接入空间隔离、取消授权、过期、断开及错误反馈。优先使用 SDK createAgentTools 给模型注册 discover_actions 和 execute_action 两个工具；通过动态目录获取参数与读写标记。写操作由后端按产品策略启用，勿让模型指定用户或连接。当前是 HTTP API，不是 MCP 端点。

` + (await readFile('docs/agent-integration.md','utf8')).replaceAll('https://connect.your-domain.com',base());
  app.get('/guide', async c => render(c,'接入说明','guide',guidePage(base(),await agentPrompt())));
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
