import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {layout,connectorList,projectList,projectDetail,connectionsPage,testPage,loginPage,overview,usersPage,signupPage,consentPage,consentErrorPage} from '../src/admin/pages.js';
import {docsPage,apiMarkdown} from '../src/docs.js';
import {toHongKong} from '../src/i18n.js';

async function languageRuntime(saved?:string) {
 const context:any={window:{},localStorage:{getItem:()=>saved},document:{documentElement:{},readyState:'loading',addEventListener(){}},WeakMap};
 vm.runInNewContext(await readFile('public/admin-i18n.js','utf8'),context);
 return {language:context.document.documentElement.lang,t:context.window.ConnanyI18n.translate};
}
test('language defaults to English, accepts Chinese preference and translates dynamic UI messages',async()=>{
 const {language,t}=await languageRuntime();assert.equal(language,'en');assert.equal((await languageRuntime('zh-CN')).language,'zh-CN');assert.equal((await languageRuntime('invalid')).language,'en');assert.equal((await languageRuntime('zh-HK')).language,'zh-HK');
 assert.equal(t('账户','en'),'Account');assert.equal(t('账户','zh-CN'),'账户');
 assert.equal(t('删除 我的 Agent？','en'),'Delete 我的 Agent?');
 assert.equal(t('key 立即失效，3 个用户连接将被断开并删除，无法恢复。','en'),'The key stops working immediately. 3 user connections will be disconnected and permanently deleted.');
 assert.equal(t('当前密码不正确。','en'),'The current password is incorrect.');
 assert.equal(t('user_private_name','en'),'user_private_name');
 assert.equal(t('账户','zh-HK'),'帳戶');assert.equal(t('停用','zh-HK'),'停用');assert.equal(t('删除 我的 Agent？','zh-HK'),'刪除 我的 Agent？');
 assert.equal(t('删除项目会吊销所有 API Key，断开并删除 3 个用户连接，无法恢复。','zh-HK'),'刪除項目會吊銷所有 API Key，斷開並刪除 3 個用戶連接，無法恢復。');
 assert.equal(t('创建 API Key ↗','zh-HK'),'建立 API Key ↗');assert.equal(t('API 文档 · Connany','zh-HK'),'API 文件 · Connany');
});
test('primary screens have English translations and user supplied key names opt out',async()=>{
 const {t}=await languageRuntime();
 const runtime=['notion','github','linear'].map(name=>({name,configured:true,enabled:true,client_id:'demo',has_secret:true,github_app_slug:'demo',callback_url:'https://example.com/callback',updated_at:null,tool_count:0,tools_synced_at:null})) as any;
 const project={id:'proj_a',name:'设置',enabled:true,connection_count:3,api_key_count:1};
 const keys=[{id:'key_a',name:'生产',key_prefix:'cn_live_demo',created_at:new Date(),last_used_at:null,revoked_at:null},{id:'key_b',name:'',key_prefix:'cn_live_old',created_at:new Date(),last_used_at:new Date(),revoked_at:new Date()}];
 const projectHtml=projectList([project],null)+projectDetail(project,keys);
 assert(projectHtml.includes('translate="no">设置</a>'));assert(projectHtml.includes('<strong translate="no">生产</strong>'));
 const html=layout('总览','overview','admin@example.com','',overview(runtime,{projects:1,active_projects:1,connections:3}))+connectorList(runtime)+projectList([],null)+projectHtml.replaceAll('translate="no">设置','translate="no">x').replaceAll('translate="no">生产','translate="no">x')+loginPage(true,'/admin/oauth2/authorize?x=1')+signupPage('/admin/oauth2/authorize?x=1')+consentPage({client_name:'x'},{client_id:'c',redirect_uri:'http://localhost:3000/callback'},'a@example.com','')+consentErrorPage('回调地址与客户端注册的不一致。')+layout('x','overview','a@example.com','','','member',[{id:'g',client_name:'x',created_at:new Date(),last_used_at:null}])+connectionsPage([],[{id:'proj_a',name:'x'}],'','',null)+usersPage([{id:'admin_a',email:'a@example.com',role:'admin',created_at:new Date(),last_login_at:null},{id:'admin_b',email:'b@example.com',role:'member',created_at:new Date(),last_login_at:new Date()}] as any,{id:'admin_a',email:'a@example.com',role:'admin',workspace_id:'ws_a'})+layout('x','users','a@example.com','','','admin')+testPage(runtime,'notion');
 const text=html.replace(/<(script|style|textarea|code)\b[^>]*>[\s\S]*?<\/\1>/g,'').replace(/<[^>]+>/g,'\n');
 const strings=[...new Set(text.split('\n').map(v=>v.trim()).filter(v=>/[\u4e00-\u9fff]/.test(v)&&!['简体中文','繁體中文（香港）'].includes(v)))];
 assert.deepEqual(strings.filter(v=>/[\u4e00-\u9fff]/.test(t(v,'en'))),[]);
 // zh-HK follows the same conversion as the server, so console and docs use the same Hong Kong wording.
 assert.deepEqual(strings.filter(v=>t(v,'zh-HK')!==toHongKong(v)),[]);
});
test('every console message has a zh-HK translation that matches the server conversion',async()=>{
 const {t}=await languageRuntime();
 const keys=[...(await readFile('public/admin-i18n.js','utf8')).matchAll(/'([^']*[\u4e00-\u9fff][^']*)':'/g)].map(m=>m[1]);
 assert(keys.length>300);assert.deepEqual(keys.filter(key=>t(key,'zh-HK')!==toHongKong(key)),[]);
});
test('public docs support matching English and Chinese API coverage',async()=>{
 const english=await docsPage('https://example.com');const chinese=await docsPage('https://example.com','zh-CN');
 assert(english.includes('<html lang="en">'));assert(english.includes('Quick start'));assert(chinese.includes('<html lang="zh-CN">'));assert(chinese.includes('快速开始'));
 const hongKong=await docsPage('https://example.com','zh-HK','mcp');assert(hongKong.includes('<html lang="zh-HK">'));assert(hongKong.includes('<option value="zh-HK" selected>'));assert(hongKong.includes('href="/docs/agent?lang=zh-HK"'));
 assert(!/[们这设账]/.test(hongKong));assert.equal((await docsPage('https://example.com','zh-TW')).match(/<html lang="([^"]+)">/)![1],'zh-HK');
 for(const target of ['en','zh-CN','zh-HK'])assert(english.includes(`hreflang="${target}"`));assert(english.includes('<link rel="alternate" hreflang="x-default" href="https://example.com/docs">'));
 for(const language of ['en','zh-CN','zh-HK']){
  const markdown=await apiMarkdown('https://example.com',language);
  const routes=await readFile('src/app.ts','utf8');
  for(const m of routes.matchAll(/app\.(get|post|delete)\('(\/v1\/[^']+)'/g))assert(markdown.includes(`${m[1].toUpperCase()} ${m[2].replace(/:(\w+)/g,'{$1}')}`));
 }
});
