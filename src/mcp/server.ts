import { z } from 'zod';
import { connectorNames, type AnyConnector, type ConnectorName } from '../config.js';
import type { ToolDefinition } from '../connector-store.js';
import { connector as connectorSpec } from '../connectors/catalog.js';
import { toolNamePattern, type ToolName } from '../connectors/index.js';
import { AppError } from '../errors.js';
import type { Connection, Project, Service } from '../service.js';
import { searchTools } from '../tool-search.js';
import { defaultWorkspaceId } from '../workspaces.js';
import type { OAuthUser } from './oauth.js';

/**
 * Connany's own MCP server (Streamable HTTP, stateless JSON responses). Instead of listing
 * every upstream tool (PostHog alone has ~750), it offers a few meta-tools: find connectors,
 * connect accounts, search and describe tools, and call them through the user's connections.
 * Reads and writes are separate tools so MCP clients can ask before every write.
 */
export const protocolVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const instructions = `Connany connects this agent to the user's accounts in third-party services (Notion, Linear, GitHub, Stripe, PostHog, Sentry, ...).
1. Call list_connectors to see which accounts are connected and which services can be connected.
2. If the needed service is not connected, call connect and show the returned link to the user in your reply. Then call wait_for_connection right away: it returns as soon as the user has authorized in the browser, so continue with their request without asking them to confirm.
3. Call search_tools with keywords to find a tool, then describe_tool for its input schema.
4. Use call_read_tool for read-only tools. Use call_write_tool only for changes the user asked for, and confirm first.`;

const text = (value: unknown) => ({ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) });
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const callInput = object({
  name: { type: 'string', description: 'Tool name from search_tools, e.g. "notion.notion-search".' },
  arguments: { type: 'object', description: 'Arguments matching the input_schema from describe_tool.', additionalProperties: true },
  connection_id: { type: 'string', description: 'Required only when several accounts of the same service are connected.' },
}, ['name']);
export const tools = [
  { name: 'list_connectors', title: 'List connectors', description: 'List the services the user can connect and the accounts already connected (with connection ids and status). Call this first.',
    inputSchema: object({}), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'connect', title: 'Connect an account', description: 'Create a link the user opens in a browser to connect an account of a service (or to reconnect an expired connection). Show the link to the user and wait for them to finish.',
    inputSchema: object({ connector: { type: 'string', enum: connectorNames, description: 'Service name from list_connectors.' }, connection_id: { type: 'string', description: 'Reconnect this existing connection instead of adding a new account.' } }, ['connector']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } },
  { name: 'wait_for_connection', title: 'Wait for a connection', description: 'After showing a link from connect, wait until the user finishes authorizing in the browser (up to about 45 seconds per call). Returns the new connection when done; if still pending, call it again.',
    inputSchema: object({ session_id: { type: 'string', description: 'session_id returned by connect.' } }, ['session_id']), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'search_tools', title: 'Search tools', description: 'Search the tools available through the user\'s connected accounts by keywords (English works best). Returns tool names, whether they only read, and short descriptions.',
    inputSchema: object({ query: { type: 'string', description: 'Keywords, e.g. "issues list" or "web traffic".' }, connector: { type: 'string', enum: connectorNames, description: 'Only tools of this service.' }, limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }, offset: { type: 'integer', minimum: 0, default: 0 } }),
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'describe_tool', title: 'Describe a tool', description: 'Full description and input schema of one tool. Call before calling a tool for the first time.',
    inputSchema: object({ name: { type: 'string', description: 'Tool name from search_tools.' } }, ['name']), annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'call_read_tool', title: 'Call a read-only tool', description: 'Call a read-only tool (read_only: true) with the user\'s connected account and return its result.',
    inputSchema: callInput, annotations: { readOnlyHint: true, openWorldHint: true } },
  { name: 'call_write_tool', title: 'Call a tool that can make changes', description: 'Call a tool that can create, change or delete data (read_only: false) in the user\'s account. Only for changes the user explicitly asked for; confirm the details with the user first.',
    inputSchema: callInput, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
];

class ToolFailure extends Error {}
const listInput = z.object({}).passthrough();
const connectInput = z.object({ connector: z.enum(connectorNames), connection_id: z.string().max(200).optional() });
const searchInput = z.object({ query: z.string().max(500).optional(), connector: z.enum(connectorNames).optional(), limit: z.number().int().min(1).max(50).default(20), offset: z.number().int().min(0).default(0) });
const nameInput = z.object({ name: z.string().max(150) });
const waitInput = z.object({ session_id: z.string().max(200) });
const waitSeconds = 45;
const callArgs = z.object({ name: z.string().max(150), arguments: z.record(z.string(), z.unknown()).default({}), connection_id: z.string().max(200).optional() });

export class McpServer {
  constructor(private service: Service) {}
  /** Handle one JSON-RPC message; null for notifications. */
  async handle(user: OAuthUser, message: any): Promise<object | null> {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    if (message.id === undefined || message.id === null) return null;
    const reply = (result: object) => ({ jsonrpc: '2.0', id: message.id, result });
    const fail = (code: number, text: string) => ({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
    switch (message.method) {
      case 'initialize': {
        const requested = message.params?.protocolVersion;
        return reply({ protocolVersion: protocolVersions.includes(requested) ? requested : protocolVersions[0], capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'connany', title: 'Connany', version: '0.1.0' }, instructions });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools });
      case 'tools/call': {
        const name = message.params?.name;
        if (!tools.some(t => t.name === name)) return fail(-32602, `Unknown tool: ${String(name)}`);
        return reply(await this.call(user, name, message.params?.arguments ?? {}));
      }
      default: return fail(-32601, `Method not found: ${message.method}`);
    }
  }
  private async call(user: OAuthUser, name: string, args: unknown) {
    const project = await this.service.personalProject(user);
    try {
      await this.service.rateLimit(project.id);
      switch (name) {
        case 'list_connectors': listInput.parse(args); return { content: [text(await this.overview(user, project))] };
        case 'connect': return { content: [text(await this.connect(user, project, connectInput.parse(args)))] };
        case 'wait_for_connection': return { content: [text(await this.wait(user, project, waitInput.parse(args).session_id))] };
        case 'search_tools': return { content: [text(await this.search(user, project, searchInput.parse(args)))] };
        case 'describe_tool': return { content: [text(await this.describe(user, project, nameInput.parse(args).name))] };
        default: return await this.run(user, project, callArgs.parse(args), name === 'call_write_tool');
      }
    } catch (error) {
      if (error instanceof z.ZodError) return { content: [text(`Invalid arguments: ${error.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}`)], isError: true };
      if (error instanceof ToolFailure) return { content: [text(error.message)], isError: true };
      if (error instanceof AppError) return { content: [text(this.explain(error))], isError: true };
      throw error;
    }
  }
  private explain(error: AppError) {
    const upstream = (error.details?.result as any)?.content?.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('\n');
    const hints: Record<string, string> = {
      reauth_required: 'The connection needs to be authorized again: call connect with this connection_id and show the link to the user.',
      connection_revoked: 'The connection was disconnected: call connect to connect the account again.',
      connector_not_configured: 'This service is not available on this Connany server. Call list_connectors for the available ones.',
      rate_limited: 'Too many requests: wait a minute and retry.',
    };
    const message = typeof error.details?.upstream_message === 'string' ? `Upstream said: ${error.details.upstream_message}` : undefined;
    return [`${error.code}: ${error.message}`, upstream, message, hints[error.code]].filter(Boolean).join('\n');
  }
  /** Connectors offered to the user: their own enabled ones plus the platform's. */
  private async available(user: OAuthUser) {
    const lists = await Promise.all([...new Set([user.workspace_id, defaultWorkspaceId])].map(ws => this.service.connectorStore.in(ws).list()));
    return connectorNames.filter(name => lists.some(list => list.find(c => c.name === name)?.enabled));
  }
  private async connections(user: OAuthUser, project: Project, connector?: ConnectorName) {
    const { rows } = await this.service.pool.query<Connection>(`SELECT * FROM connections WHERE project_id=$1 AND external_user_id=$2 AND status<>'revoked' AND ($3::text IS NULL OR connector=$3) ORDER BY created_at`, [project.id, user.id, connector ?? null]);
    return rows;
  }
  private async overview(user: OAuthUser, project: Project) {
    const [available, connections] = await Promise.all([this.available(user), this.connections(user, project)]);
    return {
      connections: connections.map(c => ({ id: c.id, connector: c.connector, title: connectorSpec(c.connector).label, status: c.status,
        account: c.identity.account_name ?? null, workspace: c.identity.workspace_name ?? null })),
      available_connectors: available.map(name => ({ name, title: connectorSpec(name).label, description: connectorSpec(name).description.en,
        connected: connections.some(c => c.connector === name && c.status === 'connected') })),
    };
  }
  private async connect(user: OAuthUser, project: Project, input: z.infer<typeof connectInput>) {
    if (input.connection_id) {
      const existing = await this.service.getConnection(project.id, user.id, input.connection_id);
      if (existing.connector !== input.connector) throw new ToolFailure(`Connection ${input.connection_id} belongs to ${existing.connector}.`);
    }
    const session = await this.service.createSession(project, { external_user_id: user.id, connector: input.connector, agent_name: user.client_name }, input.connection_id);
    const title = connectorSpec(input.connector).label;
    return { session_id: session.id, connect_url: session.connect_url, expires_at: session.expires_at,
      next_step: `Show this link to the user and ask them to open it in a browser to connect ${title}: ${session.connect_url}\nThe link expires in 15 minutes. Then call wait_for_connection with session_id "${session.id}"; it returns once they have authorized, and you continue with their request.` };
  }
  /** Long-poll a connect session so the agent continues as soon as the user has authorized. */
  private async wait(user: OAuthUser, project: Project, sessionId: string) {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const { rows } = await this.service.pool.query('SELECT id,connector,status,connection_id,error_code,expires_at FROM connect_sessions WHERE id=$1 AND project_id=$2 AND external_user_id=$3', [sessionId, project.id, user.id]);
      const session = rows[0];
      if (!session) throw new ToolFailure(`Unknown session ${sessionId}. Use the session_id returned by connect.`);
      const title = connectorSpec(session.connector).label;
      if (session.status === 'connected') {
        const connection = await this.service.getConnection(project.id, user.id, session.connection_id);
        return { status: 'connected', connection: { id: connection.id, connector: connection.connector, account: connection.identity.account_name ?? null }, next_step: `${title} is connected. Continue with the user's request.` };
      }
      if (session.status === 'error') return { status: 'failed', error_code: session.error_code, next_step: session.error_code === 'access_denied' ? `The user declined to connect ${title}.` : `Connecting ${title} failed (${session.error_code}). Offer a new link with connect.` };
      if (new Date(session.expires_at).getTime() <= Date.now()) return { status: 'expired', next_step: 'The link expired. Call connect for a new link if the user still wants to connect.' };
      if (Date.now() >= deadline) return { status: 'pending', next_step: `The user has not finished authorizing ${title} yet. Call wait_for_connection again, or stop if they said they do not want to connect.` };
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
  /** Tools of the user's connected services, from the catalog cache or discovered with their credential. */
  private async catalog(user: OAuthUser, project: Project, connector?: ConnectorName) {
    const connected = (await this.connections(user, project, connector)).filter(c => c.status === 'connected');
    const store = this.service.connectorStore.in(project.workspace_id);
    const byConnector = new Map<AnyConnector, Connection[]>();
    for (const c of connected) byConnector.set(c.connector, [...(byConnector.get(c.connector) || []), c]);
    const tools: ToolDefinition[] = [];
    for (const [name, list] of byConnector) {
      const cached = await store.catalog(name);
      tools.push(...(cached ?? await this.service.execute(project.id, user.id, list[0].id, `${name}.__discover`, {}) as ToolDefinition[]));
    }
    return { tools, byConnector };
  }
  private async search(user: OAuthUser, project: Project, input: z.infer<typeof searchInput>) {
    const { tools: all, byConnector } = await this.catalog(user, project, input.connector);
    if (!byConnector.size) throw new ToolFailure(`No connected ${input.connector ? connectorSpec(input.connector).label + ' ' : ''}account. Call list_connectors, then connect.`);
    const page = searchTools(all, { query: input.query, limit: input.limit, offset: input.offset });
    return { tools: page.data.map(t => ({ name: t.name, connector: t.connector, read_only: t.read_only, description: t.description.length > 300 ? t.description.slice(0, 300) + '…' : t.description })),
      total: page.total, next_offset: page.next_offset };
  }
  private async find(user: OAuthUser, project: Project, name: string) {
    const connector = name.split('.')[0] as ConnectorName;
    if (!connectorNames.includes(connector) || !toolNamePattern.test(name) || /\.__/.test(name)) throw new ToolFailure(`Unknown tool ${name}. Use search_tools to find tool names.`);
    const { tools, byConnector } = await this.catalog(user, project, connector);
    if (!byConnector.size) throw new ToolFailure(`No connected ${connectorSpec(connector).label} account. Call connect first.`);
    const tool = tools.find(t => t.name === name);
    if (!tool) throw new ToolFailure(`Unknown tool ${name}. Use search_tools to find tool names.`);
    return { tool, connections: byConnector.get(connector)! };
  }
  private async describe(user: OAuthUser, project: Project, name: string) {
    const { tool, connections } = await this.find(user, project, name);
    return { name: tool.name, connector: tool.connector, read_only: tool.read_only, description: tool.description, input_schema: tool.input_schema,
      call_with: tool.read_only ? 'call_read_tool' : 'call_write_tool', connections: connections.map(c => ({ id: c.id, account: c.identity.account_name ?? null })) };
  }
  private async run(user: OAuthUser, project: Project, input: z.infer<typeof callArgs>, write: boolean) {
    const { tool, connections } = await this.find(user, project, input.name);
    // Read-only is decided by the upstream tool annotations, not by the model.
    if (!write && !tool.read_only) throw new ToolFailure(`${tool.name} can make changes. Confirm with the user, then use call_write_tool.`);
    let connection = connections[0];
    if (input.connection_id) {
      connection = connections.find(c => c.id === input.connection_id)!;
      if (!connection) throw new ToolFailure(`Connection ${input.connection_id} is not a connected ${connectorSpec(tool.connector).label} account. Call list_connectors.`);
    } else if (connections.length > 1) {
      throw new ToolFailure(`Several ${connectorSpec(tool.connector).label} accounts are connected; pass connection_id: ${connections.map(c => `${c.id} (${c.identity.account_name ?? 'account'})`).join(', ')}.`);
    }
    const data: any = await this.service.execute(project.id, user.id, connection.id, tool.name as ToolName, input.arguments);
    if (Array.isArray(data?.content)) return { content: data.content, ...(data.isError ? { isError: true } : {}) };
    return { content: [text(data)] };
  }
}
