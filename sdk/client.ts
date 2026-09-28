/** Server-side SDK. Do not bundle the project key into a browser, mobile app or LLM prompt. */
export type Provider = 'notion' | 'github' | 'linear';
export interface ConnectSession {
  id: string; provider: Provider; status: 'pending' | 'authorizing' | 'processing' | 'connected' | 'error' | 'expired';
  expires_at: string; connect_url?: string; connection_id?: string | null; error_code?: string | null;
}
export interface Connection {
  id: string; external_user_id: string; provider: Provider; status: 'connected' | 'reauth_required' | 'revoked';
  identity: { account_id: string; account_name: string; workspace_id?: string; workspace_name?: string; [key: string]: unknown };
  expires_at: string | null; revocation_status: string; created_at: string; updated_at: string;
}
export interface ActionDefinition { name: string; provider: Provider; description: string; read_only: boolean; required_permissions: string[]; input_schema: Record<string, unknown> }
export interface ConnectionListOptions { after?: string; limit?: number; provider?: Provider; status?: Connection['status'] }
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
  providers() { return this.request<{ data: { name: Provider; enabled: boolean; installation_url?: string }[] }>('/v1/providers'); }
  actions() { return this.request<{ data: ActionDefinition[] }>('/v1/actions'); }
  discoverActions(input: {external_user_id?: string; connection_id?: string; provider?: Provider; query?: string; limit?: number; offset?: number; read_only?: boolean} = {}) {
    return this.request<{data:ActionDefinition[];total:number;next_offset:number|null}>('/v1/actions/discover','POST',input);
  }
  createSession(input: { external_user_id: string; provider: Provider; return_url?: string }) {
    return this.request<ConnectSession & { connect_url: string }>('/v1/connect-sessions', 'POST', input);
  }
  getSession(id: string, externalUserId: string) { return this.request<ConnectSession>(`/v1/connect-sessions/${encodeURIComponent(id)}?${new URLSearchParams({ external_user_id: externalUserId })}`); }
  listConnections(externalUserId: string, options: string | ConnectionListOptions = {}) {
    const filters = typeof options === 'string' ? { after: options } : options;
    const query = new URLSearchParams({ external_user_id: externalUserId });
    for (const key of ['after','limit','provider','status'] as const) if (filters[key] !== undefined) query.set(key, String(filters[key]));
    return this.request<{ data: Connection[]; next_cursor: string | null }>(`/v1/connections?${query}`);
  }
  getConnection(id: string, externalUserId: string) { return this.request<Connection>(`/v1/connections/${encodeURIComponent(id)}?${new URLSearchParams({ external_user_id: externalUserId })}`); }
  checkConnection(id: string, externalUserId: string) {
    return this.request<{ connection_id: string; provider: Provider; checked_at: string; tool_count: number; request_id: string }>(`/v1/connections/${encodeURIComponent(id)}/check`, 'POST', { external_user_id: externalUserId });
  }
  githubInstallations(id: string, externalUserId: string, page = 1, limit = 20) {
    return this.request<{ installation_url: string; total_count: number; next_page: number | null;
      data: { id: number; account: string; account_type: string; repository_selection: string; suspended_at: string | null; management_url: string | null }[]
    }>(`/v1/connections/${encodeURIComponent(id)}/github/installations?${new URLSearchParams({external_user_id:externalUserId,page:String(page),limit:String(limit)})}`);
  }
  reconnect(id: string, input: { external_user_id: string; return_url?: string }) { return this.request<ConnectSession & { connect_url: string }>(`/v1/connections/${encodeURIComponent(id)}/reconnect`, 'POST', input); }
  disconnect(id: string, externalUserId: string) { return this.request<Connection>(`/v1/connections/${encodeURIComponent(id)}?${new URLSearchParams({ external_user_id: externalUserId })}`, 'DELETE'); }
  execute<T = unknown>(input: { external_user_id: string; connection_id: string; action: string; input?: Record<string, unknown> }) { return this.request<{ data: T; request_id: string }>('/v1/actions/execute', 'POST', input); }
  events(externalUserId: string, after = '0') { return this.request<{ data: { seq: string; type: string; connection_id: string | null; data: Record<string, unknown>; created_at: string }[]; next_cursor: string }>(`/v1/events?${new URLSearchParams({ external_user_id: externalUserId, after })}`); }
}

/** Create once per authenticated user and selected connection. These bindings never come from model arguments. */
export function createAgentTools(client: Connany, context: {externalUserId: string; connectionId: string; provider: Provider; allowWrites?: boolean; allowedActions?: readonly string[]}) {
  const bound = {...context, allowedActions:context.allowedActions ? [...context.allowedActions] : undefined};
  const allowed = (a: ActionDefinition) => a.provider === bound.provider && (bound.allowWrites === true || a.read_only) && (!bound.allowedActions || bound.allowedActions.includes(a.name));
  return {
    tools: [
      {name:'discover_actions',description:'Find supported connector operations and their exact parameter schemas. Search before executing; paginate with next_offset. The provider is bound by the server.',input_schema:{type:'object',properties:{query:{type:'string'},offset:{type:'integer',minimum:0}},additionalProperties:false}},
      {name:'execute_action',description:'Execute a discovered action using its input schema. User and connection are fixed by the server. Do not blindly retry writes after a timeout.',input_schema:{type:'object',properties:{action:{type:'string'},input:{type:'object',additionalProperties:true}},required:['action','input'],additionalProperties:false}}
    ],
    async call(name: string, args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
      if (name === 'discover_actions') {
        if (Object.keys(args).some(k=>!['query','offset'].includes(k)) || (args.query !== undefined && typeof args.query !== 'string') || (args.offset !== undefined && (!Number.isInteger(args.offset) || Number(args.offset)<0))) throw new Error('Invalid discovery arguments.');
        const result = await client.discoverActions({provider:bound.provider,external_user_id:bound.externalUserId,connection_id:bound.connectionId, query:args.query as string|undefined, offset:args.offset as number|undefined, ...(bound.allowWrites ? {} : {read_only:true})});
        return {...result,data:result.data.filter(allowed)};
      }
      if (name !== 'execute_action' || Object.keys(args).some(k=>!['action','input'].includes(k)) || typeof args.action !== 'string' || !args.input || typeof args.input !== 'object' || Array.isArray(args.input)) throw new Error('Invalid execution arguments.');
      const result = await client.discoverActions({provider:bound.provider,external_user_id:bound.externalUserId,connection_id:bound.connectionId,query:args.action,limit:20});
      const action = result.data.find(a=>a.name===args.action);
      if (!action || !allowed(action)) throw new Error('Action is unavailable or disallowed by the agent backend.');
      return client.execute({external_user_id:bound.externalUserId,connection_id:bound.connectionId,action:action.name,input:args.input as Record<string,unknown>});
    }
  };
}
