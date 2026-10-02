import { UpstreamError } from '../errors.js';
import type { HostedMcp } from './hosted-mcp.js';
import type { ConnectorRuntime, Credentials, Identity } from './index.js';
import { githubAccess } from './github-access.js';
import { linearIdentity, notionIdentity } from './mcp-identity.js';

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
}
export interface McpSpec {
  origin: string;
  /** MCP endpoint path on origin. Defaults to /mcp. */
  endpoint?: string;
  /** Extra authorize query parameters, e.g. scope or prompt. */
  authorizeParams?: Record<string, string>;
  /** Send the RFC 8707 resource indicator (origin + endpoint) on token requests and authorize. */
  resource?: boolean;
}
export interface ConnectorDefinition {
  label: string;
  /** Official product homepage linked from the admin card. */
  website: string;
  /** Inline SVG or short text rendered inside the connector badge. */
  icon: string;
  /** One-line capability summary shown on the admin card. */
  description: string;
  auth: 'mcp' | 'github_app';
  mcp: McpSpec;
  /** Required for `auth: 'mcp'`: resolve the account from the token response. */
  identify?: (mcp: HostedMcp, credential: Credentials, raw: any) => Promise<Identity>;
  /** Refresh display names for existing connections without changing account identity. */
  refreshIdentity?: (mcp: HostedMcp, credential: Credentials, expected: {account_id: string; workspace_id?: string}) => Promise<Record<string, unknown>>;
  access?: ConnectorAccess;
}

const checked = <T extends object>(identity: T) => ({...identity, identity_checked_at: new Date().toISOString()});

export const connectorCatalog = {
  notion: {
    label: 'Notion',
    website: 'https://www.notion.com',
    description: '页面、数据库与工作区搜索',
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
    website: 'https://github.com',
    description: '仓库、Issue 与 Pull Request',
    icon: '<svg aria-hidden="true" fill="currentColor" fill-rule="evenodd" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 0c6.63 0 12 5.276 12 11.79-.001 5.067-3.29 9.567-8.175 11.187-.6.118-.825-.25-.825-.56 0-.398.015-1.665.015-3.242 0-1.105-.375-1.813-.81-2.181 2.67-.295 5.475-1.297 5.475-5.822 0-1.297-.465-2.344-1.23-3.169.12-.295.54-1.503-.12-3.125 0 0-1.005-.324-3.3 1.209a11.32 11.32 0 00-3-.398c-1.02 0-2.04.133-3 .398-2.295-1.518-3.3-1.209-3.3-1.209-.66 1.622-.24 2.83-.12 3.125-.765.825-1.23 1.887-1.23 3.169 0 4.51 2.79 5.527 5.46 5.822-.345.294-.66.81-.765 1.577-.69.31-2.415.81-3.495-.973-.225-.354-.9-1.223-1.845-1.209-1.005.015-.405.56.015.781.51.28 1.095 1.327 1.23 1.666.24.663 1.02 1.93 4.035 1.385 0 .988.015 1.916.015 2.196 0 .31-.225.664-.825.56C3.303 21.374-.003 16.867 0 11.791 0 5.276 5.37 0 12 0z"></path></svg>',
    auth: 'github_app',
    mcp: { origin: 'https://api.githubcopilot.com', endpoint: '/mcp/x/all' },
    access: githubAccess,
  },
  linear: {
    label: 'Linear',
    website: 'https://linear.app',
    description: 'Issue、项目与团队协作',
    // Official logomark: https://linear.app/brand (Linear-Brand-Assets.zip?v=3, logo-dark.svg).
    icon: '<svg aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg" fill="#222326" width="200" height="200" viewBox="0 0 100 100"> <path d="M1.22541 61.5228c-.2225-.9485.90748-1.5459 1.59638-.857L39.3342 97.1782c.6889.6889.0915 1.8189-.857 1.5964C20.0515 94.4522 5.54779 79.9485 1.22541 61.5228ZM.00189135 46.8891c-.01764375.2833.08887215.5599.28957165.7606L52.3503 99.7085c.2007.2007.4773.3075.7606.2896 2.3692-.1476 4.6938-.46 6.9624-.9259.7645-.157 1.0301-1.0963.4782-1.6481L2.57595 39.4485c-.55186-.5519-1.49117-.2863-1.648174.4782-.465915 2.2686-.77832 4.5932-.92588465 6.9624ZM4.21093 29.7054c-.16649.3738-.08169.8106.20765 1.1l64.77602 64.776c.2894.2894.7262.3742 1.1.2077 1.7861-.7956 3.5171-1.6927 5.1855-2.684.5521-.328.6373-1.0867.1832-1.5407L8.43566 24.3367c-.45409-.4541-1.21271-.3689-1.54074.1832-.99132 1.6684-1.88843 3.3994-2.68399 5.1855ZM12.6587 18.074c-.3701-.3701-.393-.9637-.0443-1.3541C21.7795 6.45931 35.1114 0 49.9519 0 77.5927 0 100 22.4073 100 50.0481c0 14.8405-6.4593 28.1724-16.7199 37.3375-.3903.3487-.984.3258-1.3542-.0443L12.6587 18.074Z" /> </svg>',
    auth: 'mcp',
    mcp: { origin: 'https://mcp.linear.app', authorizeParams: { scope: 'read write', prompt: 'consent' }, resource: true },
    identify: async (mcp, credential) => checked(await linearIdentity(mcp, credential)),
    refreshIdentity: (mcp, credential, expected) => linearIdentity(mcp, credential, expected),
  },
} satisfies Record<string, ConnectorDefinition>;

export type ConnectorName = keyof typeof connectorCatalog;
export const connectorNames = Object.keys(connectorCatalog) as [ConnectorName, ...ConnectorName[]];
export const connector = (name: ConnectorName): ConnectorDefinition => connectorCatalog[name];
