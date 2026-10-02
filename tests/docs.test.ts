import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createApp} from '../src/app.js';
import {renderDocs} from '../src/docs.js';
import type {Service} from '../src/service.js';

test('public docs and downloads work without authentication or connector initialization',async()=>{
 const app=createApp({runtime:{config:{publicBaseUrl:'https://connect.example'}},initialize:async()=>{throw new Error('must not initialize');},authenticate:async()=>{throw new Error('must not authenticate');}} as unknown as Service);
 const page=await app.request('/docs');assert.equal(page.status,200);const html=await page.text();
 assert(html.includes('https://connect.example'));assert(!html.includes('{{BASE_URL}}'));assert(html.includes('aria-label="Documentation sections"'));assert(html.includes('data-copy-code'));
 assert(page.headers.get('Content-Security-Policy')?.includes("script-src 'self'"));
 for(const path of ['/docs/api.md','/docs/sdk.ts','/docs/assets/docs.css','/docs/assets/docs.js'])assert.equal((await app.request(path)).status,200);
 assert.equal((await app.request('/docs/')).headers.get('Location'),'/docs');
 const source=await readFile('src/app.ts','utf8');const markdown=await (await app.request('/docs/api.md')).text();
 for(const match of source.matchAll(/app\.(get|post|delete)\('(\/v1\/[^']+)'/g)) {
  const path=match[2].replace(/:(\w+)/g,'{$1}');assert(markdown.includes(`${match[1].toUpperCase()} ${path}`),`Missing documentation for ${path}`);
 }
});

test('docs renderer escapes raw HTML and code, renders tables and stable section anchors',()=>{
 const result=renderDocs('# Title\n## Auth\n<script>alert(1)</script>\n```html\n<img src=x>\n```\n| Field | Type |\n| --- | --- |\n| `id` | string |\n## End\nDone');
 assert(!result.html.includes('<script>'));assert(!result.html.includes('<img'));assert(result.html.includes('&lt;img'));assert(result.html.includes('<table>'));assert.equal(result.nav.length,2);assert.equal(result.nav[1].id,'section-2');
});

test('docs renderer supports lists, sub-headings, bold and only http(s) links, without formatting code spans',()=>{
 const {html}=renderDocs('## A\n### Sub\n- one **b**\n- [ ] two\n1. x\n2. y\nSee [site](https://a.example/?q=1&b=2), [rel](../sdk.ts), [bad](javascript:alert(1)) and `**raw** <i>`');
 assert(html.includes('<h3>Sub</h3>'));assert(html.includes('<ul><li>one <strong>b</strong></li><li>two</li></ul><ol><li>x</li><li>y</li></ol>'));
 assert(html.includes('<a href="https://a.example/?q=1&amp;b=2" target="_blank" rel="noopener noreferrer">site</a>'));
 assert(!html.includes('href="../sdk.ts"'));assert(!html.includes('javascript:'));assert(html.includes('<code>**raw** &lt;i&gt;</code>'));
});

test('the site root redirects to the admin console',async()=>{
 const app=createApp({runtime:{config:{publicBaseUrl:'https://connect.example'}},initialize:async()=>{}} as unknown as Service);
 const response=await app.request('/');
 assert.equal(response.status,302);assert.equal(response.headers.get('location'),'/admin');
});
