/** Server-side SDK. Do not bundle the project key into a browser, mobile app or LLM prompt. */
/** Groups connectors for display: collaboration, development, data, analytics, payments, design. */
export type ConnectorCategory = 'collaboration' | 'development' | 'data' | 'analytics' | 'payments' | 'design';
export type ConnectorName = 'notion' | 'github' | 'linear' | 'sentry' | 'posthog' | 'atlassian' | 'vercel' | 'supabase' | 'neon' | 'netlify' | 'gitlab' | 'cloudflare' | 'prisma' | 'stripe' | 'paypal' | 'square' | 'clickup' | 'monday' | 'airtable' | 'todoist' | 'miro' | 'canva' | 'intercom' | 'webflow' | 'wix' | 'google_search_console' | 'google_analytics';
export interface ConnectSession {
  id: string; connector: ConnectorName; status: 'pending' | 'authorizing' | 'processing' | 'connected' | 'error' | 'expired';
  expires_at: string; connect_url?: string; connection_id?: string | null; error_code?: string | null;
}
export interface Connection {
  id: string; external_user_id: string; connector: ConnectorName; status: 'connected' | 'reauth_required' | 'revoked';
  identity: { account_id: string; account_name: string; workspace_id?: string; workspace_name?: string; [key: string]: unknown };
  /** True when the user still needs to grant resource access (see listAccess). */
  needs_access: boolean;
  expires_at: string | null; revocation_status: string; created_at: string; updated_at: string;
}
export interface AccessGrant { id: string; type: string; name: string; selection: 'all' | 'selected'; suspended: boolean; manage_url: string | null }
export interface ToolDefinition { name: string; connector: ConnectorName; description: string; read_only: boolean; required_permissions: string[]; input_schema: Record<string, unknown> }
export interface ConnectionListOptions { after?: string; limit?: number; connector?: ConnectorName; status?: Connection['status'] }
export class ConnanyError extends Error {
  constructor(public status: number, public code: string, message: string, public requestId?: string, public details?: Record<string, unknown>) { super(message); this.name = 'ConnanyError'; }
}
export class Connany {
  private base: string;
  constructor(private options: { baseUrl: string; apiKey: string; fetch?: typeof fetch }) {
    const url = new URL(options.baseUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('baseUrl must be an HTTPS origin, or HTTP localhost.');
    this.base = url.origin;
  }
  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await (this.options.fetch || fetch)(`${this.base}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    let result: any;
    try { result = await response.json(); } catch { throw new ConnanyError(response.status, 'invalid_response', 'Connany returned an invalid response.'); }
    if (!response.ok) throw new ConnanyError(response.status, result.error?.code || 'request_failed', result.error?.message || 'Connany request failed.', result.request_id, result.error?.details);
    return result as T;
  }
  /** Enabled connectors and their categories. Descriptions and category titles follow `lang` (default English). */
  connectors(options: { lang?: 'en' | 'zh-CN' | 'zh-HK' } = {}) {
    return this.request<{ categories: { name: ConnectorCategory; title: string }[]; data: { name: ConnectorName; title: string; category: ConnectorCategory; description: string; avatar_url: string; tools_synced_at: string | null }[] }>(`/v1/connectors${options.lang ? `?${new URLSearchParams({ lang: options.lang })}` : ''}`);
  }
  /** Tools the user can use now through an authorized connection. Use this in agent conversations. */
  listTools(connectionId: string, externalUserId: string, options: { query?: string; limit?: number; offset?: number; read_only?: boolean } = {}) {
    const query = new URLSearchParams({ external_user_id: externalUserId });
    for (const key of ['query','limit','offset','read_only'] as const) if (options[key] !== undefined) query.set(key, String(options[key]));
    return this.request<{data:ToolDefinition[];total:number;next_offset:number|null}>(`/v1/connections/${encodeURIComponent(connectionId)}/tools?${query}`);
  }
  /** Catalog of what enabled connectors offer, independent of users; e.g. to show capabilities before connecting. */
  toolCatalog(options: { connector?: ConnectorName; query?: string; limit?: number; offset?: number; read_only?: boolean } = {}) {
    const query = new URLSearchParams();
    for (const key of ['connector','query','limit','offset','read_only'] as const) if (options[key] !== undefined) query.set(key, String(options[key]));
    return this.request<{data:ToolDefinition[];total:number;next_offset:number|null}>(`/v1/tools?${query}`);
  }
  createSession(connector: ConnectorName, input: { external_user_id: string; return_url?: string }) {
    return this.request<ConnectSession & { connect_url: string }>(`/v1/connectors/${encodeURIComponent(connector)}/sessions`, 'POST', input);
  }
  getSession(connector: ConnectorName, id: string, externalUserId: string) { return this.request<ConnectSession>(`/v1/connectors/${encodeURIComponent(connector)}/sessions/${encodeURIComponent(id)}?${new URLSearchParams({ external_user_id: externalUserId })}`); }
  listConnections(externalUserId: string, options: string | ConnectionListOptions = {}) {
    const filters = typeof options === 'string' ? { after: options } : options;
    const query = new URLSearchParams({ external_user_id: externalUserId });
    for (const key of ['after','limit','connector','status'] as const) if (filters[key] !== undefined) query.set(key, String(filters[key]));
    return this.request<{ data: Connection[]; next_cursor: string | null }>(`/v1/connections?${query}`);
  }
  getConnection(id: string, externalUserId: string) { return this.request<Connection>(`/v1/connections/${encodeURIComponent(id)}?${new URLSearchParams({ external_user_id: externalUserId })}`); }
  checkConnection(id: string, externalUserId: string) {
    return this.request<{ connection_id: string; connector: ConnectorName; checked_at: string; tool_count: number; request_id: string }>(`/v1/connections/${encodeURIComponent(id)}/check`, 'POST', { external_user_id: externalUserId });
  }
  /** Resource scopes granted after OAuth, such as GitHub App installations. Empty when the connector has no such step. */
  listAccess(id: string, externalUserId: string, page = 1, limit = 20) {
    return this.request<{ add_url: string | null; total: number; next_page: number | null; data: AccessGrant[] }>(`/v1/connections/${encodeURIComponent(id)}/access?${new URLSearchParams({external_user_id:externalUserId,page:String(page),limit:String(limit)})}`);
  }
  reconnect(id: string, input: { external_user_id: string; return_url?: string }) { return this.request<ConnectSession & { connect_url: string }>(`/v1/connections/${encodeURIComponent(id)}/reconnect`, 'POST', input); }
  disconnect(id: string, externalUserId: string) { return this.request<Connection>(`/v1/connections/${encodeURIComponent(id)}?${new URLSearchParams({ external_user_id: externalUserId })}`, 'DELETE'); }
  callTool<T = unknown>(connectionId: string, externalUserId: string, tool: string, input: Record<string, unknown> = {}) {
    return this.request<{ data: T; request_id: string }>(`/v1/connections/${encodeURIComponent(connectionId)}/tools/${encodeURIComponent(tool)}/call`, 'POST', { external_user_id: externalUserId, input });
  }
  /** Project-wide event feed. Store next_cursor and pass it as after on the next poll. */
  events(options: { after?: string; external_user_id?: string; connection_id?: string; type?: string; limit?: number } = {}) {
    const query = new URLSearchParams();
    for (const key of ['after','external_user_id','connection_id','type','limit'] as const) if (options[key] !== undefined) query.set(key, String(options[key]));
    return this.request<{ data: { seq: string; type: string; external_user_id: string; connection_id: string | null; data: Record<string, unknown>; created_at: string }[]; next_cursor: string }>(`/v1/events?${query}`);
  }
}

/** Create once per authenticated user and selected connection. These bindings never come from model arguments. */
export function createAgentTools(client: Connany, context: {externalUserId: string; connectionId: string; connector: ConnectorName; allowWrites?: boolean; allowedTools?: readonly string[]}) {
  const bound = {...context, allowedTools:context.allowedTools ? [...context.allowedTools] : undefined};
  const allowed = (t: ToolDefinition) => t.connector === bound.connector && (bound.allowWrites === true || t.read_only) && (!bound.allowedTools || bound.allowedTools.includes(t.name));
  return {
    tools: [
      {name:'list_tools',description:'Find connector tools and their exact parameter schemas. Search before calling; paginate with next_offset. The connector is bound by the server.',input_schema:{type:'object',properties:{query:{type:'string'},offset:{type:'integer',minimum:0}},additionalProperties:false}},
      {name:'call_tool',description:'Call a listed tool using its input schema. User and connection are fixed by the server. Do not blindly retry writes after a timeout.',input_schema:{type:'object',properties:{tool:{type:'string'},input:{type:'object',additionalProperties:true}},required:['tool','input'],additionalProperties:false}}
    ],
    async call(name: string, args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
      if (name === 'list_tools') {
        if (Object.keys(args).some(k=>!['query','offset'].includes(k)) || (args.query !== undefined && typeof args.query !== 'string') || (args.offset !== undefined && (!Number.isInteger(args.offset) || Number(args.offset)<0))) throw new Error('Invalid list arguments.');
        const result = await client.listTools(bound.connectionId, bound.externalUserId, {query:args.query as string|undefined, offset:args.offset as number|undefined, ...(bound.allowWrites ? {} : {read_only:true})});
        return {...result,data:result.data.filter(allowed)};
      }
      if (name !== 'call_tool' || Object.keys(args).some(k=>!['tool','input'].includes(k)) || typeof args.tool !== 'string' || !args.input || typeof args.input !== 'object' || Array.isArray(args.input)) throw new Error('Invalid call arguments.');
      const result = await client.listTools(bound.connectionId, bound.externalUserId, {query:args.tool,limit:20});
      const tool = result.data.find(t=>t.name===args.tool);
      if (!tool || !allowed(tool)) throw new Error('Tool is unavailable or disallowed by the agent backend.');
      return client.callTool(bound.connectionId, bound.externalUserId, tool.name, args.input as Record<string,unknown>);
    }
  };
}
