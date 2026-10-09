import { UpstreamError } from '../errors.js';
import type { HostedMcp } from './hosted-mcp.js';
import type { ConnectorRuntime, Credentials, Identity } from './index.js';
import { githubAccess } from './github-access.js';
import { linearIdentity, notionIdentity } from './mcp-identity.js';
import type { Localized } from '../i18n.js';

/**
 * Built-in connector catalog. A standard hosted MCP connector (dynamic client registration,
 * PKCE, `/authorize` `/token` `/register` and the MCP endpoint on one origin) needs only an
 * entry here. Connectors with bespoke OAuth, like GitHub Apps, keep custom handling in ConnectorRuntime.
 */
/** One resource scope a connection can reach, e.g. a GitHub organization the App is installed in. */
export interface AccessGrant { id: string; type: string; name: string; selection: 'all' | 'selected'; suspended: boolean; manage_url: string | null }
/**
 * Optional post-authorization step where users grant access to more resources after OAuth,
 * such as installing a GitHub App into organizations. Connectors without it need no extra step.
 */
export interface ConnectorAccess {
  /** Label of the hosted-page button that opens addUrl. */
  label: string;
  /** Whether a freshly authorized identity still needs this step. */
  needsAccess: (identity: Record<string, any>) => boolean;
  addUrl: (runtime: ConnectorRuntime) => string;
  list: (context: { call: (tool: string, input: Record<string, unknown>) => Promise<unknown>; page: number; limit: number }) => Promise<{ total: number; data: AccessGrant[] }>;
  /** Identity after a fresh listing, so needsAccess stops reporting work the user already did. */
  refresh?: (identity: Record<string, any>, total: number) => Record<string, any>;
}
/** OAuth endpoints from the authorization server metadata (RFC 8414), when they are not origin + /authorize, /token, /register. */
export interface OAuthEndpoints { authorize: string; token: string; register: string; revoke?: string; userinfo?: string }
export type ClientAuthMethod = 'none' | 'client_secret_post' | 'client_secret_basic';
export interface McpSpec {
  origin: string;
  /** MCP endpoint path on origin. Defaults to /mcp. */
  endpoint?: string;
  /** Explicit OAuth endpoints. Without them the legacy origin + /authorize, /token, /register layout applies. */
  oauth?: OAuthEndpoints;
  /** Requested scopes (space separated), sent on registration and authorization. */
  scope?: string;
  /** Token endpoint authentication requested at registration. Servers without public clients need a secret. */
  clientAuth?: ClientAuthMethod;
  /** Extra authorize query parameters, e.g. prompt. */
  authorizeParams?: Record<string, string>;
  /** Extra headers on every MCP request, e.g. to pick a server mode. */
  headers?: Record<string, string>;
  /** RFC 8707 resource indicator: true for origin + endpoint, or the exact resource from the protected resource metadata. */
  resource?: boolean | string;
}
/** Groups connectors in the console and in GET /v1/connectors. */
export const connectorCategories = ['collaboration', 'development', 'data', 'analytics', 'payments', 'design'] as const;
export type ConnectorCategory = typeof connectorCategories[number];
export const categoryTitles: Record<ConnectorCategory, Localized> = {
  collaboration: { 'zh-CN': '协作与办公', en: 'Collaboration' },
  development: { 'zh-CN': '代码与部署', en: 'Code & deploy' },
  data: { 'zh-CN': '数据库', en: 'Databases' },
  analytics: { 'zh-CN': '监控与分析', en: 'Monitoring & analytics' },
  payments: { 'zh-CN': '支付', en: 'Payments' },
  design: { 'zh-CN': '设计与建站', en: 'Design & websites' },
};
export interface ConnectorDefinition {
  label: string;
  category: ConnectorCategory;
  /** Official product homepage linked from the admin card. */
  website: string;
  /** Inline SVG or short text rendered inside the connector badge. */
  icon: string;
  /** One-line capability summary for the admin card and GET /v1/connectors. */
  description: Localized;
  auth: 'mcp' | 'github_app';
  mcp: McpSpec;
  /** Resolve the account from the token response. MCP connectors without one use OIDC claims or userinfo, see genericIdentity. */
  identify?: (mcp: HostedMcp, credential: Credentials, raw: any) => Promise<Identity>;
  /** Refresh display names for existing connections without changing account identity. */
  refreshIdentity?: (mcp: HostedMcp, credential: Credentials, expected: {account_id: string; workspace_id?: string}) => Promise<Record<string, unknown>>;
  access?: ConnectorAccess;
}

const checked = <T extends object>(identity: T) => ({...identity, identity_checked_at: new Date().toISOString()});

export const connectorCatalog = {
  notion: {
    label: 'Notion',
    category: 'collaboration',
    website: 'https://www.notion.com',
    description: { 'zh-CN': '页面、数据库与工作区搜索', en: 'Pages, databases and workspace search' },
    // Notion / GitHub icons from LobeHub Icons (https://icons.lobehub.com)
    icon: '<svg aria-hidden="true" fill="currentColor" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path clip-rule="evenodd" d="M15.257.055l-13.31.98C.874 1.128.5 1.83.5 2.667v14.559c0 .654.233 1.213.794 1.96l3.129 4.06c.513.653.98.794 1.962.745l15.457-.932c1.307-.093 1.681-.7 1.681-1.727V4.954c0-.53-.21-.684-.829-1.135l-.106-.078L18.34.755c-1.027-.746-1.45-.84-3.083-.7zm-8.521 4.63c-1.263.086-1.549.105-2.266-.477L2.647 2.76c-.186-.187-.092-.42.375-.466l12.796-.933c1.074-.094 1.634.28 2.054.606l2.195 1.587c.093.047.326.326.047.326l-13.216.794-.162.01zM5.263 21.193V7.287c0-.606.187-.886.748-.933l15.176-.886c.515-.047.748.28.748.886v13.81c0 .609-.093 1.122-.934 1.168l-14.523.84c-.842.047-1.215-.232-1.215-.98zm14.338-13.16c.093.422 0 .842-.422.89l-.699.139v10.264c-.608.327-1.168.513-1.635.513-.747 0-.934-.232-1.495-.932l-4.576-7.185v6.952l1.448.327s0 .84-1.169.84l-3.221.186c-.094-.187 0-.654.327-.747l.84-.232V9.853L7.832 9.76c-.093-.42.14-1.026.794-1.073l3.456-.232 4.763 7.279v-6.44l-1.214-.14c-.094-.513.28-.887.747-.933l3.223-.187z"></path></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.notion.com', authorizeParams: { scope: 'default', prompt: 'consent' } },
    async identify(mcp, credential, raw) {
      if (typeof raw.workspace_id !== 'string' || !raw.workspace_id || typeof raw.user_id !== 'string' || !raw.user_id) throw new UpstreamError('invalid_upstream_identity');
      const identity = { account_id: raw.user_id, account_name: 'Notion user', workspace_id: raw.workspace_id, workspace_name: 'Notion workspace', transport: 'mcp' };
      try { Object.assign(identity, await notionIdentity(mcp, credential, identity)); } catch { /* Optional metadata must not fail a valid authorization. */ }
      return checked(identity);
    },
    refreshIdentity: (mcp, credential, expected) => notionIdentity(mcp, credential, {account_id: expected.account_id, workspace_id: expected.workspace_id || ''}),
  },
  github: {
    label: 'GitHub',
    category: 'development',
    website: 'https://github.com',
    description: { 'zh-CN': '仓库、Issue 与 Pull Request', en: 'Repositories, issues and pull requests' },
    icon: '<svg aria-hidden="true" fill="currentColor" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 0c6.63 0 12 5.276 12 11.79-.001 5.067-3.29 9.567-8.175 11.187-.6.118-.825-.25-.825-.56 0-.398.015-1.665.015-3.242 0-1.105-.375-1.813-.81-2.181 2.67-.295 5.475-1.297 5.475-5.822 0-1.297-.465-2.344-1.23-3.169.12-.295.54-1.503-.12-3.125 0 0-1.005-.324-3.3 1.209a11.32 11.32 0 00-3-.398c-1.02 0-2.04.133-3 .398-2.295-1.518-3.3-1.209-3.3-1.209-.66 1.622-.24 2.83-.12 3.125-.765.825-1.23 1.887-1.23 3.169 0 4.51 2.79 5.527 5.46 5.822-.345.294-.66.81-.765 1.577-.69.31-2.415.81-3.495-.973-.225-.354-.9-1.223-1.845-1.209-1.005.015-.405.56.015.781.51.28 1.095 1.327 1.23 1.666.24.663 1.02 1.93 4.035 1.385 0 .988.015 1.916.015 2.196 0 .31-.225.664-.825.56C3.303 21.374-.003 16.867 0 11.791 0 5.276 5.37 0 12 0z"></path></svg>',
    auth: 'github_app',
    mcp: { origin: 'https://api.githubcopilot.com', endpoint: '/mcp/x/all' },
    access: githubAccess,
  },
  linear: {
    label: 'Linear',
    category: 'collaboration',
    website: 'https://linear.app',
    description: { 'zh-CN': 'Issue、项目与团队协作', en: 'Issues, projects and team collaboration' },
    // Official logomark: https://linear.app/brand (Linear-Brand-Assets.zip?v=3, logo-dark.svg).
    icon: '<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" fill="currentColor" width="200" height="200" viewBox="0 0 100 100"> <path d="M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3342 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228ZM.00189135 46.8891c-.01764375.2833.08887215.5599.28957165.7606L52.3503 99.7085c.2007.2007.4773.3075.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.77832 4.5932-.92588465 6.9624ZM4.21093 29.7054c-.16649.3738-.08169.8106.20765 1.1l64.77602 64.776c.2894.2894.7262.3742 1.1.2077 1.7861-.7956 3.5171-1.6927 5.1855-2.684.5521-.328.6373-1.0867.1832-1.5407L8.43566 24.3367c-.45409-.4541-1.21271-.3689-1.54074.1832-.99132 1.6684-1.88843 3.3994-2.68399 5.1855ZM12.6587 18.074c-.3701-.3701-.393-.9637-.0443-1.3541C21.7795 6.45931 35.1114 0 49.9519 0 77.5927 0 100 22.4073 100 50.0481c0 14.8405-6.4593 28.1724-16.7199 37.3375-.3903.3487-.984.3258-1.3542-.0443L12.6587 18.074Z" /> </svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.linear.app', authorizeParams: { scope: 'read write', prompt: 'consent' }, resource: true },
    identify: async (mcp, credential) => checked(await linearIdentity(mcp, credential)),
    refreshIdentity: (mcp, credential, expected) => linearIdentity(mcp, credential, expected),
  },
  // Hosted MCP servers below were verified against their protected resource (RFC 9728) and
  // authorization server (RFC 8414) metadata: dynamic client registration, PKCE S256 and a
  // Streamable HTTP endpoint. Icons: Simple Icons (CC0); monday.com and Canva use monograms.
  sentry: {
    label: 'Sentry',
    category: 'analytics',
    website: 'https://sentry.io',
    description: { 'zh-CN': '错误监控、Issue 与性能追踪', en: 'Errors, issues and performance' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.sentry.dev', oauth: { authorize: 'https://mcp.sentry.dev/oauth/authorize', token: 'https://mcp.sentry.dev/oauth/token', register: 'https://mcp.sentry.dev/oauth/register', revoke: 'https://mcp.sentry.dev/oauth/token' }, scope: 'org:read project:write team:write event:write alerts:write', resource: 'https://mcp.sentry.dev/mcp' },
  },
  posthog: {
    label: 'PostHog',
    category: 'analytics',
    website: 'https://posthog.com',
    description: { 'zh-CN': '产品分析、功能开关与会话回放', en: 'Product analytics, feature flags and session replay' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M9.854 14.5 5 9.647.854 5.5A.5.5 0 0 0 0 5.854V8.44a.5.5 0 0 0 .146.353L5 13.647l.147.146L9.854 18.5l.146.147v-.049c.065.03.134.049.207.049h2.586a.5.5 0 0 0 .353-.854L9.854 14.5zm0-5-4-4a.487.487 0 0 0-.409-.144.515.515 0 0 0-.356.21.493.493 0 0 0-.089.288V8.44a.5.5 0 0 0 .147.353l9 9a.5.5 0 0 0 .853-.354v-2.585a.5.5 0 0 0-.146-.354l-5-5zm1-4a.5.5 0 0 0-.854.354V8.44a.5.5 0 0 0 .147.353l4 4a.5.5 0 0 0 .853-.354V9.854a.5.5 0 0 0-.146-.354l-4-4zm12.647 11.515a3.863 3.863 0 0 1-2.232-1.1l-4.708-4.707a.5.5 0 0 0-.854.354v6.585a.5.5 0 0 0 .5.5H23.5a.5.5 0 0 0 .5-.5v-.6c0-.276-.225-.497-.499-.532zm-5.394.032a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zM.854 15.5a.5.5 0 0 0-.854.354v2.293a.5.5 0 0 0 .5.5h2.293c.222 0 .39-.135.462-.309a.493.493 0 0 0-.109-.545L.854 15.501zM5 14.647.854 10.5a.5.5 0 0 0-.854.353v2.586a.5.5 0 0 0 .146.353L4.854 18.5l.146.147h2.793a.5.5 0 0 0 .353-.854L5 14.647z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.posthog.com', oauth: { authorize: 'https://oauth.posthog.com/oauth/authorize/', token: 'https://oauth.posthog.com/oauth/token/', register: 'https://oauth.posthog.com/oauth/register/', revoke: 'https://oauth.posthog.com/oauth/revoke/', userinfo: 'https://oauth.posthog.com/oauth/userinfo/' }, scope: 'openid profile email introspection action:read action:write access_control:read access_control:write account:read account:write activity_log:read alert:read alert:write annotation:read annotation:write approvals:read approvals:write autoresearch:read autoresearch:write batch_export:read batch_export:write billing:read business_knowledge:read business_knowledge:write canvas:read canvas:write cohort:read cohort:write comment:read comment:write conversation:read customer_analytics:read customer_analytics:write customer_task:read customer_task:write data_catalog:read data_catalog:write data_catalog_approval:write dashboard:read dashboard:write dashboard_template:read dataset:read dataset:write early_access_feature:read early_access_feature:write endpoint:read endpoint:write engineering_analytics:read error_tracking:read error_tracking:write evaluation:read evaluation:write element:read event_definition:read event_definition:write experiment:read experiment:write experiment_holdout:read experiment_holdout:write experiment_saved_metric:read experiment_saved_metric:write external_data_source:read external_data_source:write feature_flag:read feature_flag:write group:read health_issue:read heatmap:read heatmap:write hog_flow:read hog_flow:write hog_function:read hog_function:write insight:read insight:write insight_variable:write integration:read integration:write llm_analytics:read llm_analytics:write ai_observability_clusters:read ai_observability_clusters:write llm_prompt:read llm_prompt:write llm_provider_key:read llm_skill:read llm_skill:write logs:read logs:write loop:read loop:write marketing_analytics:read marketing_analytics:write mcp_analytics:read mcp_analytics:write mcp_registry:read metrics:read notebook:read notebook:write organization:read organization:write organization_member:read person:read person:write product_enablement:write project:read project:write property_definition:read property_definition:write query:read replay_scanner:read replay_scanner:write review_hog:read review_hog:write session_recording:read session_recording:write session_recording_playlist:read session_recording_playlist:write signal_scout:read signal_scout:write stamphog:read stamphog:write streamlit_app:read streamlit_app:write subscription:read subscription:write survey:read survey:write tagger:read tagger:write ticket:read ticket:write task:read task:write today:read tracing:read field_note:read field_note:write uploaded_media:read uploaded_media:write usage_metric:read usage_metric:write user:read user:write user_interview:read user_interview:write vision_alert:read vision_alert:write visual_review:read visual_review:write warehouse_table:read warehouse_table:write warehouse_view:read warehouse_view:write web_analytics:read web_analytics:write', resource: 'https://mcp.posthog.com/mcp',
      // PostHog defaults most agents to a single CLI-style `exec` tool; list every tool individually instead.
      headers: { 'x-posthog-mcp-mode': 'tools' } },
  },
  atlassian: {
    label: 'Atlassian',
    category: 'collaboration',
    website: 'https://www.atlassian.com',
    description: { 'zh-CN': 'Jira 与 Confluence 的事项、页面与项目', en: 'Jira and Confluence issues, pages and projects' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M7.12 11.084a.683.683 0 00-1.16.126L.075 22.974a.703.703 0 00.63 1.018h8.19a.678.678 0 00.63-.39c1.767-3.65.696-9.203-2.406-12.52zM11.434.386a15.515 15.515 0 00-.906 15.317l3.95 7.9a.703.703 0 00.628.388h8.19a.703.703 0 00.63-1.017L12.63.38a.664.664 0 00-1.196.006z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.atlassian.com', endpoint: '/v1/mcp', oauth: { authorize: 'https://mcp.atlassian.com/v1/authorize', token: 'https://mcp.atlassian.com/v1/token', register: 'https://mcp.atlassian.com/v1/register', revoke: 'https://mcp.atlassian.com/v1/token' } },
  },
  vercel: {
    label: 'Vercel',
    category: 'development',
    website: 'https://vercel.com',
    description: { 'zh-CN': '项目、部署与日志', en: 'Projects, deployments and logs' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="m12 1.608 12 20.784H0Z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.vercel.com', endpoint: '/', oauth: { authorize: 'https://vercel.com/oauth/authorize', token: 'https://api.vercel.com/login/oauth/token', register: 'https://api.vercel.com/login/oauth/register', revoke: 'https://api.vercel.com/login/oauth/token/revoke', userinfo: 'https://api.vercel.com/login/oauth/userinfo' }, scope: 'openid email profile offline_access', clientAuth: 'client_secret_post', resource: 'https://mcp.vercel.com/' },
  },
  supabase: {
    label: 'Supabase',
    category: 'data',
    website: 'https://supabase.com',
    description: { 'zh-CN': '数据库、项目与 Edge Functions', en: 'Databases, projects and Edge Functions' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.supabase.com', oauth: { authorize: 'https://api.supabase.com/v1/oauth/authorize', token: 'https://api.supabase.com/v1/oauth/token', register: 'https://api.supabase.com/platform/oauth/apps/register' }, scope: 'organizations:read projects:read projects:write database:write database:read analytics:read secrets:read edge_functions:read edge_functions:write environment:read environment:write storage:read storage:write', clientAuth: 'client_secret_post', resource: 'https://mcp.supabase.com/mcp' },
  },
  neon: {
    label: 'Neon',
    category: 'data',
    website: 'https://neon.com',
    description: { 'zh-CN': 'Serverless Postgres 数据库与分支', en: 'Serverless Postgres databases and branches' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M24 0V24l-9.365-8.045V24H0V0ZM2.942 21.087h8.751V9.563l9.365 8.204V2.919L2.942 2.914Z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.neon.tech', oauth: { authorize: 'https://mcp.neon.tech/api/authorize', token: 'https://mcp.neon.tech/api/token', register: 'https://mcp.neon.tech/api/register', revoke: 'https://mcp.neon.tech/api/revoke' }, scope: 'read write', resource: 'https://mcp.neon.tech/mcp' },
  },
  netlify: {
    label: 'Netlify',
    category: 'development',
    website: 'https://www.netlify.com',
    description: { 'zh-CN': '站点、部署与环境变量', en: 'Sites, deploys and environment variables' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M6.49 19.04h-.23L5.13 17.9v-.23l1.73-1.71h1.2l.15.15v1.2L6.5 19.04ZM5.13 6.31V6.1l1.13-1.13h.23L8.2 6.68v1.2l-.15.15h-1.2L5.13 6.31Zm9.96 9.09h-1.65l-.14-.13v-3.83c0-.68-.27-1.2-1.1-1.23-.42 0-.9 0-1.43.02l-.07.08v4.96l-.14.14H8.9l-.13-.14V8.73l.13-.14h3.7a2.6 2.6 0 0 1 2.61 2.6v4.08l-.13.14Zm-8.37-2.44H.14L0 12.82v-1.64l.14-.14h6.58l.14.14v1.64l-.14.14Zm17.14 0h-6.58l-.14-.14v-1.64l.14-.14h6.58l.14.14v1.64l-.14.14ZM11.05 6.55V1.64l.14-.14h1.65l.14.14v4.9l-.14.14h-1.65l-.14-.13Zm0 15.81v-4.9l.14-.14h1.65l.14.13v4.91l-.14.14h-1.65l-.14-.14Z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://netlify-mcp.netlify.app', oauth: { authorize: 'https://netlify-mcp.netlify.app/oauth-server/auth', token: 'https://netlify-mcp.netlify.app/oauth-server/token', register: 'https://netlify-mcp.netlify.app/oauth-server/reg' }, scope: 'offline_access read write', resource: 'https://netlify-mcp.netlify.app/mcp' },
  },
  // GitLab's userinfo needs the openid scope, which its MCP does not request; accounts stay unverified.
  gitlab: {
    label: 'GitLab',
    category: 'development',
    website: 'https://gitlab.com',
    description: { 'zh-CN': '代码仓库、Issue 与合并请求', en: 'Repositories, issues and merge requests' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://gitlab.com', endpoint: '/api/v4/mcp', oauth: { authorize: 'https://gitlab.com/oauth/authorize', token: 'https://gitlab.com/oauth/token', register: 'https://gitlab.com/oauth/register', revoke: 'https://gitlab.com/oauth/revoke' }, scope: 'mcp', clientAuth: 'client_secret_post', resource: 'https://gitlab.com/api/v4/mcp' },
  },
  cloudflare: {
    label: 'Cloudflare',
    category: 'development',
    website: 'https://www.cloudflare.com',
    description: { 'zh-CN': 'Workers、KV、R2 与 D1', en: 'Workers, KV, R2 and D1' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M16.5088 16.8447c.1475-.5068.0908-.9707-.1553-1.3154-.2246-.3164-.6045-.499-1.0615-.5205l-8.6592-.1123a.1559.1559 0 0 1-.1333-.0713c-.0283-.042-.0351-.0986-.021-.1553.0278-.084.1123-.1484.2036-.1562l8.7359-.1123c1.0351-.0489 2.1601-.8868 2.5537-1.9136l.499-1.3013c.0215-.0561.0293-.1128.0147-.168-.5625-2.5463-2.835-4.4453-5.5499-4.4453-2.5039 0-4.6284 1.6177-5.3876 3.8614-.4927-.3658-1.1187-.5625-1.794-.499-1.2026.119-2.1665 1.083-2.2861 2.2856-.0283.31-.0069.6128.0635.894C1.5683 13.171 0 14.7754 0 16.752c0 .1748.0142.3515.0352.5273.0141.083.0844.1475.1689.1475h15.9814c.0909 0 .1758-.0645.2032-.1553l.12-.4268zm2.7568-5.5634c-.0771 0-.1611 0-.2383.0112-.0566 0-.1054.0415-.127.0976l-.3378 1.1744c-.1475.5068-.0918.9707.1543 1.3164.2256.3164.6055.498 1.0625.5195l1.8437.1133c.0557 0 .1055.0263.1329.0703.0283.043.0351.1074.0214.1562-.0283.084-.1132.1485-.204.1553l-1.921.1123c-1.041.0488-2.1582.8867-2.5527 1.914l-.1406.3585c-.0283.0713.0215.1416.0986.1416h6.5977c.0771 0 .1474-.0489.169-.126.1122-.4082.1757-.837.1757-1.2803 0-2.6025-2.125-4.727-4.7344-4.727"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://bindings.mcp.cloudflare.com', oauth: { authorize: 'https://bindings.mcp.cloudflare.com/oauth/authorize', token: 'https://bindings.mcp.cloudflare.com/token', register: 'https://bindings.mcp.cloudflare.com/register', revoke: 'https://bindings.mcp.cloudflare.com/token' }, resource: 'https://bindings.mcp.cloudflare.com/mcp' },
  },
  prisma: {
    label: 'Prisma',
    category: 'data',
    website: 'https://www.prisma.io',
    description: { 'zh-CN': 'Prisma Postgres 数据库与迁移', en: 'Prisma Postgres databases and migrations' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M21.8068 18.2848L13.5528.7565c-.207-.4382-.639-.7273-1.1286-.7541-.5023-.0293-.9523.213-1.2062.6253L2.266 15.1271c-.2773.4518-.2718 1.0091.0158 1.4555l4.3759 6.7786c.2608.4046.7127.6388 1.1823.6388.1332 0 .267-.0188.3987-.0577l12.7019-3.7568c.3891-.1151.7072-.3904.8737-.7553s.1633-.7828-.0075-1.1454zm-1.8481.7519L9.1814 22.2242c-.3292.0975-.6448-.1873-.5756-.5194l3.8501-18.4386c.072-.3448.5486-.3996.699-.0803l7.1288 15.138c.1344.2856-.019.6224-.325.7128z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.prisma.io', oauth: { authorize: 'https://auth.prisma.io/authorize', token: 'https://auth.prisma.io/token', register: 'https://auth.prisma.io/register' }, scope: 'workspace:admin offline_access', resource: 'https://mcp.prisma.io/mcp' },
  },
  stripe: {
    label: 'Stripe',
    category: 'payments',
    website: 'https://stripe.com',
    description: { 'zh-CN': '支付、客户、订阅与账单', en: 'Payments, customers, subscriptions and invoices' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.594-7.305h.003z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.stripe.com', endpoint: '/', oauth: { authorize: 'https://access.stripe.com/mcp/oauth2/authorize', token: 'https://access.stripe.com/mcp/oauth2/token', register: 'https://access.stripe.com/mcp/oauth2/register', revoke: 'https://access.stripe.com/mcp/oauth2/revoke' }, scope: 'mcp', resource: 'https://mcp.stripe.com' },
  },
  paypal: {
    label: 'PayPal',
    category: 'payments',
    website: 'https://www.paypal.com',
    description: { 'zh-CN': '订单、发票与交易', en: 'Orders, invoices and transactions' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M15.607 4.653H8.941L6.645 19.251H1.82L4.862 0h7.995c3.754 0 6.375 2.294 6.473 5.513-.648-.478-2.105-.86-3.722-.86m6.57 5.546c0 3.41-3.01 6.853-6.958 6.853h-2.493L11.595 24H6.74l1.845-11.538h3.592c4.208 0 7.346-3.634 7.153-6.949a5.24 5.24 0 0 1 2.848 4.686M9.653 5.546h6.408c.907 0 1.942.222 2.363.541-.195 2.741-2.655 5.483-6.441 5.483H8.714Z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.paypal.com', oauth: { authorize: 'https://mcp.paypal.com/authorize', token: 'https://mcp.paypal.com/token', register: 'https://mcp.paypal.com/register', revoke: 'https://mcp.paypal.com/token' }, scope: 'openid email profile', resource: 'https://mcp.paypal.com/mcp' },
  },
  square: {
    label: 'Square',
    category: 'payments',
    website: 'https://squareup.com',
    description: { 'zh-CN': '支付、订单、商品与客户', en: 'Payments, orders, catalog and customers' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M4.01 0A4.01 4.01 0 000 4.01v15.98c0 2.21 1.8 4 4.01 4.01h15.98C22.2 24 24 22.2 24 19.99V4A4.01 4.01 0 0019.99 0H4zm1.62 4.36h12.74c.7 0 1.26.57 1.26 1.27v12.74c0 .7-.56 1.27-1.26 1.27H5.63c-.7 0-1.26-.57-1.26-1.27V5.63a1.27 1.27 0 011.26-1.27zm3.83 4.35a.73.73 0 00-.73.73v5.09c0 .4.32.72.72.72h5.1a.73.73 0 00.73-.72V9.44a.73.73 0 00-.73-.73h-5.1Z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.squareup.com', oauth: { authorize: 'https://mcp.squareup.com/authorize', token: 'https://mcp.squareup.com/token', register: 'https://mcp.squareup.com/register', revoke: 'https://mcp.squareup.com/token' }, resource: 'https://mcp.squareup.com/mcp' },
  },
  clickup: {
    label: 'ClickUp',
    category: 'collaboration',
    website: 'https://clickup.com',
    description: { 'zh-CN': '任务、列表与文档', en: 'Tasks, lists and docs' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.clickup.com', oauth: { authorize: 'https://mcp.clickup.com/oauth/authorize', token: 'https://mcp.clickup.com/oauth/token', register: 'https://mcp.clickup.com/oauth/register' }, scope: 'read write', resource: 'https://mcp.clickup.com/mcp' },
  },
  monday: {
    label: 'monday.com',
    category: 'collaboration',
    website: 'https://monday.com',
    description: { 'zh-CN': '看板、项目与工作流', en: 'Boards, projects and workflows' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="22" height="22" rx="6" fill="none" stroke="currentColor" stroke-width="2"/><text x="12" y="16.6" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="13" font-weight="700">m</text></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.monday.com', oauth: { authorize: 'https://auth.monday.com/oauth2/authorize', token: 'https://auth.monday.com/oauth_ms/oauth/token', register: 'https://auth.monday.com/oauth_ms/oauth/register', revoke: 'https://auth.monday.com/oauth_ms/oauth/revoke' }, clientAuth: 'client_secret_post', resource: 'https://mcp.monday.com/mcp' },
  },
  airtable: {
    label: 'Airtable',
    category: 'collaboration',
    website: 'https://airtable.com',
    description: { 'zh-CN': '数据表、记录与工作区', en: 'Bases, records and workspaces' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M11.992 1.966c-.434 0-.87.086-1.28.257L1.779 5.917c-.503.208-.49.908.012 1.116l8.982 3.558a3.266 3.266 0 0 0 2.454 0l8.982-3.558c.503-.196.503-.908.012-1.116l-8.957-3.694a3.255 3.255 0 0 0-1.272-.257zM23.4 8.056a.589.589 0 0 0-.222.045l-10.012 3.877a.612.612 0 0 0-.38.564v8.896a.6.6 0 0 0 .821.552L23.62 18.1a.583.583 0 0 0 .38-.551V8.653a.6.6 0 0 0-.6-.596zM.676 8.095a.644.644 0 0 0-.48.19C.086 8.396 0 8.53 0 8.69v8.355c0 .442.515.737.908.54l6.27-3.006.307-.147 2.969-1.436c.466-.22.43-.908-.061-1.092L.883 8.138a.57.57 0 0 0-.207-.044z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.airtable.com', oauth: { authorize: 'https://airtable.com/oauth2/v1/authorize', token: 'https://airtable.com/oauth2/v1/token', register: 'https://airtable.com/oauth2/v1/register' }, scope: 'data.records:read data.records:write schema.bases:read schema.bases:write data.recordComments:read data.recordComments:write workspacesAndBases:read', resource: 'https://mcp.airtable.com' },
  },
  todoist: {
    label: 'Todoist',
    category: 'collaboration',
    website: 'https://todoist.com',
    description: { 'zh-CN': '任务、项目与提醒', en: 'Tasks, projects and reminders' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M21 0H3C1.35 0 0 1.35 0 3v3.858s3.854 2.24 4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.608 8.136-4.675.279-.161.58-.107.748-.01.164.097.606.348.84.48.232.134.221.502.013.622l-9.712 5.59c-.346.2-.69.204-1.048.002C3.478 10.907.998 9.463 0 8.882v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.008.164.096.606.347.84.48.232.133.221.5.013.62-.208.121-9.288 5.346-9.712 5.59-.346.2-.69.205-1.048.002C3.478 14.951.998 13.506 0 12.926v2.02l4.098 2.38c.31.18.694.177 1.004 0 .26-.147 8.02-4.609 8.136-4.676.279-.16.58-.106.748-.009.164.097.606.348.84.48.232.133.221.502.013.622l-9.712 5.59c-.346.199-.69.204-1.048.001C3.478 18.994.998 17.55 0 16.97V21c0 1.65 1.35 3 3 3h18c1.65 0 3-1.35 3-3V3c0-1.65-1.35-3-3-3z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://ai.todoist.net', oauth: { authorize: 'https://todoist.com/oauth/authorize', token: 'https://todoist.com/oauth/access_token', register: 'https://todoist.com/oauth/register', revoke: 'https://todoist.com/api/v1/revoke', userinfo: 'https://todoist.com/api/v1/user' }, scope: 'data:read_write', resource: 'https://ai.todoist.net/mcp',
      // Token revocation accepts only Basic client credentials.
      clientAuth: 'client_secret_basic' },
  },
  miro: {
    label: 'Miro',
    category: 'design',
    website: 'https://miro.com',
    description: { 'zh-CN': '白板、便签与图表', en: 'Boards, sticky notes and diagrams' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M17.392 0H13.9L17 4.808 10.444 0H6.949l3.102 6.3L3.494 0H0l3.05 8.131L0 24h3.494L10.05 6.985 6.949 24h3.494L17 5.494 13.899 24h3.493L24 3.672 17.392 0z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.miro.com', endpoint: '/', oauth: { authorize: 'https://mcp.miro.com/authorize', token: 'https://mcp.miro.com/token', register: 'https://mcp.miro.com/register' }, scope: 'boards:read boards:write openid email', clientAuth: 'client_secret_post', resource: 'https://mcp.miro.com/' },
  },
  canva: {
    label: 'Canva',
    category: 'design',
    website: 'https://www.canva.com',
    description: { 'zh-CN': '设计、模板与素材', en: 'Designs, templates and assets' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="22" height="22" rx="6" fill="none" stroke="currentColor" stroke-width="2"/><text x="12" y="16.6" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="13" font-weight="700">C</text></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.canva.com', oauth: { authorize: 'https://mcp.canva.com/authorize', token: 'https://mcp.canva.com/token', register: 'https://mcp.canva.com/register', revoke: 'https://mcp.canva.com/token' }, scope: 'profile:read design:meta:read design:content:write design:content:read folder:read folder:write brandtemplate:content:read brandtemplate:meta:read brandtemplate:content:write comment:write comment:read asset:read asset:write brandkit:read help:answers:read help:answers:write', resource: 'https://mcp.canva.com/mcp' },
  },
  intercom: {
    label: 'Intercom',
    category: 'collaboration',
    website: 'https://www.intercom.com',
    description: { 'zh-CN': '客服会话、联系人与工单', en: 'Conversations, contacts and tickets' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M21 0H3C1.343 0 0 1.343 0 3v18c0 1.658 1.343 3 3 3h18c1.658 0 3-1.342 3-3V3c0-1.657-1.342-3-3-3zm-5.801 4.399c0-.44.36-.8.802-.8.44 0 .8.36.8.8v10.688c0 .442-.36.801-.8.801-.443 0-.802-.359-.802-.801V4.399zM11.2 3.994c0-.44.357-.799.8-.799s.8.359.8.799v11.602c0 .44-.357.8-.8.8s-.8-.36-.8-.8V3.994zm-4 .405c0-.44.359-.8.799-.8.443 0 .802.36.802.8v10.688c0 .442-.36.801-.802.801-.44 0-.799-.359-.799-.801V4.399zM3.199 6c0-.442.36-.8.802-.8.44 0 .799.358.799.8v7.195c0 .441-.359.8-.799.8-.443 0-.802-.36-.802-.8V6zM20.52 18.202c-.123.105-3.086 2.593-8.52 2.593-5.433 0-8.397-2.486-8.521-2.593-.335-.288-.375-.792-.086-1.128.285-.334.79-.375 1.125-.09.047.041 2.693 2.211 7.481 2.211 4.848 0 7.456-2.186 7.479-2.207.334-.289.839-.25 1.128.086.289.336.25.84-.086 1.128zm.281-5.007c0 .441-.36.8-.801.8-.441 0-.801-.36-.801-.8V6c0-.442.361-.8.801-.8.441 0 .801.357.801.8v7.195z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.intercom.com', oauth: { authorize: 'https://mcp.intercom.com/authorize', token: 'https://mcp.intercom.com/token', register: 'https://mcp.intercom.com/register', revoke: 'https://mcp.intercom.com/token' } },
  },
  webflow: {
    label: 'Webflow',
    category: 'design',
    website: 'https://webflow.com',
    description: { 'zh-CN': '站点、CMS 集合与页面', en: 'Sites, CMS collections and pages' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="m24 4.515-7.658 14.97H9.149l3.205-6.204h-.144C9.566 16.713 5.621 18.973 0 19.485v-6.118s3.596-.213 5.71-2.435H0V4.515h6.417v5.278l.144-.001 2.622-5.277h4.854v5.244h.144l2.72-5.244H24Z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.webflow.com', oauth: { authorize: 'https://mcp.webflow.com/oauth/authorize', token: 'https://mcp.webflow.com/oauth/token', register: 'https://mcp.webflow.com/oauth/register', revoke: 'https://mcp.webflow.com/oauth/token' }, resource: 'https://mcp.webflow.com/mcp' },
  },
  wix: {
    label: 'Wix',
    category: 'design',
    website: 'https://www.wix.com',
    description: { 'zh-CN': '站点、商店与预约', en: 'Sites, stores and bookings' },
    icon: '<svg aria-hidden="true" fill="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="m0 7.354 2.113 9.292h.801a1.54 1.54 0 0 0 1.506-1.218l1.351-6.34a.171.171 0 0 1 .167-.137c.08 0 .15.058.167.137l1.352 6.34a1.54 1.54 0 0 0 1.506 1.218h.805l2.113-9.292h-.565c-.62 0-1.159.43-1.296 1.035l-1.26 5.545-1.106-5.176a1.76 1.76 0 0 0-2.19-1.324c-.639.176-1.113.716-1.251 1.365l-1.094 5.127-1.26-5.537A1.33 1.33 0 0 0 .563 7.354H0zm13.992 0a.951.951 0 0 0-.951.95v8.342h.635a.952.952 0 0 0 .951-.95V7.353h-.635zm1.778 0 3.158 4.66-3.14 4.632h1.325c.368 0 .712-.181.918-.486l1.756-2.59a.12.12 0 0 1 .197 0l1.754 2.59c.206.305.55.486.918.486h1.326l-3.14-4.632L24 7.354h-1.326c-.368 0-.712.181-.918.486l-1.772 2.617a.12.12 0 0 1-.197 0L18.014 7.84a1.108 1.108 0 0 0-.918-.486H15.77z"/></svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.wix.com', oauth: { authorize: 'https://mcp.wix.com/authorize', token: 'https://mcp.wix.com/token', register: 'https://mcp.wix.com/register', revoke: 'https://mcp.wix.com/token' }, scope: 'offline_access', resource: 'https://mcp.wix.com/mcp' },
  },
} satisfies Record<string, ConnectorDefinition>;

export type ConnectorName = keyof typeof connectorCatalog;
export const connectorNames = Object.keys(connectorCatalog) as [ConnectorName, ...ConnectorName[]];
export const connector = (name: ConnectorName): ConnectorDefinition => connectorCatalog[name];
