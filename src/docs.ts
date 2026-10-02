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
export async function apiMarkdown(base:string, language = 'en') { return (await readFile(language==='zh-CN'?'docs/api.md':'docs/api.en.md','utf8')).replaceAll('{{BASE_URL}}',base); }
export async function docsPage(base:string, language = 'en') {
  const zh = language==='zh-CN';
  const {nav,html}=renderDocs(await apiMarkdown(base,language),language);
  return `<!doctype html><html lang="${zh?'zh-CN':'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>API Docs · Connany</title>${faviconLink}<link rel="stylesheet" href="/docs/assets/docs.css"><script src="/docs/assets/docs.js" defer></script></head><body><header class="docs-header"><a class="docs-brand" href="/">${brandMark}connany <span>Docs</span></a><div><select id="docs-language" aria-label="Language"><option value="en" ${zh?'':'selected'}>English</option><option value="zh-CN" ${zh?'selected':''}>简体中文</option></select><a href="/docs/api.md?lang=${zh?'zh-CN':'en'}">Markdown</a><a href="/docs/sdk.ts">TypeScript SDK</a><a href="/admin">${zh?'控制台 ↗':'Console ↗'}</a></div></header><div class="docs-layout"><nav aria-label="${zh?'文档目录':'Documentation sections'}">${nav.map(n=>`<a href="#${n.id}">${escape(n.title)}</a>`).join('')}</nav><main><div class="docs-intro"><span>DEVELOPER DOCUMENTATION</span><h1>API Docs</h1><p>${zh?'授权、连接管理与工具调用。一次接入，连接用户的工作账号。':'Authorization, connection management and tool execution. Connect user accounts through one integration.'}</p><code>${escape(base)}</code></div>${html}</main></div><div id="copy-status" role="status" aria-live="polite"></div></body></html>`;
}
