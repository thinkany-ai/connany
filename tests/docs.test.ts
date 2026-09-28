import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createApp} from '../src/app.js';
import {renderDocs} from '../src/docs.js';
import type {Service} from '../src/service.js';

test('public docs and downloads work without authentication or provider initialization',async()=>{
 const app=createApp({providers:{config:{publicBaseUrl:'https://connect.example'}},initialize:async()=>{throw new Error('must not initialize');},authenticate:async()=>{throw new Error('must not authenticate');}} as unknown as Service);
 const page=await app.request('/docs');assert.equal(page.status,200);const html=await page.text();
 assert(html.includes('https://connect.example'));assert(!html.includes('{{BASE_URL}}'));assert(html.includes('aria-label="Documentation sections"'));assert(html.includes('data-copy-code'));
 assert(page.headers.get('Content-Security-Policy')?.includes("script-src 'self'"));
 for(const path of ['/docs/api.md','/docs/sdk.ts','/docs/assets/docs.css','/docs/assets/docs.js'])assert.equal((await app.request(path)).status,200);
 assert.equal((await app.request('/docs/')).headers.get('Location'),'/docs');
 const source=await readFile('src/app.ts','utf8');const markdown=await (await app.request('/docs/api.md')).text();
 for(const match of source.matchAll(/app\.(get|post|delete)\('(\/v1\/[^']+)'/g)) {
  const path=match[2].replace(/:id/g,'{id}');assert(markdown.includes(`${match[1].toUpperCase()} ${path}`),`Missing documentation for ${path}`);
 }
});

test('docs renderer escapes raw HTML and code, renders tables and stable section anchors',()=>{
 const result=renderDocs('# Title\n## Auth\n<script>alert(1)</script>\n```html\n<img src=x>\n```\n| Field | Type |\n| --- | --- |\n| `id` | string |\n## End\nDone');
 assert(!result.html.includes('<script>'));assert(!result.html.includes('<img'));assert(result.html.includes('&lt;img'));assert(result.html.includes('<table>'));assert.equal(result.nav.length,2);assert.equal(result.nav[1].id,'section-2');
});
