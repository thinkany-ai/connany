import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {serve} from '@hono/node-server';
import pg from 'pg';
import {randomBytes} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {config,connectorClients} from '../support.js';
import {createApp} from '../../src/app.js';
import {Service} from '../../src/service.js';
import {ConnectorRuntime} from '../../src/connectors/index.js';
import {Vault} from '../../src/crypto.js';
import {createAdmin} from '../../src/admin/auth.js';
import {migrate} from '../../src/db.js';
import {Connany} from '../../sdk/client.js';

test('admin browser configures three shared connectors, creates two projects, rotates keys and disables a project', {timeout:60000}, async()=>{
  if(!process.env.TEST_DATABASE_URL)throw new Error('TEST_DATABASE_URL is required');
  const schema=`admin_browser_${randomBytes(8).toString('hex')}`;
  const owner=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
  const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${schema}`});
  const settings={...config,connectors:connectorClients()};
  // Minimal hosted MCP: handshake plus an empty tool list for discovery.
  const mcp=(init?:RequestInit)=>{const body=JSON.parse(String(init?.body));if(!('id' in body))return new Response(null,{status:202});return Response.json({jsonrpc:'2.0',id:body.id,result:body.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}}}:body.method==='tools/list'?{tools:[]}:{}});};
  const fake:typeof fetch=async(url,init)=>String(url).endsWith('/mcp')?mcp(init):String(url).endsWith('/register')?Response.json({client_id:'registered-client'}):String(url)==='https://mcp.notion.com/token'?Response.json({access_token:'token',refresh_token:'refresh',user_id:'alice',workspace_id:'workspace'}):String(url).endsWith('/oauth/token')?Response.json({access_token:'token',refresh_token:'refresh',workspace_id:'workspace',workspace_name:'Design workspace',bot_id:'bot',owner:{user:{id:'alice',name:'Alice'}}}):Response.json({results:[]});
  const service=new Service(pool,new ConnectorRuntime(settings,fake),new Vault(config.encryptionKey));
  // ConnectorStore derives ConnectorRuntime instances, so override the shared prototype only in this test process.
  const originalAuthorize=ConnectorRuntime.prototype.authorizeUrl;
  ConnectorRuntime.prototype.authorizeUrl=function(...args){const url=new URL(originalAuthorize.apply(this,args));return `${settings.publicBaseUrl}/mock-authorize${url.search}`;};
  const app=createApp(service);
  app.get('/mock-authorize',c=>{const callback=new URL(c.req.query('redirect_uri')!);callback.searchParams.set('state',c.req.query('state')!);callback.searchParams.set('code','test-code');return c.html(`<a href="${callback.toString().replaceAll('&','&amp;')}">Approve</a>`);});
  const server=serve({fetch:app.fetch,hostname:'127.0.0.1',port:0});
  await new Promise<void>(resolve=>server.listening?resolve():server.once('listening',()=>resolve()));
  const address=server.address();assert(address&&typeof address!=='string');settings.publicBaseUrl=`http://127.0.0.1:${address.port}`;
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    await owner.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await createAdmin(pool,'owner@example.com','browser-admin-password-123');
    browser=await chromium.launch({...process.env.PLAYWRIGHT_CHANNEL?{channel:process.env.PLAYWRIGHT_CHANNEL}:{}});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(10000);
    const browserErrors:string[]=[];page.on('pageerror',e=>browserErrors.push(e.message));page.on('dialog',dialog=>dialog.accept());
    // These selectors exercise the Chinese UI; the product defaults to English.
    await page.addInitScript(() => localStorage.setItem('connany.language', 'zh-CN'));
    await mkdir('artifacts',{recursive:true});
    await page.goto(`${settings.publicBaseUrl}/admin`);assert(page.url().endsWith('/admin/login'));
    await page.screenshot({path:'artifacts/admin-login.png',fullPage:true});
    await page.getByLabel('邮箱',{exact:true}).fill('owner@example.com');await page.getByLabel('密码',{exact:true}).fill('browser-admin-password-123');
    await Promise.all([page.waitForURL(`${settings.publicBaseUrl}/admin`),page.getByRole('button',{name:'进入工作台'}).click()]);
    await page.getByRole('heading',{name:'连接，从这里开始。'}).waitFor();
    await page.goto(`${settings.publicBaseUrl}/admin/connectors`);
    for(const [connector,label] of [['notion','Notion'],['linear','Linear']]){
      const card=page.locator(`#card-${connector}`);
      await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),card.getByRole('button',{name:'启用',exact:true}).click()]);
      await page.getByText(`${label} 已启用`,{exact:true}).waitFor();
      await page.locator(`#card-${connector}`).getByText('已启用',{exact:true}).waitFor();
    }
    await page.goto(`${settings.publicBaseUrl}/admin/connectors/github`);
    const github=page.getByRole('dialog',{name:'GitHub'});await github.waitFor();assert(page.url().endsWith('/admin/connectors#connector-github'));
    assert.equal(await github.getByLabel('回调地址').inputValue(),`${settings.publicBaseUrl}/oauth/github/callback`);
    await github.getByLabel('Client ID',{exact:true}).fill('github-shared-app');
    await github.getByLabel('Client Secret').fill('github-private-secret');
    await github.getByLabel('App slug').fill('connany-test');
    await page.screenshot({path:'artifacts/admin-connector-github.png'});
    await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),github.getByRole('button',{name:'保存'}).click()]);
    await page.getByText('已保存',{exact:true}).waitFor();
    await page.locator('#card-github').getByText('已启用',{exact:true}).waitFor();
    assert(!(await page.content()).includes('github-private-secret'));
    await page.screenshot({path:'artifacts/admin-connectors.png'});
    for(const [action,status] of [['暂停','已暂停'],['启用','已启用']]){
      await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.locator('#card-github').getByRole('button',{name:action,exact:true}).click()]);
      await page.locator('#card-github').getByText(status,{exact:true}).waitFor();
    }
    const issued:string[]=[];
    for(const name of ['Research Agent','Coding Agent']){
      await page.goto(`${settings.publicBaseUrl}/admin/projects`);await page.getByRole('button',{name:'创建项目',exact:true}).click();
      const create=page.getByRole('dialog',{name:'创建项目'});
      await create.getByLabel('名称',{exact:true}).fill(name);
      await create.getByRole('button',{name:'创建',exact:true}).click();await page.locator('#issued-key').waitFor();
      const key=await page.locator('#issued-key').inputValue();assert(key.startsWith('cn_live_'));issued.push(key);
      await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.getByRole('button',{name:'我已保存'}).click()]);
      assert.match(page.url(),/\/admin\/projects\/proj_/);assert(!(await page.content()).includes(key));
    }
    const project=(name:string)=>page.locator('tr',{hasText:name}).getByRole('link',{name:'管理'});
    await page.getByRole('button',{name:'重命名'}).click();
    const edit=page.getByRole('dialog',{name:'Coding Agent'});await edit.getByLabel('名称').fill('Coding Agent Prod');
    await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),edit.getByRole('button',{name:'保存'}).click()]);
    await page.getByRole('heading',{name:'Coding Agent Prod'}).waitFor();
    await page.screenshot({path:'artifacts/admin-project.png',fullPage:true});
    const first=new Connany({baseUrl:settings.publicBaseUrl,apiKey:issued[0]});const second=new Connany({baseUrl:settings.publicBaseUrl,apiKey:issued[1]});
    assert.equal((await first.connectors()).data.length,3);assert.equal((await second.connectors()).data.length,3);
    // Use a key issued by the UI to finish a user OAuth flow, not just a CRUD-only dashboard test.
    await page.goto(`${settings.publicBaseUrl}/admin/test?connector=notion`);
    await page.locator('#test-key').fill('invalid-key');
    await page.getByRole('button',{name:'1. 创建授权链接',exact:true}).click();
    await page.getByText(/unauthorized: A valid project API key/).waitFor();
    assert.equal(await page.locator('#test-open').isVisible(),false);
    await page.locator('#test-key').fill(issued[0]);
    await page.getByLabel('测试用户 ID').fill('alice-test');
    await page.getByRole('button',{name:'1. 创建授权链接',exact:true}).click();
    await page.locator('#test-open').waitFor();
    const [oauth]=await Promise.all([page.waitForEvent('popup'),page.locator('#test-open').click()]);
    await oauth.getByRole('link',{name:'Approve',exact:true}).click();
    await oauth.getByRole('heading',{name:'账号已连接'}).waitFor();await oauth.close();
    await page.getByRole('button',{name:'3. 检查授权结果'}).click();
    await page.getByText('授权成功，可以试读数据。',{exact:true}).waitFor();
    const finished=JSON.parse(await page.locator('#test-result').innerText());
    await assert.rejects(()=>second.getConnection(finished.connection_id,'alice-test'));
    await page.getByRole('button',{name:'4. 试读数据'}).click();
    await page.getByText('读取成功。空列表表示当前授权范围内没有可见数据。',{exact:true}).waitFor();
    const browserStorage=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage}}));
    assert(!browserStorage.includes(issued[0]));
    await page.getByLabel('测试用户 ID').fill('different-user');
    assert.equal(await page.locator('#test-read').isDisabled(),true);
    await page.reload();assert.equal(await page.locator('#test-key').inputValue(),'');
    await page.screenshot({path:'artifacts/admin-test.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.goto(`${settings.publicBaseUrl}/admin/guide`);
    const prompt=await page.locator('#agent-prompt').inputValue();
    assert(prompt.includes(settings.publicBaseUrl));assert(prompt.includes('/v1/connections/{id}/tools'));assert(!prompt.includes(issued[0]));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(`${settings.publicBaseUrl}/admin`);await page.screenshot({path:'artifacts/admin-overview.png',fullPage:true});
    await page.goto(`${settings.publicBaseUrl}/admin/connectors`);await page.screenshot({path:'artifacts/admin-connectors.png',fullPage:true});
    await page.goto(`${settings.publicBaseUrl}/admin/projects`);await page.screenshot({path:'artifacts/admin-projects.png',fullPage:true});
    await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),project('Research Agent').click()]);
    await page.getByRole('button',{name:'新建 API Key'}).click();
    const newKey=page.getByRole('dialog',{name:'新建 API Key'});await newKey.getByLabel('备注名（可选）').fill('production');
    await newKey.getByRole('button',{name:'创建',exact:true}).click();await page.locator('#issued-key').waitFor();
    const rotatedKey=await page.locator('#issued-key').inputValue();assert.notEqual(rotatedKey,issued[0]);
    await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.getByRole('button',{name:'我已保存'}).click()]);
    const rotated=new Connany({baseUrl:settings.publicBaseUrl,apiKey:rotatedKey});
    // Both keys work until the old one is revoked; the key limit hides the create button.
    assert.equal((await first.connectors()).data.length,3);assert.equal((await rotated.connectors()).data.length,3);
    assert.equal(await page.getByRole('button',{name:'新建 API Key'}).count(),0);
    await page.locator('tr',{hasText:issued[0].slice(0,16)}).getByRole('button',{name:'吊销'}).click();
    await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.locator('#confirm-ok').click()]);
    await page.locator('tr',{hasText:issued[0].slice(0,16)}).getByText('已吊销').waitFor();
    await assert.rejects(()=>first.connectors());assert.equal((await rotated.connectors()).data.length,3);
    await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),(async()=>{await page.getByRole('button',{name:'停用',exact:true}).click();await page.getByRole('dialog',{name:/停用 Research Agent/}).waitFor();await page.locator('#confirm-ok').click();})()]);
    await assert.rejects(()=>rotated.connectors());assert.equal((await second.connectors()).data.length,3);
    await page.goto(`${settings.publicBaseUrl}/admin/keys`);assert(page.url().endsWith('/admin/projects'));await page.locator('tr',{hasText:'Research Agent'}).getByText('已停用').waitFor();
    await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),project('Coding Agent Prod').click()]);
    await page.getByRole('button',{name:'删除项目'}).click();
    const confirm=page.getByRole('dialog',{name:'删除 Coding Agent Prod？'});await confirm.waitFor();
    await page.screenshot({path:'artifacts/admin-confirm.png'});
    await confirm.getByRole('button',{name:'取消'}).click();assert.equal((await second.connectors()).data.length,3);
    await page.getByRole('button',{name:'删除项目'}).click();
    await Promise.all([page.waitForURL(/\/admin\/projects$/),page.locator('#confirm-ok').click()]);
    assert.equal(await page.locator('tr',{hasText:'Coding Agent Prod'}).count(),0);await assert.rejects(()=>second.connectors());
    await page.setViewportSize({width:390,height:844});await page.goto(`${settings.publicBaseUrl}/admin`);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.screenshot({path:'artifacts/admin-mobile.png',fullPage:true});
    await page.locator('.account-menu summary').click();await page.getByRole('button',{name:'退出登录'}).click();await page.waitForURL(/\/admin\/login$/);
    assert.deepEqual(browserErrors,[]);
  } finally {
    ConnectorRuntime.prototype.authorizeUrl=originalAuthorize;
    await browser?.close();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
    await pool.end();await owner.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await owner.end();
  }
});
