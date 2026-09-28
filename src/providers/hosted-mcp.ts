import { AppError, ProviderError } from '../errors.js';
import type { Credentials, Fetcher } from './index.js';
import { provider as definition, type ProviderName } from './catalog.js';

export class HostedMcp {
  constructor(private fetcher: Fetcher = fetch, private provider: ProviderName = 'notion') {}
  private get spec() { return definition(this.provider).mcp; }
  private get origin() { return this.spec.origin; }
  private get endpoint() { return this.spec.endpoint || '/mcp'; }
  /** RFC 8707 resource indicator, when the provider requires one. */
  get resource() { return this.spec.resource ? this.origin + this.endpoint : undefined; }
  private assertRegistrable() { if (definition(this.provider).auth !== 'mcp') throw new AppError('github_app_required','Configure a GitHub App for OAuth.'); }
  private async request(path: string, init: RequestInit) {
    let response: Response;
    try { response = await this.fetcher(this.origin + path, { ...init, redirect: 'error', signal: AbortSignal.timeout(45000) }); }
    catch { throw new ProviderError('provider_unavailable'); }
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as any;
      throw new ProviderError(body.error === 'invalid_grant' ? 'reauth_required' : 'provider_error', response.status === 401 || body.error === 'invalid_grant' ? 401 : response.status === 429 ? 429 : 502);
    }
    return response;
  }
  async register(callback: string) {
    this.assertRegistrable();
    const response = await this.request('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({client_name:'Connany',client_uri:new URL(callback).origin,redirect_uris:[callback],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'}) });
    const result = await response.json() as any;
    if (typeof result.client_id !== 'string' || !result.client_id) throw new ProviderError('invalid_client_registration');
    return result.client_id as string;
  }
  async token(clientId: string, fields: Record<string,string>) {
    this.assertRegistrable();
    return (await this.request('/token', {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...fields,client_id:clientId,...(this.resource?{resource:this.resource}:{})})})).json();
  }
  async revoke(clientId: string, credential: Credentials) {
    this.assertRegistrable();
    await this.request('/token', {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,token:credential.refreshToken || credential.accessToken,token_type_hint:credential.refreshToken?'refresh_token':'access_token'})});
  }
  private async session(credential: Credentials) {
    let sessionId: string | null = null;
    let protocol = '2025-03-26';
    let sequence = 0;
    const rpc = async (method: string, params: unknown, notification = false): Promise<any> => {
      const id = ++sequence;
      const response = await this.request(this.endpoint, {method:'POST',headers:{Authorization:`Bearer ${credential.accessToken}`,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':protocol,...(sessionId?{'Mcp-Session-Id':sessionId}:{})},body:JSON.stringify({jsonrpc:'2.0',...(notification?{}:{id}),method,params})});
      sessionId = response.headers.get('mcp-session-id') || sessionId;
      if (notification) { await response.body?.cancel(); return; }
      // The server can keep an SSE response open. Stop reading at this RPC's response.
      const reader = response.body?.getReader();
      if (!reader) throw new ProviderError('invalid_mcp_response');
      const decoder = new TextDecoder(); let buffer = ''; let size = 0;
      const sse = response.headers.get('content-type')?.includes('text/event-stream');
      const unwrap = (value: any) => {
        if (value.id !== id || value.jsonrpc !== '2.0') throw new ProviderError('invalid_mcp_response');
        if (value.error) throw new ProviderError('mcp_protocol_error');
        if (!value.result) throw new ProviderError('invalid_mcp_response');
        return value.result;
      };
      try {
        while (true) {
          const {value,done} = await reader.read();
          if (value) { size += value.length; if(size>4*1024*1024) throw new ProviderError('mcp_response_too_large'); buffer += decoder.decode(value,{stream:true}); }
          if (sse) {
            buffer = buffer.replace(/\r\n/g,'\n');
            let end: number;
            while ((end=buffer.indexOf('\n\n'))>=0) {
              const event=buffer.slice(0,end);buffer=buffer.slice(end+2);
              const data=event.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');
              if(data) { const message=JSON.parse(data);if(message.id===id)return unwrap(message); }
            }
          }
          if(done) { if(!sse)return unwrap(JSON.parse(buffer));throw new ProviderError('invalid_mcp_response'); }
        }
      } catch(error) {
        if(error instanceof AppError) throw error;
        throw new ProviderError('invalid_mcp_response');
      } finally { await reader.cancel().catch(()=>{}); }
    };
    const initialized=await rpc('initialize',{protocolVersion:protocol,capabilities:{},clientInfo:{name:'connany',version:'0.1.0'}});
    if (!['2024-11-05','2025-03-26','2025-06-18'].includes(initialized.protocolVersion)) throw new ProviderError('unsupported_mcp_version');
    protocol=initialized.protocolVersion;
    await rpc('notifications/initialized',{},true);
    return rpc;
  }
  async tools(credential: Credentials) {
    const rpc=await this.session(credential);const tools:any[]=[];let cursor:string|undefined;
    const seen=new Set<string>();
    do {
      const result=await rpc('tools/list',cursor?{cursor}:{});
      if(!Array.isArray(result.tools))throw new ProviderError('invalid_mcp_tools');
      tools.push(...result.tools);
      cursor=result.nextCursor;
      if(cursor && (seen.has(cursor)||seen.size>=20))throw new ProviderError('invalid_mcp_pagination');
      if(cursor)seen.add(cursor);
    }while(cursor);
    return tools.filter(t=>typeof t.name==='string' && /^[a-zA-Z0-9_-]{1,128}$/.test(t.name) && t.inputSchema?.type==='object').map(t=>({name:`${this.provider}.${t.name}`,provider:this.provider,description:String(t.description||t.name),read_only:t.annotations?.readOnlyHint===true,required_permissions:[`${definition(this.provider).label} MCP: current user access`],input_schema:t.inputSchema}));
  }
  /** Call a tool by its upstream name without catalog lookup. Returns the raw MCP result. */
  async callTool(tool: string, args: unknown, credential: Credentials) {
    const rpc=await this.session(credential);
    return rpc('tools/call',{name:tool,arguments:args});
  }
  async call(name: string, input: unknown, credential: Credentials) {
    if (!(await this.tools(credential)).some(t=>t.name===name)) throw new AppError('action_not_found','Discover available MCP tools before calling.');
    const rpc=await this.session(credential);
    const result=await rpc('tools/call',{name:name.slice(this.provider.length + 1),arguments:input});
    if(result.isError)throw new AppError('mcp_tool_error','The MCP provider could not complete this tool call.',422,{result});
    return result;
  }
}
