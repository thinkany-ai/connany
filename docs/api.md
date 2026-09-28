# Connany API Docs

为 Agent 产品接入 Notion、GitHub、Linear。统一处理用户授权、凭证刷新、连接管理和工具调用。

## 快速开始

当前服务地址：`{{BASE_URL}}`。API 路径以 `/v1` 开头；SDK 的 baseUrl 使用服务根地址，不追加 /v1。

在管理后台「API Keys」创建密钥，配置到 Agent 后端。用户身份由你的登录系统提供，不能让模型或浏览器自由指定 external_user_id。

```bash
export CONNANY_BASE_URL='{{BASE_URL}}'
export CONNANY_API_KEY='cn_live_REPLACE_ME'
curl "$CONNANY_BASE_URL/v1/connect-sessions" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"external_user_id":"user_123","provider":"notion"}'
```

将返回的 connect_url 展示给用户，在浏览器完成授权；后端每 5 秒查询会话，获得 connection_id 后发现工具并执行。GitHub 账号授权后还需按需安装 App、选择组织和仓库。

## 鉴权与约定

所有 /v1 接口使用 `Authorization: Bearer cn_live_...`。密钥仅用于 Agent 后端，不能放入前端代码或模型提示词。/docs 和 /health 无需密钥。

每把新建密钥对应独立接入空间，同名 external_user_id 在不同空间内隔离。轮换保留连接；旧密钥立即失效。停用后拒绝后续调用，已经执行中的调用可能完成。

JSON 请求使用 Content-Type: application/json，请求体上限 32 KB。每个接入空间固定分钟窗口最多 120 次请求，包含轮询和工具发现。超限返回 429，按 Retry-After 等待。

时间为 ISO 8601 字符串；可空字段返回 null。响应头 X-Request-Id 用于定位问题。调用参数与分页游标应进行 URL 编码。该服务提供 REST/SDK；上游使用官方 MCP，不代表本服务提供可直接连接的 /mcp 端点。

## 平台目录

`GET /v1/providers`

无参数。返回 data 数组，元素包含 name、enabled，可包含 GitHub installation_url。name 为 notion、github、linear。enabled 表示允许新授权，不代表用户已授权。

```json
{"data":[{"name":"notion","enabled":true},{"name":"github","enabled":true,"installation_url":"https://github.com/apps/YOUR_APP/installations/new"},{"name":"linear","enabled":true}]}
```

## 创建授权会话

`POST /v1/connect-sessions` → 201

| JSON 字段 | 类型 | 说明 |
| --- | --- | --- |
| external_user_id | string，必填 | 已登录用户在你的产品内的稳定 ID，1–200 字符 |
| provider | string，必填 | notion / github / linear |
| return_url | string，可选 | 授权成功后返回的完整地址，最长 2048 字符 |

return_url 由持有 key 的后端传入。支持 HTTPS、本机 HTTP 和原生应用自定义协议；不能包含账号密码、fragment 或执行代码类协议。请使用你控制的固定回调地址，不直接信任浏览器输入。

```json
{"id":"cs_example","status":"pending","provider":"notion","connect_url":"{{BASE_URL}}/connect/EXAMPLE_TOKEN","expires_at":"2026-09-26T13:00:00.000Z"}
```

链接有效期 15 分钟且只能启动一次；不要记录或公开链接令牌。新账号使用新会话；同一接入空间、用户、上游应用下的相同账号和工作区可能复用已有连接。

## 查询授权结果

`GET /v1/connect-sessions/{id}?external_user_id=user_123`

id 为会话 ID。external_user_id 必填，必须属于当前接入空间中的该用户。

```json
{"id":"cs_example","provider":"notion","external_user_id":"user_123","status":"connected","connection_id":"conn_example","error_code":null,"expires_at":"2026-09-26T13:00:00.000Z"}
```

| status | Agent 处理方式 |
| --- | --- |
| pending / authorizing / processing | 等待用户授权或服务处理，继续轮询 |
| connected | 保存 connection_id，停止轮询 |
| error | 停止轮询，展示 error_code，提供重新连接入口 |
| expired | 停止轮询，创建新会话 |

授权成功时，如果设置了 return_url，会自动跳转并附带 connany_session_id。失败时显示托管错误页。浏览器跳转不是成功凭证，后端仍需按当前用户查询会话确认。用户应在同一浏览器完成流程，回调需保留授权时的 Cookie。

## 查询用户连接

`GET /v1/connections`

| Query 参数 | 类型 | 说明 |
| --- | --- | --- |
| external_user_id | string，必填 | 当前用户 ID |
| provider | string，可选 | notion / github / linear |
| status | string，可选 | connected / reauth_required / revoked |
| limit | integer，可选 | 1–100，默认 50 |
| after | string，可选 | 上一页 next_cursor |

返回 `{data: Connection[], next_cursor: string|null}`。下一页保留相同筛选条件；next_cursor 为 null 时结束。默认包含全部状态。status 是本地记录，授权外部撤销可能在下次上游请求时才被发现。

`GET /v1/connections/{id}?external_user_id=user_123`

返回单个 Connection：

```json
{"id":"conn_example","external_user_id":"user_123","provider":"notion","status":"connected","identity":{"account_id":"user_example","account_name":"Mike","workspace_id":"workspace_example","workspace_name":"My workspace"},"expires_at":null,"revocation_status":"not_requested","created_at":"2026-09-26T12:00:00.000Z","updated_at":"2026-09-26T12:00:00.000Z"}
```

identity 的工作区字段及其他元数据依平台而异，不要假设一定存在。expires_at 是上游凭证过期时间，可能由服务自动刷新，不等同连接失效时间。接口不会返回 access token 或 refresh token。

## 检查与重新授权

`POST /v1/connections/{id}/check`

JSON：`{"external_user_id":"user_123"}`。

```json
{"connection_id":"conn_example","provider":"notion","checked_at":"2026-09-26T12:30:00.000Z","tool_count":20,"request_id":"req_example"}
```

验证归属、按需刷新凭证并读取上游工具目录，不执行业务工具。成功不保证某个页面、仓库可访问，也不保证写入权限。建议在用户点击检查时调用，不用不断轮询所有连接。

`POST /v1/connections/{id}/reconnect` → 201

JSON：external_user_id 必填，return_url 可选，与创建会话规则相同。返回新的授权会话和 connect_url。必须授权原账号和工作区，否则 account_mismatch；成功保留 connection_id。已 revoked 的连接需要创建新会话，不能 reconnect。旧 REST 授权迁移到 MCP 时也需要新建连接。

## 断开连接

`DELETE /v1/connections/{id}?external_user_id=user_123`

返回 Connection。先在本地设置 revoked，阻止后续调用，再尝试上游撤销。revocation_status 表示撤销进度，可能是 pending、succeeded 或 failed；not_requested 表示尚未申请撤销。并发调用已在执行时可能先完成。

failed 时可重复调用同一 DELETE 重试；本地仍保持断开，不能继续执行工具。共享上游应用的撤销可能影响同账号的其他授权。没有自动撤销重试任务。

## GitHub 组织与仓库

`GET /v1/connections/{id}/github/installations`

| Query 参数 | 类型 | 说明 |
| --- | --- | --- |
| external_user_id | string，必填 | 当前用户 ID |
| page | integer，可选 | 1–10000，默认 1 |
| limit | integer，可选 | 1–100，默认 20 |

```json
{"installation_url":"https://github.com/apps/YOUR_APP/installations/new","total_count":1,"next_page":null,"data":[{"id":123,"account":"example-org","account_type":"Organization","repository_selection":"selected","suspended_at":null,"management_url":"https://github.com/organizations/example-org/settings/installations/123"}]}
```

账号授权与安装独立。展示 installation_url 供用户添加组织，展示非 null 的 management_url 修改仓库范围。可在多个组织分别安装，可能需要组织管理员批准。完成后重新查询；不要把空安装列表误判为账号授权失败。仓库列表可执行兼容操作 github.repositories.list，参数为 installation_id、page、limit。

## 动态发现工具

`POST /v1/actions/discover`

| JSON 字段 | 类型 | 说明 |
| --- | --- | --- |
| provider | string | 新接入应传具体平台 |
| external_user_id | string | 传 provider 时必填 |
| connection_id | string | 传 provider 时必填 |
| query | string，可选 | 搜索名称或描述，最长 500 字符，精确名称优先 |
| limit | integer，可选 | 1–20，默认 5 |
| offset | integer，可选 | 默认 0，不小于 0 |
| read_only | boolean，可选 | true 只读；false 非只读；省略返回全部 |

```json
{"provider":"github","external_user_id":"user_123","connection_id":"conn_example","query":"get_me","limit":5,"read_only":true}
```

返回 data、total、next_offset。data 每项包含 name、provider、description、read_only、required_permissions、input_schema。next_offset 为 null 表示结束。执行前遵循实际返回的 input_schema；目录由上游动态提供，不要硬编码工具总数和参数。未知读写标记按非只读处理，权限描述不是当前账号已拥有的权限证明。

不传 provider 会查询旧兼容目录；`GET /v1/actions` 同样只返回旧 GitHub 固定操作。它们不是三个平台的完整工具列表，新接入应使用带连接的 discover 接口。

## 执行工具

`POST /v1/actions/execute`

| JSON 字段 | 类型 | 说明 |
| --- | --- | --- |
| external_user_id | string，必填 | 后端绑定的用户 ID |
| connection_id | string，必填 | 当前用户的连接 ID |
| action | string，必填 | discover 返回的完整 name，最长 150 字符 |
| input | object，可选 | 按 input_schema 填写，默认 {} |

```bash
curl "$CONNANY_BASE_URL/v1/actions/execute" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"external_user_id":"user_123","connection_id":"conn_example","action":"github.get_me","input":{}}'
```

例子需替换为实际 GitHub connection_id，并先确认发现了 github.get_me。返回 `{data: result, request_id: string}`。官方 MCP 工具结果保留 content、structuredContent 等字段；兼容 GitHub REST 操作返回对应 REST 数据，不能混用解析方式。上游工具失败会返回错误，不视为成功。

API Key 本身不是只读密钥。写入控制由接入方后端实施，不能依赖模型传 confirmed。写请求超时后结果可能不确定，不要盲目重试；当前没有统一 Idempotency-Key 支持。

## 事件轮询

`GET /v1/events?external_user_id=user_123&after=0`

external_user_id 必填；after 是最多 18 位的数字字符串，默认 0。每页最多 100 条，按 seq 升序。用 next_cursor 继续请求，空页时保留当前游标并稍后轮询。

```json
{"data":[{"seq":"12","type":"connection.connected","connection_id":"conn_example","data":{"provider":"notion"},"created_at":"2026-09-26T12:00:00.000Z"}],"next_cursor":"12"}
```

常见事件：connection.connected、connection.failed、connection.reauth_required、connection.revoked、action.succeeded、action.failed。事件只属于当前接入空间和用户，不包含业务正文或凭证；没有推送 webhook。新事件类型请容错处理。

## SDK 与 Agent 两工具模式

下载页面顶部的 TypeScript SDK，放在 Agent 后端。SDK 无第三方运行依赖。

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
// 将 bound.tools 转换为你的模型框架要求的工具格式。
// 模型调用由后端分发：await bound.call(toolName, argumentsObject)。
```

适配器仅暴露 discover_actions / execute_action，用户和连接由后端绑定。默认拒绝非只读工具；需要写入时显式 allowWrites: true，可用 allowedActions 限定完整动作名称。这是 SDK 后端策略，直接调用 HTTP execute 接口不会应用此 SDK 策略。

SDK 还提供 providers、createSession、getSession、listConnections、getConnection、checkConnection、reconnect、disconnect、githubInstallations、discoverActions、execute、events。请求超时 60 秒，不自动重试。ConnanyError 提供 status、code、requestId 和 details。

## 错误与重试

```json
{"error":{"code":"reauth_required","message":"Authorization expired or was revoked. Reconnect this account."},"request_id":"req_example"}
```

| HTTP / code | 处理方式 |
| --- | --- |
| 400 invalid_request | 检查字段类型与必填项；可能包含 fields |
| 400 connection_required / provider_mismatch | 提供正确的用户、平台和连接 |
| 401 unauthorized | 检查 key 是否正确、停用或已轮换 |
| 404 not_found | 对象不存在或不属于当前接入空间/用户 |
| 409 reauth_required | 引导原账号重新授权 |
| 409 connection_revoked / new_connection_required | 创建新的连接会话 |
| 410 session_unavailable | 连接链接过期或已使用，重新生成 |
| 429 rate_limited | 遵循 Retry-After，减少轮询频率 |
| mcp_tool_error 或其他上游错误 | 检查工具参数、资源权限与上游状态 |
| 500 internal_error | 保存 X-Request-Id 联系管理员 |

不要将所有 403/404、上游错误或超时都当作 token 过期。SDK 也可能抛出网络/超时异常。响应体不是 JSON 时 SDK 使用 invalid_response。少数协议层错误可能没有 body 内的 request_id，以响应头为准。

## 健康检查

`GET /health` 无需 API Key。检查服务和数据库可达性，返回 `{status:"ok", version:"0.1.0"}`，不保证第三方平台可用。部署探针可使用本接口。
