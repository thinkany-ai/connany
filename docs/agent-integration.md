# Agent 接入 Connany

本文交给 agent 产品的开发者或开发 agent，按顺序实现即可。接入完成后，你的 agent 用户可以授权自己的 Notion、GitHub、Linear 等账号，并在对话中让模型通过这些账号读写数据。你不需要为每个平台自己实现 OAuth、保存 token 或对接 MCP。

## 0. 整体流程

```text
           你的 agent 后端                                  Connany
用户点击「连接 Notion」或对话中需要 Notion
  │  POST /v1/connectors/notion/sessions ───────────────▶  返回 connect_url
  │  把 connect_url 交给用户在浏览器打开 ─── 用户在 Notion 授权 ───▶  保存凭证，生成连接
  │  GET  /v1/connectors/notion/sessions/{id} ──────────▶  status=connected, connection_id
  │
对话中
  │  GET  /v1/connections?external_user_id=…&status=connected  ▶  用户已授权的连接
  │  GET  /v1/connections/{id}/tools ────────────────────▶  该连接可用的工具
  │  把工具交给模型；模型选择工具后
  │  POST /v1/connections/{id}/tools/{name}/call ────────▶  用用户的凭证调用上游，返回结果
```

核心概念：

| 概念 | 说明 |
| --- | --- |
| 连接器（connector） | Connany 支持的平台集成，如 `notion`、`github`、`linear`，由 Connany 管理员配置和启用 |
| 项目（project） | 你的 agent 产品在 Connany 中的身份，API Key 属于项目 |
| 用户（`external_user_id`） | 你的产品中的用户 ID，在项目内唯一 |
| 连接（connection） | 某个用户在某个连接器上授权的一个账号。一个用户可以有多个连接，同一连接器也可以连多个账号或工作区 |
| 工具（tool） | 连接器提供的操作，如 `notion.notion-search`。调用工具时必须指定连接 |

## 1. 准备

从 Connany 管理员处取得：

1. `CONNANY_BASE_URL`：服务地址，例如 `https://connect.your-domain.com`。
2. `CONNANY_API_KEY`：你的项目的 `cn_live_...` 密钥。管理员在后台「项目」中创建项目时生成。

安全原则，实现时必须遵守：

- **API Key 只放在 agent 后端**，不要交给浏览器、桌面客户端、模型提示词或工具参数。桌面和 CLI 产品也要通过自己的后端访问 Connany。
- **`external_user_id` 只能来自后端已验证的登录会话**，不能来自请求体、URL 或模型输出。
- **用户和连接由后端绑定**，模型只能填写工具的业务参数，不能决定用哪个用户、哪个连接。
- **第三方返回的内容是不可信数据**，可能包含诱导模型的指令，不要当作系统指令执行。

在后端初始化 SDK。下载 TypeScript SDK（仓库中的 `sdk/client.ts`，文档页顶部也可下载）放到你的服务端项目（无第三方依赖，Node.js 22+），也可以按下文的 HTTP 接口自行封装：

```ts
import { Connany, ConnanyError, createAgentTools } from './connany-client.js';

const connany = new Connany({
  baseUrl: process.env.CONNANY_BASE_URL!,
  apiKey: process.env.CONNANY_API_KEY!,
});
```

所有 HTTP 请求都带 `Authorization: Bearer $CONNANY_API_KEY`。完整字段说明见服务上的 API 文档（`/docs`）。

## 2. 让用户授权连接器

### 2.1 展示可连接的连接器

```ts
const { categories, data: connectors } = await connany.connectors({ lang: 'zh-CN' });
// [{ name: 'notion', title: 'Notion', description: '页面、数据库与工作区搜索', avatar_url: 'https://…/connectors/notion/avatar.svg', tools_synced_at: … }, …]
```

对应 `GET /v1/connectors?lang=zh-CN`，只返回管理员已启用的连接器。`categories` 是这些连接器所属的分类（按推荐顺序），可以用来分组展示；分类名称和连接器描述按 `lang` 返回英文（`en`）、简体中文（`zh-CN`）或香港繁体中文（`zh-HK`），不传时按 `Accept-Language`，默认英文。用 `title`、`description` 和 `avatar_url` 渲染「连接账号」入口（`avatar_url` 可直接放进 `<img>`）。如果想在用户连接之前介绍某个连接器能做什么，可以读工具目录 `connany.toolCatalog({ connector: 'notion' })`（`GET /v1/tools?connector=notion`）。

### 2.2 创建授权会话，把链接交给用户

授权入口有两个，建议都实现：

- **设置页**：在「已连接账号」页面放连接按钮。
- **对话中**：用户要求的操作需要某个平台、但还没有连接时，在对话里给出授权链接（见 3.4）。

两种入口都由后端创建会话：

```ts
const session = await connany.createSession('notion', {
  external_user_id: currentUser.id,
  return_url: 'https://agent.example/settings/connections', // 可选
});
// session.connect_url：交给用户在浏览器打开
// session.id：记录下来，用于确认结果
```

对应 `POST /v1/connectors/{name}/sessions`，请求体 `{external_user_id, return_url?}`。

- **网页产品**：可以直接跳转到 `connect_url`，或新开标签页打开。
- **对话中**：把链接渲染成一个按钮，例如「连接 Notion」。
- **桌面或移动应用**：用系统浏览器打开。不要用嵌入式 WebView，有的平台会拒绝在 WebView 里登录，授权回调也需要在同一个浏览器里完成。

`connect_url` 15 分钟内有效，账号连接成功后失效（之前可以重复打开，以最后一次打开的浏览器为准，因此聊天应用的链接预览不会把它用掉），属于敏感链接，不要写入公共日志或分享给别人。用户打开后直接进入平台的授权页。

`return_url` 是授权完成后浏览器返回的地址，支持 HTTPS、本机 HTTP（`localhost` / `127.0.0.1` / `[::1]`，任意端口）和应用自定义协议（如 `myapp://oauth/callback`）。不传则显示 Connany 的完成页，提示用户回到 agent。

### 2.3 确认授权结果

浏览器跳回不代表授权成功，必须由后端查询会话：

```ts
const result = await connany.getSession('notion', session.id, currentUser.id);
```

对应 `GET /v1/connectors/{name}/sessions/{id}?external_user_id=…`。确认方式有两种：

- **轮询**：用户打开链接后，后端每 5 秒查询一次，直到结果不再是进行中。适合对话场景：轮询期间在对话里显示「等待授权…」，成功后继续回答用户。
- **回跳**：设置了 `return_url` 时，授权结束后浏览器会带着 `connany_session_id` 跳回；失败时另带 `connany_status=error` 和 `connany_error`，方便在自己的页面展示结果。后端先确认这个会话属于当前登录用户，再用上面的接口查询一次。`connany_session_id` 来自浏览器，不能直接信任。

| status | 处理 |
| --- | --- |
| `pending` / `authorizing` / `processing` | 授权进行中，继续等待 |
| `connected` | 拿到 `connection_id`，授权完成 |
| `error` | 展示 `error_code` 和重试入口，常见值 `access_denied`（用户取消）、`account_mismatch`、`upstream_error` |
| `expired` | 链接过期，重新创建会话 |

### 2.4 补充资源访问

有的连接器在授权之后，还需要用户单独授予可访问的资源。目前只有 GitHub 需要：账号授权成功后，还要把 GitHub App 安装到个人账号或组织并选择仓库，才能读到仓库。

连接对象上的 `needs_access` 为 `true` 时，提示用户补充授权：

```ts
const access = await connany.listAccess(connectionId, currentUser.id);
// { add_url: 'https://github.com/apps/…/installations/new', total: 0, next_page: null, data: [] }
```

对应 `GET /v1/connections/{id}/access?external_user_id=…`。

- **`add_url` 不为 null**：展示「添加组织 / 仓库」按钮，打开 `add_url`。用户完成后回到 agent，重新查询这个接口，不需要重新授权。
- **`data`**：已经获得的访问范围，比如安装到了哪些组织。每项的 `manage_url` 可以修改范围，有时需要组织管理员权限。
- **不需要这一步的连接器**：返回 `add_url: null` 和空列表。所有连接器都用同一套逻辑处理，不用按平台写分支。

不要把「账号已连接」展示成「仓库已就绪」。

### 2.5 管理已连接的账号

```ts
const { data: connections } = await connany.listConnections(currentUser.id, { status: 'connected' });
await connany.checkConnection(connectionId, currentUser.id);              // 用户点「检查连接」时
const again = await connany.reconnect(connectionId, { external_user_id: currentUser.id }); // 授权失效时
await connany.disconnect(connectionId, currentUser.id);                    // 用户断开
```

| 操作 | HTTP 接口 | 说明 |
| --- | --- | --- |
| 列出连接 | `GET /v1/connections?external_user_id=…` | 可用 `connector`、`status` 过滤；用 `next_cursor` 翻页 |
| 查询单个连接 | `GET /v1/connections/{id}?external_user_id=…` | 含 `identity`（账号名、工作区等，字段因连接器而异）和 `needs_access` |
| 检查连接 | `POST /v1/connections/{id}/check` | 验证授权是否仍然有效，不执行业务操作 |
| 重新授权 | `POST /v1/connections/{id}/reconnect` | 返回新会话，按 2.2、2.3 处理；必须授权原账号，成功后 `connection_id` 不变 |
| 断开 | `DELETE /v1/connections/{id}?external_user_id=…` | 立即禁止后续调用，再尝试撤销平台授权；`revocation_status=failed` 时可重试 |

展示账号时用 `identity.account_name`、`identity.workspace_name`，区分同一连接器下的多个账号或工作区。要连接另一个账号，就再创建一个新会话；`reconnect` 只用于重新授权原账号。

## 3. 在对话中调用工具

### 3.1 确定这轮对话可用的连接

每轮对话开始时，后端查询当前用户的有效连接：

```ts
const { data: connections } = await connany.listConnections(currentUser.id, { status: 'connected' });
```

- **没有连接**：不注册 Connany 工具，或者只注册 3.4 中的「请求连接」工具。
- **同一连接器有多个连接**（例如两个 Notion 工作区）：让用户选择，或者在会话设置里记住用户的选择。不要默认用列表第一条。
- 连接状态是本地记录。平台侧撤销的授权，要等下次调用时才会被发现，这时按 3.5 处理。

### 3.2 把工具交给模型

推荐用 SDK 的适配器。它只向模型暴露两个工具 `list_tools` 和 `call_tool`，模型按需搜索工具，避免一次把几十个工具定义塞进上下文：

```ts
const adapter = createAgentTools(connany, {
  externalUserId: currentUser.id,
  connectionId: selected.id,      // 后端确认属于当前用户的连接
  connector: selected.connector,
  allowWrites: false,             // 写操作由后端按产品策略开启，不能由模型决定
  // allowedTools: ['github.get_file_contents'], // 可选：限定可用工具
});

// 1. 把 adapter.tools（name / description / input_schema）转换成你的模型框架的工具格式
// 2. 模型发起工具调用时，由后端执行：
const output = await adapter.call(toolCall.name, toolCall.arguments);
// 3. 把 output 作为工具结果返回给模型
```

- **`list_tools({query?, offset?})`**：搜索这个连接可用的工具，返回名称、说明、`input_schema` 和 `read_only`。
- **`call_tool({tool, input})`**：调用工具。适配器会先确认工具存在、并且符合读写策略，再按绑定的用户和连接调用；模型传入其他用户或连接的参数会被拒绝。

**同时使用多个连接**（例如一边读 Notion，一边建 GitHub Issue）：给每个连接各创建一个适配器，工具名加上前缀区分，比如 `notion_list_tools`、`github_call_tool`，再一起注册给模型，收到调用后分发给对应的适配器。

**不用适配器**：可以直接把工具列表交给模型：

```ts
const { data: tools } = await connany.listTools(selected.id, currentUser.id, { read_only: true });
// 每项：name、connector、description、read_only、required_permissions、input_schema
```

对应 `GET /v1/connections/{id}/tools?external_user_id=…`（可选 `query`、`read_only`、`limit`、`offset`）。连接已断开或需要重新授权时返回 409。工具由上游官方 MCP 动态提供，不要硬编码工具名和参数；`read_only` 未知的工具按写操作处理。

### 3.3 执行工具调用

```ts
const { data } = await connany.callTool(selected.id, currentUser.id, 'notion.notion-search', { query: 'Q3 roadmap' });
```

对应 `POST /v1/connections/{id}/tools/{name}/call`，请求体 `{external_user_id, input}`。

- **结果**：`data` 是上游 MCP 的原始结果，通常含 `content`（文本或其他内容块）和 `structuredContent`。把它作为工具结果交给模型即可。
- **令牌刷新**：凭证快过期时 Connany 会自动刷新，后端不用处理 token。
- **写操作**：需要用户确认的写操作，由后端在执行前向用户确认，不能依赖模型自己声明「已确认」。写请求超时后，上游可能已经执行成功，先查询目标状态，不要盲目重试。

### 3.4 对话中引导用户授权

用户在对话中要求的操作需要某个平台、但还没有可用连接时，不要让模型说「我做不到」，而是在对话里引导授权。推荐由后端额外给模型注册一个工具：

```ts
const connectTool = {
  name: 'request_connection',
  description: '当用户需要的操作依赖一个尚未连接的平台时调用，向用户展示授权按钮。',
  input_schema: { type: 'object', properties: { connector: { type: 'string', enum: connectors.map(c => c.name) } }, required: ['connector'] },
};

// 模型调用 request_connection 时：
const session = await connany.createSession(args.connector, { external_user_id: currentUser.id });
// 在对话界面渲染一个「连接 Notion」按钮，指向 session.connect_url，并开始轮询（2.3）
// 告诉模型：已向用户展示授权按钮，等待用户完成
```

用户完成授权后，后端拿到 `connection_id`，用新连接创建适配器，然后继续这轮对话，或者提示用户「已连接，可以继续」。`connect_url` 只渲染给当前用户，不要写进模型上下文。

### 3.5 对话中遇到授权失效

工具调用返回下面的错误时，在对话里给出对应的提示，不要让模型无限重试：

| 错误 | 对话中的处理 |
| --- | --- |
| `409 reauth_required` | 调用 `reconnect` 拿到新的授权链接，展示「重新连接 Notion」按钮，完成后重试这次调用 |
| `409 connection_revoked` | 连接已断开，展示连接按钮，让用户重新创建连接 |
| `mcp_tool_error`、`502 upstream_error` | 上游执行失败或没有权限。把错误告诉模型，由模型向用户解释，例如可能缺少页面或仓库权限 |
| GitHub 读不到仓库 | 连接的 `needs_access` 为 true，或访问范围里没有目标组织时，按 2.4 引导用户补充授权 |

## 4. 同步状态变化

管理员在后台断开连接、用户在平台上撤销授权、授权失效等变化，不是由你的后端发起的。Connany 没有 webhook 推送，后端用一个后台任务轮询项目的事件流：

```ts
let cursor = await loadCursor(); // 自己持久化，初始为 '0'
const { data: events, next_cursor } = await connany.events({ after: cursor });
for (const event of events) {
  // event.type、event.external_user_id、event.connection_id、event.data
}
await saveCursor(next_cursor);
```

对应 `GET /v1/events?after=…`，可选 `external_user_id`、`connection_id`、`type` 过滤。一次轮询覆盖整个项目，不用逐个用户查。按 `seq` 升序返回，保存 `next_cursor` 就不会漏，也不会重复。

| type | 建议处理 |
| --- | --- |
| `connection.connected` | 刷新该用户的账号列表 |
| `connection.failed` | 提示用户重试授权 |
| `connection.reauth_required` | 在账号列表和对话中提示重新连接 |
| `connection.revoked` | 从账号列表移除，停止在对话中使用 |
| `tool.succeeded` / `tool.failed` | 审计或排查问题 |

遇到不认识的事件类型直接忽略。

## 5. 错误处理

错误格式：

```json
{ "error": { "code": "reauth_required", "message": "Authorization expired or was revoked. Reconnect this account." }, "request_id": "req_..." }
```

SDK 会抛出 `ConnanyError`，带 `status`、`code`、`requestId` 和 `details`。

| HTTP / code | 处理 |
| --- | --- |
| `400 invalid_request` | 参数错误，检查字段，不要重试 |
| `400 connector_mismatch` / `tool_not_found` | 工具不属于这个连接的连接器，或工具名错误；重新列出工具 |
| `401 unauthorized` | API Key 错误、已吊销，或项目已停用；联系 Connany 管理员 |
| `404 not_found` | 对象不存在，或不属于当前项目或用户 |
| `404 connector_not_found` | 连接器名称错误，以 `GET /v1/connectors` 为准 |
| `409 reauth_required` / `connection_revoked` | 见 3.5 |
| `410 session_unavailable` | 授权链接过期或已使用，重新创建会话 |
| `429 rate_limited` | 读取 `Retry-After`，退避后重试 |
| `502 upstream_error`、`mcp_tool_error` | 上游失败，查看 `details`；403/404 多为权限问题，5xx 可有限重试 |
| `503 connector_not_configured` | 连接器未启用，联系 Connany 管理员 |

限制：每个项目每分钟最多 120 个请求，包括轮询；请求体最大 32 KB；SDK 请求超时 60 秒，不自动重试。多个浏览器标签页应共享后端的轮询结果。

## 6. 各连接器说明

所有连接器的工具都来自上游官方 MCP，名称格式为 `<连接器>.<官方工具名>`，参数以 `input_schema` 为准。

接入方的代码对所有连接器都一样：用 `GET /v1/connectors` 拿到可连接的列表，授权、列出工具、调用工具的接口都不区分连接器。除下面三个之外，Sentry、PostHog、Atlassian、Vercel、Supabase、Neon、Netlify、GitLab、Cloudflare、Prisma、Stripe、PayPal、Square、ClickUp、monday.com、Airtable、Todoist、Miro、Canva、Intercom、Webflow、Wix 也都走各自的官方 MCP，工具名为 `<连接器>.<官方工具名>`。少数平台不提供用户信息，这类连接显示为「<平台> 账号」，`identity.unverified` 为 true，重新授权时无法确认是同一个账号，建议在界面上提示用户。

### Notion

工具如 `notion.notion-search`、`notion.notion-fetch`。连接的 `identity` 含工作区名称；用户可以连接多个工作区，每个都是独立的连接。

### Linear

工具如 `linear.get_user`。`identity` 含用户名称，工作区名称仅在上游提供时返回。

### GitHub

工具如 `github.get_me`、`github.get_file_contents`。授权账号后还需安装 App（见 2.4）。另有一组兼容的 REST 工具，不出现在工具列表中，但可以直接调用：

| 工具 | input | 返回 |
| --- | --- | --- |
| `github.installations.list` | `page?`、`limit?` | `installations`、`total_count` |
| `github.repositories.list` | `installation_id`（访问范围的 `data[].id`，转成整数）、`page?`、`limit?` | `repositories`、`total_count` |

连接另一个 GitHub 账号时，创建新会话即可。授权页会让用户选择账号；选择同一个账号时，可能复用已有连接。

## 7. 联调验收

- [ ] 用户在设置页完成一个连接器的授权，后端拿到 `connection_id`，账号列表显示账号名。
- [ ] 用户取消授权、链接过期时，能重新发起。
- [ ] 对话中需要未连接的平台时，出现授权按钮；完成后对话可以继续。
- [ ] 对话中模型能列出并调用工具，结果正确返回给模型。
- [ ] 模型无法指定其他用户或连接；写操作默认被拒绝，开启后需要用户确认。
- [ ] GitHub 授权后能引导安装 App，安装后能读到所选仓库。
- [ ] 在 Connany 后台断开连接后，事件轮询能收到 `connection.revoked`，对话中不再使用该连接。
- [ ] 用户 B 看不到、也用不了用户 A 的连接。
- [ ] API Key 和平台 token 不出现在浏览器、客户端和模型上下文中。

端到端命令行示例见仓库中的 `examples/agent.ts`。
