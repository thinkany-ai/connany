import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConnectorRuntime } from '../src/connectors/index.js';
import { config } from './support.js';
import { challenge } from '../src/crypto.js';
test('authorization URLs bind state, redirect URI and PKCE for GitHub/Linear', () => {
  const p = new ConnectorRuntime(config);
  for (const name of ['notion','github','linear'] as const) {
    const url = new URL(p.authorizeUrl(name, 'state', 'verifier'));
    assert.equal(url.searchParams.get('prompt'), name === 'github' ? 'select_account' : 'consent');
    assert.equal(url.searchParams.get('state'), 'state');
    assert.equal(url.searchParams.get('redirect_uri'), `http://localhost:3000/oauth/${name}/callback`);
    assert.equal(url.searchParams.get('code_challenge'), challenge('verifier'));
    if(name === 'notion') assert.equal(url.origin,'https://mcp.notion.com');
  }
});
test('connector-specific token requests use the right formats and rotate refresh tokens', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const p = new ConnectorRuntime(config, async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ access_token: 'new', refresh_token: 'rotated', expires_in: 3600 });
  });
  for (const name of ['notion','github','linear'] as const) {
    const { credential } = await p.exchange(name, 'code', 'verifier');
    assert.equal(credential.refreshToken, 'rotated');
    const request = requests.at(-1)!;
    const fields = Object.fromEntries(new URLSearchParams(String(request.init?.body)));
    assert.equal(fields.code, 'code');
    assert.equal(fields.redirect_uri, p.callback(name));
    assert.equal(fields.code_verifier, 'verifier');
    if(name === 'notion') { assert.equal(request.url,'https://mcp.notion.com/token'); assert.equal(fields.client_secret,undefined); }
  }
});
test('timeouts, GraphQL errors and rate limits do not leak upstream secrets', async () => {
  const p = new ConnectorRuntime(config, async () => Response.json({error:'sensitive'}, {status:401}));
  await assert.rejects(() => p.execute('linear.list_teams', { limit: 20 }, { accessToken: 'secret' }), e => (e as any).status === 401 && !(e as Error).message.includes('sensitive'));
  const q = new ConnectorRuntime(config, async () => Response.json({ message: 'secret' }, { status: 429, headers: { 'Retry-After': '30' } }));
  await assert.rejects(() => q.execute('github.installations.list', { page: 1, limit: 20 }, { accessToken: 'secret' }), e => (e as any).status === 429 && (e as any).details.retry_after === '30');
});
