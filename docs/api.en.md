# Connany API Docs

Connect agent products to Notion, GitHub and Linear. Connany manages user authorization, encrypted credentials, refresh and tool execution.

## Quick start

Service origin: `{{BASE_URL}}`. API paths start with /v1. SDK baseUrl must be the origin without /v1.

Create a project for your agent under Projects in the console and store its API key in your agent backend. Derive external_user_id from your authenticated user session, never from model arguments.

```bash
export CONNANY_BASE_URL='{{BASE_URL}}'
export CONNANY_API_KEY='cn_live_REPLACE_ME'
curl "$CONNANY_BASE_URL/v1/connectors/notion/sessions" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"external_user_id":"user_123"}'
```

Show connect_url to the user. They authorize in their browser while your backend polls the session every 5 seconds. After obtaining connection_id, list tools and call one. GitHub repository access also requires an App installation.

## Concepts

| Concept | Description |
| --- | --- |
| Connector | A third-party integration supported by Connany, such as notion, github, linear or sentry. Administrators configure and enable connectors once; every project shares them |
| Project | An agent product integrated with Connany. User connections, authorization sessions and events belong to a project |
| API key | A credential for one project. A project can have up to 2 active keys, each revocable on its own |
| User (external_user_id) | Your product's user ID, unique within a project: the same ID in different projects is a different user |
| Connection | An account a user authorized on a connector |

## Authentication and conventions

All /v1 endpoints require `Authorization: Bearer cn_live_...`. Never expose keys to browsers or model prompts. /docs and /health are public.

The API key determines which project a request belongs to. To rotate, create a new key, deploy it, then revoke the old one; both work in the meantime. Connections belong to the project, so rotation does not affect them. Revoked keys stop working immediately. Disabling a project rejects all of its keys; in-flight requests may finish.

Send JSON with Content-Type: application/json. Maximum request body: 32 KB. Each project has a fixed-window limit of 120 requests per minute, including polling and discovery. Follow Retry-After on 429 responses.

Timestamps are ISO 8601 strings. Nullable fields use null. X-Request-Id identifies requests for support. URL-encode path and query values. Connany exposes REST and a server-side SDK; using upstream MCP does not mean Connany exposes a client-facing /mcp endpoint.

## Connectors

`GET /v1/connectors`

Returns the connectors an administrator has enabled, with their categories, ready to render grouped "connect an account" options.

| Query parameter | Type | Description |
| --- | --- | --- |
| lang | string, optional | Language of returned text: en, zh-CN or zh-HK (Traditional Chinese, Hong Kong). Without it the Accept-Language header decides: zh-TW, zh-MO and zh-Hant return zh-HK, other Chinese tags return zh-CN; English otherwise |

Request example:

```bash
curl "$CONNANY_BASE_URL/v1/connectors?lang=en" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

Response example:

```json
{"categories":[{"name":"collaboration","title":"Collaboration"},{"name":"development","title":"Code & deploy"},{"name":"analytics","title":"Monitoring & analytics"}],"data":[{"name":"notion","title":"Notion","category":"collaboration","description":"Pages, databases and workspace search","avatar_url":"{{BASE_URL}}/connectors/notion/avatar.svg","tools_synced_at":"2026-09-26T10:00:00.000Z"},{"name":"github","title":"GitHub","category":"development","description":"Repositories, issues and pull requests","avatar_url":"{{BASE_URL}}/connectors/github/avatar.svg","tools_synced_at":"2026-09-26T10:00:00.000Z"},{"name":"sentry","title":"Sentry","category":"analytics","description":"Errors, issues and performance","avatar_url":"{{BASE_URL}}/connectors/sentry/avatar.svg","tools_synced_at":null}]}
```

| Field | Description |
| --- | --- |
| categories | Categories that contain an enabled connector, in recommended display order. name is one of collaboration, development, data, analytics, payments or design; title follows the language |
| data[].name | Connector name, used in the authorization session path /v1/connectors/{name}/sessions (such as notion, sentry or stripe; rely on this endpoint for the full list) |
| data[].title | Brand name; not translated |
| data[].category | Category, matching a name in categories |
| data[].description | One-line summary in the requested language |
| data[].avatar_url | Public SVG icon usable directly in an img tag |
| data[].tools_synced_at | When the tool catalog was last synced; null if never |

The Content-Language response header states the language used. A listed connector does not mean the user is connected.

## Create an authorization session

`POST /v1/connectors/{name}/sessions` → 201

The name path segment is a connector name returned by `GET /v1/connectors`, such as notion, github or linear. Unknown names return 404 connector_not_found; disabled connectors return 503.

| JSON field | Type | Description |
| --- | --- | --- |
| external_user_id | string, required | Stable user ID within your product; 1–200 characters |
| return_url | string, optional | Full post-authorization return URL; up to 2048 characters |

Request example:

```bash
curl -X POST "$CONNANY_BASE_URL/v1/connectors/notion/sessions" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"external_user_id":"user_123","return_url":"https://agent.example/settings/connections"}'
```

Response example:

```json
{"id":"cs_example","status":"pending","connector":"notion","connect_url":"{{BASE_URL}}/connect/EXAMPLE_TOKEN","expires_at":"2026-09-26T13:00:00.000Z"}
```

Show connect_url to the user to authorize in their browser. Links expire in 15 minutes and can start authorization only once. Do not log or publish link tokens. Use a new session for another account. The same upstream account and workspace for the same project, user and connector app may reuse an existing connection.

The key-holding backend supplies return_url. HTTPS, loopback HTTP and native app schemes are supported. Credentials, fragments and executable schemes are rejected. Use a fixed URL you control; do not trust arbitrary browser input.

## Poll authorization

`GET /v1/connectors/{name}/sessions/{id}?external_user_id=user_123`

name is the connector used to create the session and id is the session ID. external_user_id is required and must own the session in the current project. A connector that does not match the session returns 404.

Request example:

```bash
curl "$CONNANY_BASE_URL/v1/connectors/notion/sessions/cs_example?external_user_id=user_123" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

Response example:

```json
{"id":"cs_example","connector":"notion","external_user_id":"user_123","status":"connected","connection_id":"conn_example","error_code":null,"expires_at":"2026-09-26T13:00:00.000Z"}
```

| status | Handling |
| --- | --- |
| pending / authorizing / processing | Keep polling while authorization is in progress |
| connected | Save connection_id and stop polling |
| error | Stop polling, show error_code and offer another connection attempt |
| expired | Stop polling and create a new session |

With a return_url, the browser is redirected there with connany_session_id when authorization ends; failures also add connany_status=error and connany_error (such as access_denied). Without a return_url, a hosted completion or error page is shown. A redirect is not proof of success: query the session from your backend under the authenticated user. Complete authorization in the same browser so callback cookies are preserved.

## List and retrieve connections

`GET /v1/connections`

| Query parameter | Type | Description |
| --- | --- | --- |
| external_user_id | string, required | Current user ID |
| connector | string, optional | Connector name, such as notion / github / sentry |
| status | string, optional | connected / reauth_required / revoked |
| limit | integer, optional | 1–100; default 50 |
| after | string, optional | Previous next_cursor |

Request example:

```bash
curl "$CONNANY_BASE_URL/v1/connections?external_user_id=user_123&status=connected&limit=20" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

Response example:

```json
{"data":[{"id":"conn_notion_example","external_user_id":"user_123","connector":"notion","status":"connected","identity":{"account_id":"user_example","account_name":"Mike","workspace_id":"workspace_example","workspace_name":"My workspace"},"needs_access":false,"expires_at":"2026-09-26T13:00:00.000Z","revocation_status":"not_requested","created_at":"2026-09-26T12:00:00.000Z","updated_at":"2026-09-26T12:00:00.000Z"},{"id":"conn_github_example","external_user_id":"user_123","connector":"github","status":"reauth_required","identity":{"account_id":"12345678","account_name":"mike-dev","installation_count":1,"needs_installation":false,"installations":[{"id":87654321,"account":"example-org"}]},"needs_access":false,"expires_at":null,"revocation_status":"not_requested","created_at":"2026-09-25T08:00:00.000Z","updated_at":"2026-09-26T09:30:00.000Z"}],"next_cursor":null}
```

Keep filters unchanged between pages and pass next_cursor as after; null ends pagination. All statuses are returned by default. Status is a local record: external revocation may only be detected on the next upstream request.

`GET /v1/connections/{id}?external_user_id=user_123`

Retrieves one connection.

Request example:

```bash
curl "$CONNANY_BASE_URL/v1/connections/conn_example?external_user_id=user_123" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

Response example:

```json
{"id":"conn_example","external_user_id":"user_123","connector":"notion","status":"connected","identity":{"account_id":"user_example","account_name":"Mike","workspace_id":"workspace_example","workspace_name":"My workspace"},"needs_access":false,"expires_at":"2026-09-26T13:00:00.000Z","revocation_status":"not_requested","created_at":"2026-09-26T12:00:00.000Z","updated_at":"2026-09-26T12:00:00.000Z"}
```

Workspace fields and other identity metadata depend on the connector and may be absent. expires_at is the upstream credential expiration and may be refreshed automatically; it is not necessarily the connection expiration. Tokens are never returned.

## Check and reconnect

`POST /v1/connections/{id}/check`

| JSON field | Type | Description |
| --- | --- | --- |
| external_user_id | string, required | Current user ID |

Request example:

```bash
curl -X POST "$CONNANY_BASE_URL/v1/connections/conn_example/check" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"external_user_id":"user_123"}'
```

Response example:

```json
{"connection_id":"conn_example","connector":"notion","checked_at":"2026-09-26T12:30:00.000Z","tool_count":20,"request_id":"req_example"}
```

Checks ownership, refreshes credentials if needed and reads the upstream tool list, which also updates the connector's tool catalog. No business tool is executed. Success does not guarantee access to a specific resource or write permission. Run on demand rather than continuously polling every connection.

`POST /v1/connections/{id}/reconnect` → 201

| JSON field | Type | Description |
| --- | --- | --- |
| external_user_id | string, required | Current user ID |
| return_url | string, optional | Same rules as session creation |

Request example:

```bash
curl -X POST "$CONNANY_BASE_URL/v1/connections/conn_example/reconnect" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"external_user_id":"user_123","return_url":"https://agent.example/settings/connections"}'
```

Response example:

```json
{"id":"cs_reconnect_example","status":"pending","connector":"notion","connect_url":"{{BASE_URL}}/connect/EXAMPLE_TOKEN","expires_at":"2026-09-26T13:00:00.000Z"}
```

Returns a new authorization session; poll it as described in Poll authorization. The original account and workspace must authorize; otherwise account_mismatch is returned. Success preserves connection_id. Revoked connections and legacy REST-to-MCP migrations require a new connection instead.

## Disconnect

`DELETE /v1/connections/{id}?external_user_id=user_123`

Request example:

```bash
curl -X DELETE "$CONNANY_BASE_URL/v1/connections/conn_example?external_user_id=user_123" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

Response example:

```json
{"id":"conn_example","external_user_id":"user_123","connector":"notion","status":"revoked","identity":{"account_id":"user_example","account_name":"Mike","workspace_id":"workspace_example","workspace_name":"My workspace"},"needs_access":false,"expires_at":null,"revocation_status":"succeeded","created_at":"2026-09-26T12:00:00.000Z","updated_at":"2026-09-26T14:00:00.000Z"}
```

Returns the disconnected connection. First marks it revoked locally to block subsequent calls, then attempts upstream revocation. revocation_status can be pending, succeeded or failed; not_requested means revocation has not been requested. A concurrent in-flight call may finish first.

Repeat the same DELETE to retry failed revocation. Local access remains blocked. Revoking a shared upstream app grant may affect other connections for the same account. No automatic revocation retry worker is provided.

## Access

`GET /v1/connections/{id}/access`

Some connectors require users to grant resource access separately after OAuth. For example, GitHub requires installing the App into a personal account or organization and selecting repositories. This endpoint returns the access a connection currently has and where to grant more. Every connector uses the same endpoint: connectors without this step, such as Notion and Linear, return an empty list with a null add_url.

| Query parameter | Type | Description |
| --- | --- | --- |
| external_user_id | string, required | Current user ID |
| page | integer, optional | 1–10000; default 1 |
| limit | integer, optional | 1–100; default 20 |

Request example:

```bash
curl "$CONNANY_BASE_URL/v1/connections/conn_github_example/access?external_user_id=user_123" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

Response example:

```json
{"add_url":"https://github.com/apps/YOUR_APP/installations/new","total":1,"next_page":null,"data":[{"id":"87654321","type":"organization","name":"example-org","selection":"selected","suspended":false,"manage_url":"https://github.com/organizations/example-org/settings/installations/87654321"}]}
```

| Field | Description |
| --- | --- |
| add_url | Where users grant more access in their browser; null when the connector has no such step |
| data[].type | Scope type; GitHub uses organization or user |
| data[].selection | all for every resource, selected for a subset |
| data[].manage_url | Where to change this scope, possibly requiring organization admin rights; null when unavailable |

needs_access on a connection is true when no resource access was granted at authorization time; prompt the user to open add_url. It is set at authorization; after users grant access, rely on this endpoint. Organization administrators may need to approve. Query again afterward, and do not treat an empty list as an authorization failure. Read specific resources through tools: on GitHub, call github.repositories.list with installation_id (data[].id), page and limit.

## List connection tools

`GET /v1/connections/{id}/tools`

Returns the tools the user can use now through this connection, for agent conversations: users authorize a connector first, then the agent gives that connection's tools to the model. The connection must belong to the user and be connected; otherwise 404 or 409 (reauth_required / connection_revoked) is returned, so you can prompt the user to reconnect.

| Query parameter | Type | Description |
| --- | --- | --- |
| external_user_id | string, required | Backend-bound user ID |
| query | string, optional | Search name or description; max 500 characters; exact names rank first |
| read_only | string, optional | true: read-only; false: other tools; omitted: both |
| limit | integer, optional | 1–100; default 20 |
| offset | integer, optional | Nonnegative; default 0 |

Request example:

```bash
curl "$CONNANY_BASE_URL/v1/connections/conn_github_example/tools?external_user_id=user_123&read_only=true" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

Response example:

```json
{"data":[{"name":"github.get_me","connector":"github","description":"Get details of the authenticated GitHub user.","read_only":true,"required_permissions":["GitHub MCP: current user access"],"input_schema":{"type":"object","properties":{}}}],"total":1,"next_offset":null}
```

Tools come from the connector's tool catalog (see Tool catalog below) without an upstream request each time. If the connector has no catalog yet, it is read once with this connection's credential and saved. A null next_offset ends pagination. Follow the returned input_schema and do not hard-code tool counts or parameters. Missing read-only hints are treated as non-read-only. Permission descriptions do not prove current resource access. A specific account may be unable to use a tool because of its plan or organization policy; the call then returns an upstream error.

## Call a tool

`POST /v1/connections/{id}/tools/{name}/call`

name is the full tool name returned when listing tools, such as github.get_me; up to 150 characters.

| JSON field | Type | Description |
| --- | --- | --- |
| external_user_id | string, required | Backend-bound user ID |
| input | object, optional | Arguments following input_schema; default {} |

Request example:

```bash
curl -X POST "$CONNANY_BASE_URL/v1/connections/conn_github_example/tools/github.get_me/call" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"external_user_id":"user_123","input":{}}'
```

Response example:

```json
{"data":{"content":[{"type":"text","text":"{\"login\":\"mike-dev\",\"id\":12345678}"}],"structuredContent":{"login":"mike-dev","id":12345678}},"request_id":"req_example"}
```

data is the upstream tool result. Official MCP results preserve content, structuredContent and other result fields. Compatibility GitHub REST tools (github.installations.list, github.repositories.list and others) return REST data; parse them separately. Upstream tool failures are returned as errors.

API keys are not inherently read-only. Enforce write policies in your backend; do not rely on a model-supplied confirmed flag. A timed-out write may have succeeded upstream. Do not blindly retry writes. Unified Idempotency-Key support is not available.

## Tool catalog

`GET /v1/tools`

Returns the tools every enabled connector offers, independent of users; only an API key is needed. Use it to show capabilities before users connect or to preview tools during development. In conversations, use List connection tools.

| Query parameter | Type | Description |
| --- | --- | --- |
| connector | string, optional | Only tools of one connector, such as notion / github / sentry |
| query | string, optional | Search name or description; max 500 characters; exact names rank first |
| read_only | string, optional | true: read-only; false: other tools; omitted: both |
| limit | integer, optional | 1–100; default 20 |
| offset | integer, optional | Nonnegative; default 0 |

Request example:

```bash
curl "$CONNANY_BASE_URL/v1/tools?connector=github&query=get_me&limit=5&read_only=true" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

Response example:

```json
{"data":[{"name":"github.get_me","connector":"github","description":"Get details of the authenticated GitHub user.","read_only":true,"required_permissions":["GitHub MCP: current user access"],"input_schema":{"type":"object","properties":{}}}],"total":1,"next_offset":null}
```

A null next_offset ends pagination. The catalog comes from the official upstream MCP server, which lists tools only to signed-in users. It is updated when an administrator runs Sync tool catalog in the console, or when any user authorizes or checks a connection. Connectors that were never synced have no tools, and tools_synced_at is null in GET /v1/connectors.

The catalog is per connector: a specific account may be unable to use a tool because of its plan or organization policy, in which case the call returns an upstream error. Follow the returned input_schema and do not hard-code tool counts or parameters. Missing read-only hints are treated as non-read-only. Permission descriptions do not prove current resource access. GitHub compatibility REST tools (github.installations.list and others) are not in the catalog but can be called directly.

## Poll events

`GET /v1/events`

Returns events for every user in the current project, so your backend polls a single stream. Connany has no push webhooks; changes your backend did not initiate, such as an administrator disconnecting a connection in the console or a user revoking access on the platform, are only visible as events.

| Query parameter | Type | Description |
| --- | --- | --- |
| after | string, optional | Previous next_cursor; up to 18 digits; default 0 |
| external_user_id | string, optional | Only events of one user |
| connection_id | string, optional | Only events of one connection |
| type | string, optional | Only one event type, such as connection.revoked |
| limit | integer, optional | 1–100; default 100 |

Request example:

```bash
curl "$CONNANY_BASE_URL/v1/events?after=0" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

Response example:

```json
{"data":[{"seq":"12","type":"connection.connected","external_user_id":"user_123","connection_id":"conn_example","data":{"connector":"notion"},"created_at":"2026-09-26T12:00:00.000Z"},{"seq":"13","type":"connection.reauth_required","external_user_id":"user_456","connection_id":"conn_other","data":{},"created_at":"2026-09-26T12:05:00.000Z"}],"next_cursor":"13"}
```

Events are ordered by seq. Store next_cursor and pass it as after on the next poll to continue without duplicates or gaps; on an empty page, keep the cursor and poll again later. Every event includes external_user_id so your backend can route it to the right user.

| type | When | Suggested handling |
| --- | --- | --- |
| connection.connected | A user completed authorization | Refresh the account list |
| connection.failed | Authorization failed or was cancelled; data has session_id and error_code | Offer a retry |
| connection.reauth_required | A tool call or token refresh found the authorization invalid | Prompt the user to reconnect |
| connection.revoked | A connection was disconnected, including by an administrator | Remove the account from your UI |
| tool.succeeded / tool.failed | Every tool call; data.tool holds the tool name | Audit and troubleshooting |

Events belong to the current project and exclude resource content and credentials. Handle unfamiliar event types gracefully.

## Custom MCP servers

A user can add a remote MCP server that is not in the catalog by its URL. It then becomes a connector that belongs to that user alone, named like `mcp_1a2b3c4d5e`, and is used like any connector: `POST /v1/connectors/{name}/sessions` to authorize, then list tools, call tools and disconnect.

`POST /v1/custom-connectors`

```bash
curl -X POST "$CONNANY_BASE_URL/v1/custom-connectors" \
  -H "Authorization: Bearer $CONNANY_API_KEY" -H "Content-Type: application/json" \
  -d '{"external_user_id":"user_123","url":"https://mcp.example.com/mcp"}'
```

Response (201):

```json
{"name":"mcp_1a2b3c4d5e","title":"Example","url":"https://mcp.example.com/mcp","website":"https://mcp.example.com","avatar_url":"https://connect.example.com/connectors/mcp_1a2b3c4d5e/avatar.svg","created_at":"2026-10-09T08:00:00.000Z"}
```

- Connany discovers authorization as the MCP authorization spec describes: an unauthenticated `initialize` returns 401 with protected resource metadata (RFC 9728), then authorization server metadata (RFC 8414), then dynamic client registration (RFC 7591). Only OAuth servers with PKCE S256 are accepted; servers without sign-in and API-key servers are not supported yet.
- The URL must be https without query, fragment or credentials, and its host must resolve only to public addresses. Every later request to the server (authorization, token exchange, tool calls) is checked the same way, and redirects are not followed.
- Adding the same URL again for the same user returns the same connector (the name derives from project, user and URL). At most 20 per user.
- A custom connector is visible only to the `external_user_id` that added it: it is not in `GET /v1/connectors` or `GET /v1/tools`, and other users get `connector_not_found` when they create a session with its name.
- Whether a tool is read-only comes from the server's own annotations; treat it as untrusted. Call arguments are sent to that server.
- The avatar is a monogram of the name; the server's own icon is not fetched.

Failures return 422 with one of: `invalid_server_url`, `server_unreachable`, `server_not_public`, `not_mcp_server`, `server_auth_unsupported`, `server_registration_unsupported`, `server_registration_failed`; over the limit returns 409 `custom_connector_limit`.

`GET /v1/custom-connectors?external_user_id=user_123`

Returns `{ "data": [ ... ] }` with the fields above, oldest first.

`DELETE /v1/custom-connectors/{name}?external_user_id=user_123`

Revokes and deletes the user's connections to it (upstream revocation is best effort), then its sessions, tool catalog, registered client and the connector itself. Returns `{"name":"mcp_1a2b3c4d5e","removed":true,"revoked":1}`.

## SDK and the two-tool adapter

Download the TypeScript SDK from the page header and use it on your agent backend. It has no third-party runtime dependencies.

```typescript
import { Connany, createAgentTools } from './connany-client.js';
const client = new Connany({
  baseUrl: process.env.CONNANY_BASE_URL!,
  apiKey: process.env.CONNANY_API_KEY!,
});
const bound = createAgentTools(client, {
  externalUserId: authenticatedUser.id,
  connectionId: selectedConnection.id,
  connector: selectedConnection.connector,
  allowWrites: false,
});
// Adapt bound.tools to your model framework's tool format.
// Dispatch calls through await bound.call(toolName, argumentsObject).
```

The adapter exposes list_tools and call_tool with identity fixed by your backend. Non-read-only tools are blocked by default. Enable allowWrites explicitly and optionally restrict allowedTools to full tool names. This SDK policy is not applied to direct HTTP tool calls.

Other SDK methods: connectors, createSession, getSession, listConnections, getConnection, checkConnection, reconnect, disconnect, listAccess, listTools, callTool, toolCatalog and events. Requests time out after 60 seconds without automatic retries. ConnanyError exposes status, code, requestId and details.

## Errors and retries

```json
{"error":{"code":"reauth_required","message":"Authorization expired or was revoked. Reconnect this account."},"request_id":"req_example"}
```

| HTTP / code | Handling |
| --- | --- |
| 400 invalid_request | Check required fields and types; fields may provide details |
| 400 connector_mismatch | The tool belongs to a different connector than the connection |
| 400 tool_not_found | List tools first to confirm the name |
| 401 unauthorized | Check that the key is correct and not revoked, and that the project is enabled |
| 404 not_found | Object missing or not owned by the current project/user |
| 404 connector_not_found | Check the connector name against GET /v1/connectors |
| 409 reauth_required | Reauthorize the original account |
| 409 connection_revoked / new_connection_required | Create a new connection session |
| 422 server_* / not_mcp_server / invalid_server_url | Adding a custom MCP server failed; see "Custom MCP servers" |
| 410 session_unavailable | Link expired or consumed; generate a new one |
| 429 rate_limited | Follow Retry-After and reduce polling |
| mcp_tool_error or another upstream error | Check parameters, resource permissions and upstream status |
| 500 internal_error | Save X-Request-Id and contact the operator |

Do not interpret every 403/404, upstream error or timeout as expired credentials. The SDK may also throw network or timeout errors. Non-JSON responses produce invalid_response. Some protocol errors omit request_id in the body; use the response header.

## Health check

`GET /health` requires no key. Checks service/database reachability and returns `{status:"ok", version:"0.1.0"}`. This does not guarantee upstream availability. Deployment probes can use this endpoint.

