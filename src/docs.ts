import {readFile} from 'node:fs/promises';
import {brandMark, faviconLink} from './brand.js';
const escape = (value:string) => value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Inline code, bold and http(s) links. Everything is escaped first; code spans are left unformatted. */
const inline = (value:string) => value.split(/(`[^`]+`)/).map(part => part.length > 1 && part.startsWith('`') && part.endsWith('`') ? `<code>${escape(part.slice(1,-1))}</code>` :
  escape(part).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,(_,text:string,url:string)=>/^https?:\/\//.test(url)?`<a href="${url}" target="_blank" rel="noopener noreferrer">${text}</a>`:text)).join('');
const listItem = /^(\s*)(?:[-*]|\d+\.)\s+(?:\[[ x]\]\s+)?(.*)$/;
const formatCode = (lang:string, code:string) => { if(lang!=='json')return code; try { return JSON.stringify(JSON.parse(code),null,2); } catch { return code; } };
/** Small, escaped renderer for the documented subset: headings, paragraphs, lists, tables and fences. */
export function renderDocs(markdown:string, language = 'en', idPrefix = 'section') {
  const lines=markdown.split('\n'); const nav:{id:string;title:string}[]=[];const html:string[]=[];
  let section=false;
  for(let i=0;i<lines.length;i++) {
    const line=lines[i];
    if(line.startsWith('# '))continue;
    if(line.startsWith('## ')) {
      if(section)html.push('</section>');section=true;
      const title=line.slice(3),id=`${idPrefix}-${nav.length+1}`;nav.push({id,title});
      html.push(`<section id="${id}" class="docs-section"><h2>${inline(title)}</h2>`);continue;
    }
    if(line.startsWith('```')) {
      const lang=line.slice(3); const code:string[]=[];
      while(++i<lines.length&&!lines[i].startsWith('```'))code.push(lines[i]);
      html.push(`<div class="docs-code"><div><span>${escape(lang)}</span><button type="button" data-copy-code>${language==='zh-CN'?'复制':'Copy'}</button></div><pre><code>${escape(formatCode(lang,code.join('\n')))}</code></pre></div>`);continue;
    }
    if(line.startsWith('### ')) { html.push(`<h3>${inline(line.slice(4))}</h3>`); continue; }
    if(listItem.test(line) && !line.startsWith('    ')) {
      const ordered=/^\s*\d+\./.test(line); const items:string[]=[];
      for(;i<lines.length&&listItem.test(lines[i])&&/^\s*\d+\./.test(lines[i])===ordered;i++) items.push(`<li>${inline(lines[i].match(listItem)![2])}</li>`);
      i--; html.push(`<${ordered?'ol':'ul'}>${items.join('')}</${ordered?'ol':'ul'}>`); continue;
    }
    if(line.startsWith('|')) {
      const rows:string[]=[];
      do { if(!/^\|[\s:|\-]+$/.test(lines[i]))rows.push(lines[i]);i++; } while(i<lines.length&&lines[i].startsWith('|'));
      i--;
      const cells=(row:string,tag:string)=>row.split('|').slice(1,-1).map(cell=>`<${tag}>${inline(cell.trim())}</${tag}>`).join('');
      html.push(`<div class="docs-table"><table><thead><tr>${cells(rows[0],'th')}</tr></thead><tbody>${rows.slice(1).map(row=>`<tr>${cells(row,'td')}</tr>`).join('')}</tbody></table></div>`);continue;
    }
    if(line.trim())html.push(`<p>${inline(line)}</p>`);
  }
  if(section)html.push('</section>');return {nav,html:html.join('')};
}
export type DocsPageName = 'api' | 'agent' | 'mcp';
const sources: Record<DocsPageName, { en?: string; 'zh-CN': string }> = {
  api: { en: 'docs/api.en.md', 'zh-CN': 'docs/api.md' },
  agent: { 'zh-CN': 'docs/agent-integration.md' },
  mcp: { en: 'docs/mcp.en.md', 'zh-CN': 'docs/mcp.md' },
};
/** A docs page as Markdown with this deployment's address. Links between docs point to the public pages. */
export async function docsMarkdown(page: DocsPageName, base: string, language = 'en') {
  const file = language === 'zh-CN' ? sources[page]['zh-CN'] : sources[page].en ?? sources[page]['zh-CN'];
  return (await readFile(file, 'utf8')).replaceAll('{{BASE_URL}}', base).replaceAll('https://connect.your-domain.com', base).replaceAll('https://connany.example.com', base)
    .replaceAll('](agent-integration.md)', `](${base}/docs/agent)`).replaceAll('](mcp.md)', `](${base}/docs/mcp)`).replaceAll('](api.md)', `](${base}/docs)`).replaceAll('](api.en.md)', `](${base}/docs)`);
}
export async function apiMarkdown(base: string, language = 'en') { return docsMarkdown('api', base, language); }
/** Hand-off for a coding agent building a product integration: instructions plus the full guide. */
export async function agentPrompt(base: string) {
  const local = ['localhost', '127.0.0.1'].includes(new URL(base).hostname);
  return `请在当前 agent 产品中实现 Connany 连接功能，先检查现有用户认证、后端路由和工具执行器，再按下方协议完成实现和验证。
服务地址：${base}
环境变量：CONNANY_BASE_URL=${base}；CONNANY_API_KEY 由管理员单独配置到后端，不要询问或输出密钥值。
${local ? '注意：当前是本地服务地址，仅运行在同一台机器上的后端可直接使用。远程部署需换成可访问的 HTTPS 服务地址，并同步配置平台 OAuth callback。' : ''}
需要实现：设置页的连接器列表与连接按钮、授权结果确认、已连接账号管理（检查、重新授权、断开、补充资源访问），以及对话中的工具调用：每轮对话按当前用户的有效连接注册工具，未连接时在对话中展示授权按钮，授权失效时引导重新连接。用户 ID 必须来自服务端登录会话，工具执行器固定用户和连接，模型只能填写工具参数。优先使用 SDK 的 createAgentTools；写操作由后端按产品策略开启并在执行前向用户确认。后台任务轮询 GET /v1/events 同步状态变化。产品集成使用 HTTP API（/v1）；/mcp 端点面向在 Claude Code 等客户端中使用 Connany 的个人用户，不用于产品集成。
按下方文档第 7 节的清单完成验收。

` + await docsMarkdown('agent', base, 'zh-CN');
}
const pages: Record<DocsPageName, { path: string; en: [string, string, string]; zh: [string, string, string] }> = {
  api: { path: '/docs', en: ['API', 'API Docs', 'Authorization, connection management and tool execution. Connect user accounts through one integration.'], zh: ['API 文档', 'API 文档', '授权、连接管理与工具调用。一次接入，连接用户的工作账号。'] },
  agent: { path: '/docs/agent', en: ['Agent integration', 'Agent integration guide', 'Build Connany into your agent product: authorization in the conversation, connected accounts and tool calls.'], zh: ['Agent 接入', 'Agent 接入指南', '在你的 agent 产品中接入 Connany：对话中引导授权、管理已连接账号、调用工具。'] },
  mcp: { path: '/docs/mcp', en: ['MCP & skill', 'MCP and skill', 'Use every connector with your own accounts from Claude Code, Codex, Cursor and other MCP clients.'], zh: ['MCP 与 Skill', 'MCP 与 Skill 接入', '在 Claude Code、Codex、Cursor 等客户端中，用你自己的账号使用所有连接器。'] },
};
/** Public documentation site: API reference, agent integration guide and MCP guide. No sign-in needed. */
export async function docsPage(base: string, language = 'en', page: DocsPageName = 'api') {
  const zh = language === 'zh-CN';
  const lang = (path: string) => zh ? `${path}?lang=zh-CN` : path;
  const [, title, intro] = zh ? pages[page].zh : pages[page].en;
  const {nav, html} = renderDocs(await docsMarkdown(page, base, language), language);
  const tabs = (Object.keys(pages) as DocsPageName[]).map(name => `<a href="${lang(pages[name].path)}" ${name === page ? 'aria-current="page"' : ''}>${(zh ? pages[name].zh : pages[name].en)[0]}</a>`).join('');
  const markdown = { api: '/docs/api.md', agent: '/docs/agent.md', mcp: '/docs/mcp.md' }[page];
  const actions = page === 'agent'
    ? `<button type="button" class="docs-button" data-copy-target="agent-prompt">${zh ? '复制给开发 Agent' : 'Copy for coding agent'}</button><textarea id="agent-prompt" hidden readonly>${escape(await agentPrompt(base))}</textarea>`
    : page === 'mcp' ? `<a class="docs-button" href="/skills/connany/SKILL.md">SKILL.md</a>` : '';
  const note = page === 'agent' && !zh ? '<p class="docs-note">This guide is currently available in Chinese.</p>' : '';
  return `<!doctype html><html lang="${zh?'zh-CN':'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Connany</title>${faviconLink}<link rel="stylesheet" href="/docs/assets/docs.css"><script src="/docs/assets/docs.js" defer></script></head><body><header class="docs-header"><a class="docs-brand" href="/docs">${brandMark}connany <span>Docs</span></a><div><select id="docs-language" aria-label="Language"><option value="en" ${zh?'':'selected'}>English</option><option value="zh-CN" ${zh?'selected':''}>简体中文</option></select><a href="${lang(markdown)}">Markdown</a><a href="/docs/sdk.ts">TypeScript SDK</a><a href="/admin">${zh?'控制台 ↗':'Console ↗'}</a></div></header><nav class="docs-tabs" aria-label="${zh?'文档':'Documentation'}">${tabs}</nav><div class="docs-layout"><nav aria-label="${zh?'文档目录':'Documentation sections'}">${nav.map(n=>`<a href="#${n.id}">${escape(n.title.replace(/`/g,''))}</a>`).join('')}</nav><main><div class="docs-intro"><span>DEVELOPER DOCUMENTATION</span><h1>${escape(title)}</h1><p>${escape(intro)}</p><div class="docs-intro-row"><code>${escape(page === 'mcp' ? `${base}/mcp` : base)}</code>${actions}</div>${note}</div>${html}</main></div><div id="copy-status" role="status" aria-live="polite"></div></body></html>`;
}
