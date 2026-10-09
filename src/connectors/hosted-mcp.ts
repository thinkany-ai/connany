import { AppError, UpstreamError } from '../errors.js';
import type { Credentials, Fetcher } from './index.js';
import { connector as definition, type AnyConnector, type ClientAuthMethod } from './catalog.js';

export interface McpClient { clientId: string; clientSecret: string; authMethod: ClientAuthMethod }

export class HostedMcp {
  constructor(private fetcher: Fetcher = fetch, private connector: AnyConnector = 'notion') {}
  private get spec() { return definition(this.connector).mcp!; }
  private get origin() { return this.spec.origin; }
  private get endpoint() { return this.spec.endpoint || '/mcp'; }
  /** OAuth endpoint: explicit from the catalog, or the legacy origin + path layout. */
  oauthUrl(kind: 'authorize' | 'token' | 'register' | 'revoke' | 'userinfo'): string | undefined {
    if (this.spec.oauth) return this.spec.oauth[kind];
    const legacy: Record<string, string> = { authorize: '/authorize', token: '/token', register: '/register', revoke: '/token' };
    return legacy[kind] ? this.origin + legacy[kind] : undefined;
  }
  /** RFC 8707 resource indicator, when the connector requires one. */
  get resource() { return typeof this.spec.resource === 'string' ? this.spec.resource : this.spec.resource ? this.origin + this.endpoint : undefined; }
  private assertRegistrable() { if (definition(this.connector).auth !== 'mcp') throw new AppError('oauth_client_required','Configure an OAuth client for this connector.'); }
  private async request(path: string, init: RequestInit) {
    let response: Response;
    try { response = await this.fetcher(/^https:\/\//.test(path) ? path : this.origin + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(45000) }); }
    catch { throw new UpstreamError('upstream_unavailable'); }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as any;
      // OAuth error fields help administrators diagnose registration problems; they carry no secrets.
      const describe = (value: unknown) => typeof value === 'string' ? value.slice(0, 300) : undefined;
      throw new UpstreamError(body.error === 'invalid_grant' ? 'reauth_required' : 'upstream_error', response.status === 401 || body.error === 'invalid_grant' ? 401 : response.status === 429 ? 429 : 502,
        { upstream_status: response.status, ...(describe(body.error) ? { upstream_error: describe(body.error) } : {}), ...(describe(body.error_description) ? { upstream_error_description: describe(body.error_description) } : {}) });
    }
    return response;
  }
  /** RFC 7591 dynamic client registration. Servers without public clients return a secret to keep;
   *  a server may also grant a public client (`none`) even when a secret was requested. */
  async register(callback: string): Promise<McpClient> {
    this.assertRegistrable();
    const method = this.spec.clientAuth || 'none';
    const response = await this.request(this.oauthUrl('register')!, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({client_name:'Connany',client_uri:new URL(callback).origin,redirect_uris:[callback],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:method,...(this.spec.scope?{scope:this.spec.scope}:{})}) });
    const result = await response.json() as any;
    if (typeof result.client_id !== 'string' || !result.client_id) throw new UpstreamError('invalid_client_registration');
    const secret = typeof result.client_secret === 'string' ? result.client_secret : '';
    const granted = result.token_endpoint_auth_method;
    if (method !== 'none' && !secret && granted !== 'none') throw new UpstreamError('invalid_client_registration');
    return { clientId: result.client_id, clientSecret: secret, authMethod: secret ? (granted === 'client_secret_basic' || granted === 'client_secret_post' ? granted : method === 'none' ? 'client_secret_post' : method) : 'none' };
  }
  /** Token endpoint request with the client authentication chosen at registration. */
  private clientRequest(url: string, client: McpClient, fields: Record<string,string>) {
    const headers: Record<string,string> = {'Content-Type':'application/x-www-form-urlencoded',Accept:'application/json'};
    const body = new URLSearchParams(fields);
    if (client.authMethod === 'client_secret_basic') headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString('base64')}`;
    else { body.set('client_id', client.clientId); if (client.authMethod === 'client_secret_post') body.set('client_secret', client.clientSecret); }
    return this.request(url, {method:'POST',headers,body});
  }
  async token(client: McpClient, fields: Record<string,string>) {
    this.assertRegistrable();
    return (await this.clientRequest(this.oauthUrl('token')!, client, {...fields,...(this.resource?{resource:this.resource}:{})})).json();
  }
  async revoke(client: McpClient, credential: Credentials) {
    this.assertRegistrable();
    const url = this.oauthUrl('revoke');
    // Servers without a revocation endpoint only lose the local credential, and so do public
    // clients where the server wants a confidential one (it rejects their revocations).
    if (!url || (client.authMethod === 'none' && this.spec.clientAuth)) return;
    await this.clientRequest(url, client, {token:credential.refreshToken || credential.accessToken,token_type_hint:credential.refreshToken?'refresh_token':'access_token'});
  }
  /** OIDC userinfo, when the authorization server offers it. Used only to name the account. */
  async userinfo(credential: Credentials): Promise<Record<string, unknown> | undefined> {
    const url = this.oauthUrl('userinfo');
    if (!url) return undefined;
    return (await this.request(url, {method:'GET',headers:{Authorization:`Bearer ${credential.accessToken}`,Accept:'application/json'}})).json() as Promise<Record<string, unknown>>;
  }
  private async session(credential: Credentials) {
    let sessionId: string | null = null;
    let protocol = '2025-03-26';
    let sequence = 0;
    const rpc = async (method: string, params: unknown, notification = false, limit = 4*1024*1024): Promise<any> => {
      const id = ++sequence;
      const response = await this.request(this.endpoint, {method:'POST',headers:{...this.spec.headers,Authorization:`Bearer ${credential.accessToken}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':protocol,...(sessionId?{'Mcp-Session-Id':sessionId}:{})},body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,params})});
      sessionId = response.headers.get('mcp-session-id') || sessionId;
      if (notification) { await response.body?.cancel(); return; }
      // The server can keep an SSE response open. Stop reading at this RPC's response.
      const reader = response.body?.getReader();
      if (!reader) throw new UpstreamError('invalid_mcp_response');
      const decoder = new TextDecoder(); let buffer = ''; let size = 0;
      const sse = response.headers.get('content-type')?.includes('text/event-stream');
      const unwrap = (value: any) => {
        if (value.id !== id || value.jsonrpc !== '2.0') throw new UpstreamError('invalid_mcp_response');
        if (value.error) throw new UpstreamError('mcp_protocol_error');
        if (!value.result) throw new UpstreamError('invalid_mcp_response');
        return value.result;
      };
      try {
        while (true) {
          const {value,done} = await reader.read();
          if (value) { size += value.length; if(size>limit) throw new UpstreamError('mcp_response_too_large'); buffer += decoder.decode(value,{stream:true}); }
          if (sse) {
            buffer = buffer.replace(/\r\n/g,'\n');
            let end: number;
            while ((end=buffer.indexOf('\n\n'))>=0) {
              const event=buffer.slice(0,end);buffer=buffer.slice(end+2);
              const data=event.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
              if(data) { const message=JSON.parse(data);if(message.id===id)return unwrap(message); }
            }
          }
          if(done) { if(!sse)return unwrap(JSON.parse(buffer));throw new UpstreamError('invalid_mcp_response'); }
        }
      } catch(error) {
        if(error instanceof AppError) throw error;
        throw new UpstreamError('invalid_mcp_response');
      } finally { await reader.cancel().catch(()=>{}); }
    };
    const initialized=await rpc('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'connany',version:'0.1.0'}});
    if (!['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(initialized.protocolVersion)) throw new UpstreamError('unsupported_mcp_version');
    protocol=initialized.protocolVersion;
    await rpc('notifications/initialized',{},true);
    return rpc;
  }
  async tools(credential: Credentials) {
    const rpc=await this.session(credential);const tools:any[]=[];let cursor:string|undefined;
    const seen=new Set<string>();
    do {
      // Large servers (PostHog lists ~750 tools, ~5 MB) send the whole catalog in one page.
      const result=await rpc('tools/list',cursor?{cursor}:{},false,16*1024*1024);
      if(!Array.isArray(result.tools))throw new UpstreamError('invalid_mcp_tools');
      tools.push(...result.tools);
      cursor=result.nextCursor;
      if(cursor && (seen.has(cursor)||seen.size>=20))throw new UpstreamError('invalid_mcp_pagination');
      if(cursor)seen.add(cursor);
    }while(cursor);
    return tools.filter(t=>typeof t.name==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(t.name) && t.inputSchema?.type==='object').map(t=>({name:`${this.connector}.${t.name}`,connector:this.connector,description:String(t.description||t.name),read_only:t.annotations?.readOnlyHint===true,required_permissions:[`${definition(this.connector).label} MCP: current user access`],input_schema:t.inputSchema}));
  }
  /** Call a tool by its upstream name without catalog lookup. Returns the raw MCP result. */
  async callTool(tool: string, args: unknown, credential: Credentials) {
    const rpc=await this.session(credential);
    return rpc('tools/call',{name:tool,arguments:args});
  }
  async call(name: string, input: unknown, credential: Credentials, known = false) {
    if (!known && !(await this.tools(credential)).some(t=>t.name===name)) throw new AppError('tool_not_found','List available tools before calling.');
    const rpc=await this.session(credential);
    const result=await rpc('tools/call',{name:name.slice(this.connector.length + 1),arguments:input});
    if(result.isError)throw new AppError('mcp_tool_error','The MCP server could not complete this tool call.',422,{result});
    return result;
  }
}
