# Connany API Docs

Connect agent products to Notion, GitHub and Linear. Connany manages user authorization, encrypted credentials, refresh and tool execution.

## Quick start

Service origin: `{{BASE_URL}}`. API paths start with /v1. SDK baseUrl must be the origin without /v1.

Create a key in the console under API Keys and store it in your agent backend. Derive external_user_id from your authenticated user session, never from model arguments.

```bash
export CONNANY_BASE_URL='{{BASE_URL}}'
export CONNANY_API_KEY='cn_live_REPLACE_ME'
curl "$CONNANY_BASE_URL/v1/connect-sessions" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"external_user_id":"user_123","provider":"notion"}'
```

Show connect_url to the user. They authorize in their browser while your backend polls the session every 5 seconds. After obtaining connection_id, discover tools and execute an operation. GitHub repository access also requires an App installation.

## Authentication and conventions

All /v1 endpoints require `Authorization: Bearer cn_live_...`. Never expose keys to browsers or model prompts. /docs and /health are public.

A newly created key owns an isolated integration space. The same external_user_id under different spaces represents separate users. Rotation retains connections and invalidates the old key immediately. Disabling blocks subsequent calls; in-flight requests may finish.

Send JSON with Content-Type: application/json. Maximum request body: 32 KB. Each space has a fixed-window limit of 120 requests per minute, including polling and discovery. Follow Retry-After on 429 responses.

Timestamps are ISO 8601 strings. Nullable fields use null. X-Request-Id identifies requests for support. URL-encode path and query values. Connany exposes REST and a server-side SDK; using upstream MCP does not mean Connany exposes a client-facing /mcp endpoint.

## Providers

`GET /v1/providers`

No parameters. Returns data containing name, enabled and, where applicable, GitHub installation_url. Providers: notion, github, linear. Enabled means new authorization is allowed, not that a user is connected.

```json
{"data":[{"name":"notion","enabled":true},{"name":"github","enabled":true,"installation_url":"https://github.com/apps/YOUR_APP/installations/new"},{"name":"linear","enabled":true}]}
```

## Create an authorization session

`POST /v1/connect-sessions` → 201

| JSON field | Type | Description |
| --- | --- | --- |
| external_user_id | string, required | Stable user ID within your product; 1–200 characters |
| provider | string, required | notion / github / linear |
| return_url | string, optional | Full post-authorization return URL; up to 2048 characters |

The key-holding backend supplies return_url. HTTPS, loopback HTTP and native app schemes are supported. Credentials, fragments and executable schemes are rejected. Use a fixed URL you control; do not trust arbitrary browser input.

```json
{"id":"cs_example","status":"pending","provider":"notion","connect_url":"{{BASE_URL}}/connect/EXAMPLE_TOKEN","expires_at":"2026-09-26T13:00:00.000Z"}
```

Links expire in 15 minutes and can start authorization only once. Do not log or publish link tokens. Use a new session for another account. The same upstream account and workspace for the same user, integration space and provider app may reuse an existing connection.

## Poll authorization

`GET /v1/connect-sessions/{id}?external_user_id=user_123`

id is the session ID. external_user_id is required and must own the session in the current integration space.

```json
{"id":"cs_example","provider":"notion","external_user_id":"user_123","status":"connected","connection_id":"conn_example","error_code":null,"expires_at":"2026-09-26T13:00:00.000Z"}
```

| status | Handling |
| --- | --- |
| pending / authorizing / processing | Keep polling while authorization is in progress |
| connected | Save connection_id and stop polling |
| error | Stop polling, show error_code and offer another connection attempt |
| expired | Stop polling and create a new session |

On success, return_url receives connany_session_id through an automatic redirect. Failures show a hosted error page. A redirect is not proof of success: query the session from your backend under the authenticated user. Complete authorization in the same browser so callback cookies are preserved.

## List and retrieve connections

`GET /v1/connections`

| Query parameter | Type | Description |
| --- | --- | --- |
| external_user_id | string, required | Current user ID |
| provider | string, optional | notion / github / linear |
| status | string, optional | connected / reauth_required / revoked |
| limit | integer, optional | 1–100; default 50 |
| after | string, optional | Previous next_cursor |

Returns `{data: Connection[], next_cursor: string|null}`. Keep filters unchanged between pages; null ends pagination. All statuses are returned by default. Status is a local record: external revocation may only be detected on the next upstream request.

`GET /v1/connections/{id}?external_user_id=user_123`

Returns one Connection:

```json
{"id":"conn_example","external_user_id":"user_123","provider":"notion","status":"connected","identity":{"account_id":"user_example","account_name":"Mike","workspace_id":"workspace_example","workspace_name":"My workspace"},"expires_at":null,"revocation_status":"not_requested","created_at":"2026-09-26T12:00:00.000Z","updated_at":"2026-09-26T12:00:00.000Z"}
```

Workspace fields and other identity metadata depend on the provider and may be absent. expires_at is the upstream credential expiration and may be refreshed automatically; it is not necessarily the connection expiration. Tokens are never returned.

## Check and reconnect

`POST /v1/connections/{id}/check`

JSON body: `{"external_user_id":"user_123"}`.

```json
{"connection_id":"conn_example","provider":"notion","checked_at":"2026-09-26T12:30:00.000Z","tool_count":20,"request_id":"req_example"}
```

Checks ownership, refreshes credentials if needed and reads the upstream tool catalog without executing a business tool. Success does not guarantee access to a specific resource or write permission. Run on demand rather than continuously polling every connection.

`POST /v1/connections/{id}/reconnect` → 201

JSON fields: required external_user_id and optional return_url, using creation rules. Returns a new session and connect_url. The original account and workspace must authorize; otherwise account_mismatch is returned. Success preserves connection_id. Revoked connections and legacy REST-to-MCP migrations require a new connection instead.

## Disconnect

`DELETE /v1/connections/{id}?external_user_id=user_123`

Returns Connection. First marks the connection revoked locally to block subsequent calls, then attempts upstream revocation. revocation_status can be pending, succeeded or failed; not_requested means revocation has not been requested. A concurrent in-flight call may finish first.

Repeat the same DELETE to retry failed revocation. Local access remains blocked. Revoking a shared upstream app grant may affect other connections for the same account. No automatic revocation retry worker is provided.

## GitHub organizations and repositories

`GET /v1/connections/{id}/github/installations`

| Query parameter | Type | Description |
| --- | --- | --- |
| external_user_id | string, required | Current user ID |
| page | integer, optional | 1–10000; default 1 |
| limit | integer, optional | 1–100; default 20 |

```json
{"installation_url":"https://github.com/apps/YOUR_APP/installations/new","total_count":1,"next_page":null,"data":[{"id":123,"account":"example-org","account_type":"Organization","repository_selection":"selected","suspended_at":null,"management_url":"https://github.com/organizations/example-org/settings/installations/123"}]}
```

User authorization and installation are separate. Show installation_url to add an organization and non-null management_url to change repository access. Install into multiple organizations separately; administrator approval may be required. Refresh installations afterward. An empty list is not an account authorization failure. The compatible github.repositories.list operation accepts installation_id, page and limit.

## Discover tools

`POST /v1/actions/discover`

| JSON field | Type | Description |
| --- | --- | --- |
| provider | string | New integrations should specify a provider |
| external_user_id | string | Required when provider is supplied |
| connection_id | string | Required when provider is supplied |
| query | string, optional | Search name or description; max 500 characters; exact names rank first |
| limit | integer, optional | 1–20; default 5 |
| offset | integer, optional | Nonnegative; default 0 |
| read_only | boolean, optional | true: read-only; false: other tools; omitted: both |

```json
{"provider":"github","external_user_id":"user_123","connection_id":"conn_example","query":"get_me","limit":5,"read_only":true}
```

Returns data, total and next_offset. Each tool contains name, provider, description, read_only, required_permissions and input_schema. A null next_offset ends pagination. Follow the returned schema; upstream tools and parameters are dynamic. Missing read-only hints are treated as non-read-only. Permission descriptions do not prove current resource access.

Omitting provider queries the legacy catalog. `GET /v1/actions` also returns only fixed legacy GitHub operations, not the complete official MCP catalog. Use connection-bound discovery for new integrations.

## Execute a tool

`POST /v1/actions/execute`

| JSON field | Type | Description |
| --- | --- | --- |
| external_user_id | string, required | Backend-bound user ID |
| connection_id | string, required | Connection owned by that user |
| action | string, required | Full name from discovery; max 150 characters |
| input | object, optional | Arguments following input_schema; default {} |

```bash
curl "$CONNANY_BASE_URL/v1/actions/execute" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"external_user_id":"user_123","connection_id":"conn_example","action":"github.get_me","input":{}}'
```

Replace the example connection ID and confirm github.get_me is available through discovery. Returns `{data: result, request_id: string}`. Official MCP results preserve content, structuredContent and other result fields. Legacy GitHub REST operations return REST data; parse them separately. Upstream tool failures are returned as errors.

API keys are not inherently read-only. Enforce write policies in your backend; do not rely on a model-supplied confirmed flag. A timed-out write may have succeeded upstream. Do not blindly retry writes. Unified Idempotency-Key support is not available.

## Poll events

`GET /v1/events?external_user_id=user_123&after=0`

external_user_id is required. after is a numeric string up to 18 digits, default 0. Returns up to 100 entries ordered by seq. Continue with next_cursor; on an empty page, retain the cursor and poll later.

```json
{"data":[{"seq":"12","type":"connection.connected","connection_id":"conn_example","data":{"provider":"notion"},"created_at":"2026-09-26T12:00:00.000Z"}],"next_cursor":"12"}
```

Common types: connection.connected, connection.failed, connection.reauth_required, connection.revoked, action.succeeded and action.failed. Events are scoped to the current integration and user, and exclude credentials and resource content. Handle unfamiliar event types gracefully. Push webhooks are not available.

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
  provider: selectedConnection.provider,
  allowWrites: false,
});
// Adapt bound.tools to your model framework's tool format.
// Dispatch calls through await bound.call(toolName, argumentsObject).
```

The adapter exposes discover_actions and execute_action with identity fixed by your backend. Non-read-only tools are blocked by default. Enable allowWrites explicitly and optionally restrict allowedActions to full tool names. This SDK policy is not applied to direct HTTP execute calls.

Other SDK methods: providers, createSession, getSession, listConnections, getConnection, checkConnection, reconnect, disconnect, githubInstallations, discoverActions, execute and events. Requests time out after 60 seconds without automatic retries. ConnanyError exposes status, code, requestId and details.

## Errors and retries

```json
{"error":{"code":"reauth_required","message":"Authorization expired or was revoked. Reconnect this account."},"request_id":"req_example"}
```

| HTTP / code | Handling |
| --- | --- |
| 400 invalid_request | Check required fields and types; fields may provide details |
| 400 connection_required / provider_mismatch | Supply the correct user, provider and connection |
| 401 unauthorized | Check key validity, rotation or disabled status |
| 404 not_found | Object missing or not owned by the current integration/user |
| 409 reauth_required | Reauthorize the original account |
| 409 connection_revoked / new_connection_required | Create a new connection session |
| 410 session_unavailable | Link expired or consumed; generate a new one |
| 429 rate_limited | Follow Retry-After and reduce polling |
| mcp_tool_error or another upstream error | Check parameters, resource permissions and provider status |
| 500 internal_error | Save X-Request-Id and contact the operator |

Do not interpret every 403/404, upstream error or timeout as expired credentials. The SDK may also throw network or timeout errors. Non-JSON responses produce invalid_response. Some protocol errors omit request_id in the body; use the response header.

## Health check

`GET /health` requires no key. Checks service/database reachability and returns `{status:"ok", version:"0.1.0"}`. This does not guarantee upstream provider availability. Deployment probes can use this endpoint.
