# Agent 接入 Connany v0.1

本文可直接交给另一个 agent 产品的开发者。Connany 提供三个平台的账号连接和动态操作目录。无需为每个平台自行实现 OAuth。

## 0. 从服务管理员取得三个信息

1. `CONNANY_BASE_URL`：运行中的服务地址，例如 `https://connect.your-domain.com`。
2. `CONNANY_API_KEY`：属于你的项目的 `cn_live_...` 密钥。
3. `return_url`（可选）：授权后浏览器返回的地址，每次创建会话时传入，例如 `https://agent.example/settings/connections`。

管理员可在 `/admin` 为不同 agent 创建独立项目和 key，平台应用凭证由管理员统一配置。每位用户仍需单独授权，不能用项目 key 代替用户授权。

项目 key 只保存在 **agent 后端**。不要交给浏览器、桌面客户端、LLM prompt、工具参数或最终用户。桌面/CLI 产品也应通过自己的后端代理 Connany；本仓库命令行示例仅供开发者本地联调。

你的产品继续使用自己的用户系统。所有 `external_user_id` 必须来自后端已验证的登录会话，不能直接信任用户请求体、URL 或模型提供的 user ID。

## 1. 查看平台是否已配置

```bash
curl "$CONNANY_BASE_URL/v1/providers" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

响应 `data` 中每项包含 `name`、`enabled`；GitHub 还包含 `installation_url`。禁用的平台需要 Connany 管理员先填凭证。

## 2. 创建连接链接

agent 后端调用：

```bash
curl "$CONNANY_BASE_URL/v1/connect-sessions" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "external_user_id": "user_123",
    "provider": "notion",
    "return_url": "https://agent.example/settings/connections"
  }'
```

`provider` 可取 `notion`、`github`、`linear`。`return_url` 每次请求自行传入，无需登记。允许 HTTPS、本机 HTTP（`localhost` / `127.0.0.1` / `[::1]`，任意端口）和应用自定义协议（如 `myapp://oauth/callback`，桌面或移动客户端可直接唤起应用）；不能含用户名、密码或 `#fragment`，不允许 `javascript:`、`data:`、`file:` 等协议。不需要返回页面时省略。桌面客户端也可以不传，由后端轮询会话状态。

```json
{
  "id": "cs_...",
  "status": "pending",
  "provider": "notion",
  "connect_url": "https://connect.your-domain.com/connect/随机短期令牌",
  "expires_at": "2026-09-25T10:15:00.000Z"
}
```

将 `id` 关联到当前登录用户，向该用户显示 `connect_url`。链接是 15 分钟有效的临时授权入口，应视为敏感链接，不写入公共日志或共享给别人。

用户在同一浏览器打开 connect_url 后直接进入平台授权，无需 Connany 二次确认。成功后，有 return_url 会自动返回 agent，否则显示完成页。GitHub 账号授权和安装是独立步骤，Connany 不会自动跳转安装页。安装完成后回到 agent，实时查询 installations 确认可用范围。组织安装可能需要管理员批准。不要把授权回调切换到另一个浏览器/嵌入式 WebView。

## 3. 查询连接结果

每 5 秒由 **agent 后端** 查询一次，直到成功、失败或过期：

```bash
curl "$CONNANY_BASE_URL/v1/connect-sessions/cs_...?external_user_id=user_123" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

```json
{
  "id": "cs_...",
  "provider": "notion",
  "external_user_id": "user_123",
  "status": "connected",
  "connection_id": "conn_...",
  "error_code": null,
  "expires_at": "2026-09-25T10:15:00.000Z"
}
```

状态含义：

| 状态 | 处理方式 |
|---|---|
| `pending` | 用户尚未开始平台授权，继续等待 |
| `authorizing` | 用户正在平台授权，继续等待 |
| `processing` | 回调正在处理，继续等待 |
| `connected` | 保存 `connection_id`，查询连接信息 |
| `error` | 展示重试入口；常见错误 `access_denied`、`account_mismatch`、`provider_error` |
| `expired` | 停止轮询，创建新会话 |

如果设置了 `return_url`，用户点击结果页“返回 agent”时会携带 `connany_session_id` 查询参数。**不要因为浏览器跳转就认定成功**；后端应校验此 session 属于当前用户，并向 Connany 查询。

`connection_id` 不是密码，但也不是访问凭证。用户不能仅凭它跨账号访问连接。

## 4. 查询、展示连接

支持 `provider=notion|github|linear`、`status=connected|reauth_required|revoked`、`limit=1..100`（默认 50）和 `after` 游标。默认返回全部状态，展示可用账号时可指定 `status=connected`。分页时保留相同筛选条件，以 `next_cursor` 作为下一页的 `after`，返回 null 时结束。状态来自本地记录，不能代替上游检查。

```ts
const page = await connany.listConnections(userId, {
  provider: 'notion', status: 'connected', limit: 20,
});
// 下一页：添加 after: page.next_cursor（非 null 时）
// 兼容旧签名：listConnections(userId, cursor)
```

### 主动检查连接

```http
POST /v1/connections/conn_.../check
Authorization: Bearer cn_live_...
Content-Type: application/json

{"external_user_id":"user_123"}
```

SDK：`await connany.checkConnection(connectionId, userId)`。

成功返回 `connection_id`、`provider`、`checked_at`、`tool_count` 和 `request_id`。检查会验证连接归属、按需刷新 token 并获取官方工具目录，不执行任何业务工具。它仅代表这次工具目录请求成功，不保证指定仓库、页面或写操作可用，也不表示所有返回工具都已获资源权限。GitHub 添加仓库仍需查询 installations。

- `reauth_required`（409）：展示重新授权入口，调用 `reconnect`。
- `connection_revoked`（409）：连接已断开，应创建新连接。
- `not_found`（404）：连接不存在或不属于当前项目/用户。
- 其他上游或网络错误：展示重试入口，不直接判断授权已失效。

建议用户点击“检查连接”时调用，无需每次列出账号都检查全部连接。`external_user_id` 必须来自已登录的服务端会话；状态和错误请以 API 返回为准。


```http
GET /v1/connections?external_user_id=user_123&limit=50
GET /v1/connections/conn_...?external_user_id=user_123
Authorization: Bearer cn_live_...
```

列表返回 `{ "data": [...], "next_cursor": null }`。有下一页时将 `next_cursor` 传为 `after`；单页最多 100 条。

连接包含 `id`、`provider`、`status`、`identity`、时间和撤销状态，永远不包含平台 token。

连接 `status`：`connected`、`reauth_required`、`revoked`。Notion/Linear 的 `identity` 包含工作区；GitHub 的 `identity` 包含用户和授权时可见的安装列表。

**GitHub OAuth 成功不等于已经安装 App。** `identity.needs_installation=true` 时，引导用户安装，再调用 `github.installations.list` 获取最新状态。`identity` 是授权时快照，仓库/安装权限以实时 API 结果为准。

## 5. 让 agent 读取数据

获取工具目录：

```http
GET /v1/actions
Authorization: Bearer cn_live_...
```

每项包含 `name`、`provider`、`description`、`read_only` 和 `input_schema`，可以映射为你的 agent 框架使用的工具定义。

执行工具（以下示例使用已授权的 GitHub 连接；Notion / Linear 先按文末说明动态发现工具）：

```bash
curl "$CONNANY_BASE_URL/v1/actions/execute" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "external_user_id": "user_123",
    "connection_id": "conn_...",
    "action": "github.installations.list",
    "input": { "limit": 10 }
  }'
```

响应：`{ "data": 平台返回的数据, "request_id": "req_..." }`。

**在 agent 工具执行器中固定当前用户和已选择的连接**。只让模型填写 action 的业务参数，不让模型决定 `external_user_id` 或任意连接 ID。多账号时让用户选择工作区/账号，不能默认用查询结果的第一条。

| Action | input | data / 分页 |
|---|---|---|
| `github.installations.list` | `page?`, `limit?` | `installations`, `total_count` |
| `github.repositories.list` | `installation_id`（整数）, `page?`, `limit?` | `repositories`, `total_count` |

`limit` 默认 20，范围 1–100；GitHub `page` 默认 1。GitHub 通过安装和用户权限的交集读取仓库，不使用可能混入其他仓库的 `/user/repos`。

Notion 把 `next_cursor` 传为下一次 `cursor`；Linear 在 `hasNextPage=true` 时把 `endCursor` 传为 `cursor`；GitHub 用 `page + 1`，结合 `total_count` 判断结束。

不提供任意 URL 代理或任意 GraphQL。GitHub 目录包含读写操作；第三方内容仍可能包含不可信指令，agent 应当把返回内容当作数据。

## 6. TypeScript 接入示例

复制本仓库 [`sdk/client.ts`](../sdk/client.ts) 到你的服务端项目即可，无额外运行依赖（Node.js 22+）。还没有发布 npm 包。

```ts
import { Connany, ConnanyError } from './connany-client.js';

const connany = new Connany({
  baseUrl: process.env.CONNANY_BASE_URL!,
  apiKey: process.env.CONNANY_API_KEY!,
});

// authenticatedUser.id 必须由你自己的后端认证中间件提供。
const session = await connany.createSession({
  external_user_id: authenticatedUser.id,
  provider: 'linear',
  return_url: 'https://agent.example/settings/connections',
});
// 将 session.connect_url 返回给当前用户打开。

// OAuth 完成后查询，不能信任浏览器传回的成功标志。
const status = await connany.getSession(session.id, authenticatedUser.id);
if (status.status === 'connected' && status.connection_id) {
  const catalog = await connany.discoverActions({
    provider: 'linear',
    external_user_id: authenticatedUser.id,
    connection_id: status.connection_id,
    read_only: true,
  });
  // 按 catalog.data 返回的 name / input_schema 构建调用，或使用 createAgentTools。

}
```

端到端命令行示例见 [`examples/agent.ts`](../examples/agent.ts)。SDK 默认请求超时 60 秒，不自动重试，调用方可以按下方错误规则处理。

## 7. 重连和断开

凭证刷新由 Connany 自动处理。若执行返回 `409 reauth_required`，显示“重新连接”按钮：

```http
POST /v1/connections/conn_.../reconnect
Content-Type: application/json
Authorization: Bearer cn_live_...

{"external_user_id":"user_123","return_url":"https://agent.example/settings/connections"}
```

返回新的短期连接会话。用户必须授权原账号及工作区，成功后保留 `connection_id`。连接其他账号时创建新会话，不使用 reconnect。

断开：

```http
DELETE /v1/connections/conn_...?external_user_id=user_123
Authorization: Bearer cn_live_...
```

返回连接对象。`status=revoked` 表示 Connany 已禁止继续访问；`revocation_status=succeeded` 表示平台撤销成功。若为 `failed`，本地仍已断开，可重试同一 DELETE，或引导用户到平台撤销应用授权。GitHub 撤销用户 token 不等于卸载组织/仓库中的 App。

## 8. 错误和事件

错误格式：

```json
{
  "error": { "code": "reauth_required", "message": "Authorization expired or was revoked. Reconnect this account." },
  "request_id": "req_..."
}
```

| HTTP / code | 建议处理 |
|---|---|
| `400 invalid_request` | 检查参数/schema；不盲目重试 |
| `400 invalid_request`（return_url） | 使用 HTTPS、本机 HTTP 或应用自定义协议 |
| `401 unauthorized` | 检查项目 key 是否已轮换、项目是否停用；不能通过重连第三方账号解决 |
| `404 not_found` | 资源不存在或不属于当前项目/用户 |
| `409 reauth_required` | 创建 reconnect 会话 |
| `409 connection_revoked` | 用户已断开；由用户决定是否重新创建连接 |
| `429` | 读取 `Retry-After`，退避并加入抖动 |
| `502 provider_error` | 检查 `details.upstream_status`；403/404 可能是资源权限问题，5xx 可以有限重试 |
| `503 provider_not_configured` | 联系 Connany 管理员配置应用凭证 |

每项目 120 请求/分钟，包含轮询；多个浏览器标签页应共享后端轮询结果。API body 最大 32 KB。

需要追踪状态时：

```http
GET /v1/events?external_user_id=user_123&after=0
```

返回 `{ data: [...], next_cursor: "123" }`。保存字符串游标，下次传入 `after`；单次最多 100 条，支持追赶。事件包括 `connection.connected`、`connection.failed`、`connection.reauth_required`、`connection.revoked`、`action.succeeded`、`action.failed`。事件不保存业务正文或 token。

首版没有推送 webhook。平台端直接撤销的授权，在下次工具调用时检测；不要把缓存中的 `connected` 当作永久有效。

## 联调验收

- 用户 A 在一个平台完成连接，拿到 `connection_id` 并成功读取数据。
- 同一产品的用户 B 看不到、也不能使用用户 A 的连接。
- 授权取消、链接过期时能重新生成链接。
- GitHub 安装后能从 installations → repositories 读取所选仓库。
- 在 Connany 中断开后，工具调用被拒绝。
- 不把项目密钥或平台 token 暴露到客户端和模型上下文。

## GitHub：账号授权与仓库安装分别接入

OAuth 成功即为 `connected`，无安装也属于账号连接成功。不要将它展示为“仓库已就绪”。`identity.needs_installation` 是授权时快照，后续判断使用实时接口：

```http
GET /v1/connections/conn_.../github/installations?external_user_id=user_123&page=1&limit=20
Authorization: Bearer <项目 API key>
```

SDK：`await connany.githubInstallations(connectionId, authenticatedUser.id)`。
返回 `{ installation_url, total_count, next_page, data }`。`data` 每项有 `id`、`account`、`account_type`、`repository_selection`、`suspended_at`、`management_url`（可能为 null）。用 next_page 翻页，直到 null。

- **分开接入**：OAuth 完成返回产品，显示“账号已连接”；用户点击“添加组织 / 仓库”时打开 installation_url。
- **连续引导**：OAuth 完成后由 agent 后端查询此接口；total_count 为 0 时向用户展示或导航到 installation_url，否则进入仓库选择。
- **管理权限**：每个安装展示 management_url。能读取组织安装不代表拥有修改权限，GitHub 可能要求组织管理员处理。
- **选择仓库**：用户选定安装后调用 `github.repositories.list`，传入该项 id 作为 installation_id；工具执行器仍固定当前用户和 connection_id。
- **新增组织**：可重复打开 installation_url，每次安装到一个账号或 org。完成后回到 agent 并刷新安装列表，无需重新 OAuth。此版本不提供安装完成自动回跳或 webhook，不要把进入安装链接当成安装成功。

此接口按项目和用户校验连接、自动刷新 token，链接使用该连接绑定的平台应用。已有连接应优先使用这里的 installation_url，而非 `/v1/providers` 中当前新授权应用的入口。链接不包含平台 token。断开 Connany 账号连接与卸载某个 org 中的 App 是两种不同操作。

## 推荐：给模型注册两个动态工具

无需向模型一次注册所有 actions。SDK 导出的 `createAgentTools` 返回两个框架无关的工具定义（name / description / input_schema）和执行函数，按你的 agent 框架转换定义字段即可：

```ts
import { Connany, createAgentTools } from './connany-client.js';
const connany = new Connany({baseUrl:process.env.CONNANY_BASE_URL!,apiKey:process.env.CONNANY_API_KEY!});
const adapter = createAgentTools(connany, {
  externalUserId: authenticatedUser.id,
  connectionId: selectedConnection.id, // 后端确认是当前用户选择的连接
  provider: 'github',
  allowWrites: false, // 后端按产品策略启用，不能由模型传入
  // allowedActions: ['github.files.get', 'github.pull_requests.create'],
});
// 把 adapter.tools 映射给模型。收到工具调用后，由后端调用：
const result = await adapter.call(toolCall.name, toolCall.arguments);
```

1. `discover_actions({query:"创建 PR"})`：返回相关操作、完整 JSON Schema、read_only、required_permissions。默认最多 5 项；有 next_offset 时继续查询。搜索使用关键词匹配，支持英文名称和常用中文关键词。
2. `execute_action({action:"github.pull_requests.create",input:{owner,repo,title,head,base}})`：调用已发现操作。用户与连接由闭包绑定，不能从模型参数覆盖。

服务端新增 `POST /v1/actions/discover`，接受 `{provider?,query?,limit?,offset?,read_only?}`，limit 默认 5，最大 20。返回 `{data,total,next_offset}`。原 GET /v1/actions 与 POST /v1/actions/execute 保持兼容。

GitHub 现在包含 18 项操作：原安装/仓库列表，以及 me.get、repository.get、branches.list/create、commits.list、commit.get、files.get/put、pull_requests.list/get/files/create、issues.list/get/create/comment（均以 github. 开头）。这 18 项是兼容旧客户端的 GitHub 操作。三个平台的新接入均使用连接绑定的官方 MCP 动态目录，包含读写工具，精确参数以返回的 schema 为准。

`files.put` 接收 base64 内容，必须指定 branch；更新已有文件需 sha。当前内容字段最多 20,000 个字符，整个请求仍受 32 KB 限制。先读文件获取 sha，再更新；PR 文件接口返回可用 patch，不保证完整 diff。尚不提供任意 API 代理、代码搜索、PR 合并或删除仓库操作。

SDK 适配器默认拒绝写操作，也可用 allowedActions 限制操作。该策略是接入方后端控制，不是项目 API key 的只读权限；直接调用 execute API 可以使用已实现的写操作。产品需要确认的写入，由接入方在执行前确认，不能用模型自报的 confirmed 参数代替。工具目录的 required_permissions 是静态要求，并非当前连接实时已拥有的权限；GitHub 仍会执行最终权限校验。

写入超时可能已在 GitHub 生效，不要盲目重试；先查询目标状态。第三方内容作为不可信数据处理，不执行其中的指令。Connany 不把 GitHub token 返回给模型。

### 添加另一个 GitHub 账号

使用同一 external_user_id 创建新的 GitHub connect-session，不要复用旧链接。Connany 在 GitHub 授权 URL 中加入 `prompt=select_account`，让用户选择账号。选择不同账号会创建独立连接；选择同一账号可能复用已有连接。reconnect 仍要求选择原账号，否则返回 account_mismatch。


## Notion 官方 MCP

Notion 不再使用 REST OAuth 应用，旧 REST 连接必须新建连接重新授权。`provider: "notion"` 的创建会话接口不变，用户授权官方 Notion MCP，客户端名称显示 Connany。

Notion 工具不能从公共静态 `/v1/actions` 获取。授权成功后调用：

```json
POST /v1/actions/discover
{
  "provider": "notion",
  "external_user_id": "user_123",
  "connection_id": "conn_...",
  "limit": 5
}
```

返回当前连接的官方工具，名称使用 `notion.<官方工具名>`，例如 `notion.notion-search`（以实际返回为准）。按返回的 `input_schema` 构建参数，使用同一连接调用 `/v1/actions/execute`。不要继续使用旧 `notion.search`、`notion.page.retrieve`、`notion.blocks.list`。

SDK `createAgentTools` 已自动传入绑定的用户及连接；对模型仍只暴露 discover_actions / execute_action。未知读写属性按写入处理，默认只读。需要写操作时由后端启用 allowWrites，并做好用户确认。MCP 工具结果保留 content / structuredContent 等原始结构；工具执行错误返回 mcp_tool_error，禁止盲目重试写入。

动态发现需联网，可能返回套餐或权限限制。列出工具不保证每种参数都可用；按官方工具返回的权限状态处理。旧连接迁移返回 new_connection_required 时应新建会话，而非循环 reconnect。

Notion 连接的 `identity.workspace_name` 和 `identity.account_name` 从 MCP 的 `notion-fetch({id:"self"})` 获取。新授权自动保存；已有 MCP 连接在查询列表或详情时自动补全，每小时最多刷新一次。获取失败会保留原名称，不要求重新授权。Agent 重新请求连接数据即可显示名称，无需改字段映射。


## Linear 官方 MCP

Linear 现与 Notion 一样使用官方托管 MCP，授权入口请求 Read、Write。会话仍传 provider: "linear"，获得 connection_id 后动态发现：

```json
{"provider":"linear","external_user_id":"user_123","connection_id":"conn_...","limit":5}
```

发送至 POST /v1/actions/discover。用户和连接必须由 agent 后端绑定；SDK createAgentTools 已自动传入。工具名称为 linear.<官方工具名>，参数按 input_schema 构建。再通过 /v1/actions/execute 调用，不要沿用旧 linear.teams.list / linear.issues.list。

SDK 默认只读；需要写入设置 allowWrites: true。返回的 read_only 来自官方 annotations，未知属性保守按非只读处理。调用结果保留 MCP content / structuredContent，不能再按旧 GraphQL data 结构解析。

旧自建应用连接返回 new_connection_required 时应新建会话重新授权。Linear 用户名称通过 MCP 当前用户查询获得；工作区名称仅在上游提供时返回。


## GitHub 官方 MCP（默认工具接入）

GitHub 现在与 Notion、Linear 一样，通过绑定用户连接动态发现官方 MCP 工具。使用更新后的 createAgentTools SDK，即可继续对模型提供 discover_actions / execute_action 两个工具。

POST /v1/actions/discover 传 provider: "github" 时，必须同时传 external_user_id 和 connection_id。返回的动作名形如 github.get_me、github.get_file_contents；以官方实际返回的 name / input_schema 为准。调用结果为 MCP content / structuredContent，不能按原 REST 响应结构解析。未知读写属性按非只读处理，SDK 写入仍需 allowWrites: true。

Connany 连接 https://api.githubcopilot.com/mcp/x/all。GitHub 远程 MCP 的 OAuth 仍要求接入方配置 GitHub App；保留已有 Client ID、Secret、App slug 和权限配置。已有连接可继续使用，无需数据库迁移或重新授权。获取更多工具不会扩大 GitHub App 已获权限，部分功能还受组织策略或 GitHub 产品权限限制。

账号 OAuth 和仓库安装仍分开，github/installations 管理接口继续使用。原固定 REST action 暂保留兼容，新的 agent 工具发现默认走官方 MCP；GET /v1/actions 只返回旧兼容目录，不能用它代表官方 MCP 工具列表。动态发现请始终指定 provider 和用户连接。


### Linear workspace display names

Linear identity enrichment explicitly reads `linear.get_workspace({})` in addition
to `linear.get_user({query: "me"})`. Existing connected MCP accounts are enriched
when listing or retrieving connections, at most once per hour. The authenticated
user and any previously stored workspace ID must match; names are never inferred
from teams. Optional metadata failures retain the previous identity. The internal
`linear.__identity` operation is not exposed through the public execute API.
