# Connany API Docs

为 Agent 产品接入 Notion、GitHub、Linear。统一处理用户授权、凭证刷新、连接管理和工具调用。

## 快速开始

当前服务地址：`{{BASE_URL}}`。API 路径以 `/v1` 开头；SDK 的 baseUrl 使用服务根地址，不追加 /v1。

在管理后台「项目」中为你的 agent 创建项目，把生成的 API Key 配置到 Agent 后端。用户身份由你的登录系统提供，不能让模型或浏览器自由指定 external_user_id。

```bash
export CONNANY_BASE_URL='{{BASE_URL}}'
export CONNANY_API_KEY='cn_live_REPLACE_ME'
curl "$CONNANY_BASE_URL/v1/connectors/notion/sessions" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"external_user_id":"user_123"}'
```

将返回的 connect_url 展示给用户，在浏览器完成授权；后端每 5 秒查询会话，获得 connection_id 后列出工具并调用。GitHub 账号授权后还需按需安装 App、选择组织和仓库。

## 核心概念

| 概念 | 说明 |
| --- | --- |
| 连接器（connector） | Connany 支持的一个第三方平台集成，如 notion、github、linear、sentry。由管理员在后台配置并启用，所有项目共用 |
| 项目（project） | 一个接入 Connany 的 agent 产品。用户连接、授权会话和事件都属于项目 |
| API Key | 访问某个项目的凭证。一个项目最多 2 个有效 Key，可单独吊销 |
| 用户（external_user_id） | 你的产品内的用户 ID，在项目内唯一：同一个 ID 在不同项目中是不同用户 |
| 连接（connection） | 某个用户在某个连接器上授权的账号 |

## 鉴权与约定

所有 /v1 接口使用 `Authorization: Bearer cn_live_...`。密钥仅用于 Agent 后端，不能放入前端代码或模型提示词。/docs 和 /health 无需密钥。

API Key 决定请求属于哪个项目。轮换时先新建 Key、部署后再吊销旧 Key，期间两把 Key 同时有效；连接属于项目，轮换不影响连接。吊销的 Key 立即失效。停用项目后它的所有 Key 都会被拒绝，已经执行中的调用可能完成。

JSON 请求使用 Content-Type: application/json，请求体上限 32 KB。每个项目固定分钟窗口最多 120 次请求，包含轮询和工具发现。超限返回 429，按 Retry-After 等待。

时间为 ISO 8601 字符串；可空字段返回 null。响应头 X-Request-Id 用于定位问题。调用参数与分页游标应进行 URL 编码。该服务提供 REST/SDK；上游使用官方 MCP，不代表本服务提供可直接连接的 /mcp 端点。

## 连接器列表

`GET /v1/connectors`

返回管理员已启用的连接器及其分类，可直接用来渲染分组的「连接账号」入口。

| Query 参数 | 类型 | 说明 |
| --- | --- | --- |
| lang | string，可选 | 返回文字的语言：en、zh-CN 或 zh-HK（香港繁体中文）。不传时按请求头 Accept-Language 选择：zh-TW、zh-MO、zh-Hant 返回 zh-HK，其他中文返回 zh-CN，都没有时为英文 |

请求示例：

```bash
curl "$CONNANY_BASE_URL/v1/connectors?lang=zh-CN" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

响应示例：

```json
{"categories":[{"name":"collaboration","title":"协作与办公"},{"name":"development","title":"代码与部署"},{"name":"analytics","title":"监控与分析"}],"data":[{"name":"notion","title":"Notion","category":"collaboration","description":"页面、数据库与工作区搜索","avatar_url":"{{BASE_URL}}/connectors/notion/avatar.svg","tools_synced_at":"2026-09-26T10:00:00.000Z"},{"name":"github","title":"GitHub","category":"development","description":"仓库、Issue 与 Pull Request","avatar_url":"{{BASE_URL}}/connectors/github/avatar.svg","tools_synced_at":"2026-09-26T10:00:00.000Z"},{"name":"sentry","title":"Sentry","category":"analytics","description":"错误监控、Issue 与性能追踪","avatar_url":"{{BASE_URL}}/connectors/sentry/avatar.svg","tools_synced_at":null}]}
```

| 字段 | 说明 |
| --- | --- |
| categories | 含有已启用连接器的分类，按推荐的展示顺序排列。name 取值 collaboration、development、data、analytics、payments、design；title 按语言返回 |
| data[].name | 连接器名称，用于创建授权会话的路径 /v1/connectors/{name}/sessions（如 notion、sentry、stripe，完整列表以该接口返回为准） |
| data[].title | 品牌名称，不随语言变化 |
| data[].category | 所属分类，对应 categories 中的 name |
| data[].description | 一句话的能力介绍，按语言返回 |
| data[].avatar_url | 无需鉴权的 SVG 图标，可直接用于 img 标签 |
| data[].tools_synced_at | 工具目录最近同步时间，尚未同步时为 null |

响应头 Content-Language 为实际使用的语言。列表出现某个连接器不代表用户已授权。

## 创建授权会话

`POST /v1/connectors/{name}/sessions` → 201

路径中的 name 为连接器名称，取自 `GET /v1/connectors` 返回的 name，例如 notion、github、linear。未知名称返回 404 connector_not_found，未启用返回 503。

| JSON 字段 | 类型 | 说明 |
| --- | --- | --- |
| external_user_id | string，必填 | 已登录用户在你的产品内的稳定 ID，1–200 字符 |
| return_url | string，可选 | 授权成功后返回的完整地址，最长 2048 字符 |

请求示例：

```bash
curl -X POST "$CONNANY_BASE_URL/v1/connectors/notion/sessions" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"external_user_id":"user_123","return_url":"https://agent.example/settings/connections"}'
```

响应示例：

```json
{"id":"cs_example","status":"pending","connector":"notion","connect_url":"{{BASE_URL}}/connect/EXAMPLE_TOKEN","expires_at":"2026-09-26T13:00:00.000Z"}
```

将 connect_url 展示给用户，在浏览器中完成授权。链接有效期 15 分钟且只能启动一次；不要记录或公开链接令牌。新账号使用新会话；同一项目、用户、连接器应用下的相同账号和工作区可能复用已有连接。

return_url 由持有 key 的后端传入。支持 HTTPS、本机 HTTP 和原生应用自定义协议；不能包含账号密码、fragment 或执行代码类协议。请使用你控制的固定回调地址，不直接信任浏览器输入。

## 查询授权结果

`GET /v1/connectors/{name}/sessions/{id}?external_user_id=user_123`

name 为创建会话时使用的连接器名称，id 为会话 ID。external_user_id 必填，必须属于当前项目中的该用户。连接器与会话不匹配时返回 404。

请求示例：

```bash
curl "$CONNANY_BASE_URL/v1/connectors/notion/sessions/cs_example?external_user_id=user_123" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

响应示例：

```json
{"id":"cs_example","connector":"notion","external_user_id":"user_123","status":"connected","connection_id":"conn_example","error_code":null,"expires_at":"2026-09-26T13:00:00.000Z"}
```

| status | Agent 处理方式 |
| --- | --- |
| pending / authorizing / processing | 等待用户授权或服务处理，继续轮询 |
| connected | 保存 connection_id，停止轮询 |
| error | 停止轮询，展示 error_code，提供重新连接入口 |
| expired | 停止轮询，创建新会话 |

设置了 return_url 时，授权结束后会自动跳转并附带 connany_session_id；失败时还会附带 connany_status=error 和 connany_error（如 access_denied）。未设置时显示托管完成页或错误页。浏览器跳转不是成功凭证，后端仍需按当前用户查询会话确认。用户应在同一浏览器完成流程，回调需保留授权时的 Cookie。

## 查询用户连接

`GET /v1/connections`

| Query 参数 | 类型 | 说明 |
| --- | --- | --- |
| external_user_id | string，必填 | 当前用户 ID |
| connector | string，可选 | 连接器名称，如 notion / github / sentry |
| status | string，可选 | connected / reauth_required / revoked |
| limit | integer，可选 | 1–100，默认 50 |
| after | string，可选 | 上一页 next_cursor |

请求示例：

```bash
curl "$CONNANY_BASE_URL/v1/connections?external_user_id=user_123&status=connected&limit=20" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

响应示例：

```json
{"data":[{"id":"conn_notion_example","external_user_id":"user_123","connector":"notion","status":"connected","identity":{"account_id":"user_example","account_name":"Mike","workspace_id":"workspace_example","workspace_name":"My workspace"},"needs_access":false,"expires_at":"2026-09-26T13:00:00.000Z","revocation_status":"not_requested","created_at":"2026-09-26T12:00:00.000Z","updated_at":"2026-09-26T12:00:00.000Z"},{"id":"conn_github_example","external_user_id":"user_123","connector":"github","status":"reauth_required","identity":{"account_id":"12345678","account_name":"mike-dev","installation_count":1,"needs_installation":false,"installations":[{"id":87654321,"account":"example-org"}]},"needs_access":false,"expires_at":null,"revocation_status":"not_requested","created_at":"2026-09-25T08:00:00.000Z","updated_at":"2026-09-26T09:30:00.000Z"}],"next_cursor":null}
```

下一页保留相同筛选条件，把 next_cursor 作为 after 传入；next_cursor 为 null 时结束。默认包含全部状态。status 是本地记录，授权外部撤销可能在下次上游请求时才被发现。

`GET /v1/connections/{id}?external_user_id=user_123`

查询单个连接。

请求示例：

```bash
curl "$CONNANY_BASE_URL/v1/connections/conn_example?external_user_id=user_123" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

响应示例：

```json
{"id":"conn_example","external_user_id":"user_123","connector":"notion","status":"connected","identity":{"account_id":"user_example","account_name":"Mike","workspace_id":"workspace_example","workspace_name":"My workspace"},"needs_access":false,"expires_at":"2026-09-26T13:00:00.000Z","revocation_status":"not_requested","created_at":"2026-09-26T12:00:00.000Z","updated_at":"2026-09-26T12:00:00.000Z"}
```

identity 的工作区字段及其他元数据依连接器而异，不要假设一定存在。expires_at 是上游凭证过期时间，可能由服务自动刷新，不等同连接失效时间。接口不会返回 access token 或 refresh token。

## 检查与重新授权

`POST /v1/connections/{id}/check`

| JSON 字段 | 类型 | 说明 |
| --- | --- | --- |
| external_user_id | string，必填 | 当前用户 ID |

请求示例：

```bash
curl -X POST "$CONNANY_BASE_URL/v1/connections/conn_example/check" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"external_user_id":"user_123"}'
```

响应示例：

```json
{"connection_id":"conn_example","connector":"notion","checked_at":"2026-09-26T12:30:00.000Z","tool_count":20,"request_id":"req_example"}
```

验证归属、按需刷新凭证并读取上游工具列表，同时更新该连接器的工具目录，不执行业务工具。成功不保证某个页面、仓库可访问，也不保证写入权限。建议在用户点击检查时调用，不用不断轮询所有连接。

`POST /v1/connections/{id}/reconnect` → 201

| JSON 字段 | 类型 | 说明 |
| --- | --- | --- |
| external_user_id | string，必填 | 当前用户 ID |
| return_url | string，可选 | 与创建会话规则相同 |

请求示例：

```bash
curl -X POST "$CONNANY_BASE_URL/v1/connections/conn_example/reconnect" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"external_user_id":"user_123","return_url":"https://agent.example/settings/connections"}'
```

响应示例：

```json
{"id":"cs_reconnect_example","status":"pending","connector":"notion","connect_url":"{{BASE_URL}}/connect/EXAMPLE_TOKEN","expires_at":"2026-09-26T13:00:00.000Z"}
```

返回新的授权会话，按「查询授权结果」轮询。必须授权原账号和工作区，否则 account_mismatch；成功保留 connection_id。已 revoked 的连接需要创建新会话，不能 reconnect。旧 REST 授权迁移到 MCP 时也需要新建连接。

## 断开连接

`DELETE /v1/connections/{id}?external_user_id=user_123`

请求示例：

```bash
curl -X DELETE "$CONNANY_BASE_URL/v1/connections/conn_example?external_user_id=user_123" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

响应示例：

```json
{"id":"conn_example","external_user_id":"user_123","connector":"notion","status":"revoked","identity":{"account_id":"user_example","account_name":"Mike","workspace_id":"workspace_example","workspace_name":"My workspace"},"needs_access":false,"expires_at":null,"revocation_status":"succeeded","created_at":"2026-09-26T12:00:00.000Z","updated_at":"2026-09-26T14:00:00.000Z"}
```

返回断开后的连接。先在本地设置 revoked，阻止后续调用，再尝试上游撤销。revocation_status 表示撤销进度，可能是 pending、succeeded 或 failed；not_requested 表示尚未申请撤销。并发调用已在执行时可能先完成。

failed 时可重复调用同一 DELETE 重试；本地仍保持断开，不能继续执行工具。共享上游应用的撤销可能影响同账号的其他授权。没有自动撤销重试任务。

## 访问范围

`GET /v1/connections/{id}/access`

部分连接器在用户 OAuth 授权之后，还需要单独授予可访问的资源，例如 GitHub 需要把 App 安装到个人账号或组织并选择仓库。这个接口返回连接当前已获得的访问范围，以及补充授权的入口。所有连接器都使用同一个接口：不需要这一步的连接器（如 Notion、Linear）返回 add_url 为 null 的空列表。

| Query 参数 | 类型 | 说明 |
| --- | --- | --- |
| external_user_id | string，必填 | 当前用户 ID |
| page | integer，可选 | 1–10000，默认 1 |
| limit | integer，可选 | 1–100，默认 20 |

请求示例：

```bash
curl "$CONNANY_BASE_URL/v1/connections/conn_github_example/access?external_user_id=user_123" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

响应示例：

```json
{"add_url":"https://github.com/apps/YOUR_APP/installations/new","total":1,"next_page":null,"data":[{"id":"87654321","type":"organization","name":"example-org","selection":"selected","suspended":false,"manage_url":"https://github.com/organizations/example-org/settings/installations/87654321"}]}
```

| 字段 | 说明 |
| --- | --- |
| add_url | 补充授权入口，引导用户在浏览器打开；不需要该步骤时为 null |
| data[].type | 范围类型，GitHub 为 organization 或 user |
| data[].selection | all 表示全部资源，selected 表示部分资源 |
| data[].manage_url | 修改该范围的入口，可能需要组织管理员权限；无法提供时为 null |

连接对象上的 needs_access 为 true 时，表示授权时尚未获得任何资源访问，应提示用户打开 add_url。该字段在授权时确定，用户补充授权后以本接口返回为准。可能需要组织管理员批准；完成后重新查询，不要把空列表误判为账号授权失败。具体资源（如某个组织下的仓库）通过工具获取，GitHub 可调用 github.repositories.list，参数为 installation_id（即 data[].id）、page、limit。

## 列出连接的工具

`GET /v1/connections/{id}/tools`

返回用户通过这个连接现在可以使用的工具，用于 agent 对话：用户先授权连接器，对话时再把对应连接的工具交给模型。连接必须属于该用户且状态为 connected，否则返回 404 或 409（reauth_required / connection_revoked），可据此提示用户重新连接。

| Query 参数 | 类型 | 说明 |
| --- | --- | --- |
| external_user_id | string，必填 | 后端绑定的用户 ID |
| query | string，可选 | 搜索名称或描述，最长 500 字符，精确名称优先 |
| read_only | string，可选 | true 只读；false 非只读；省略返回全部 |
| limit | integer，可选 | 1–100，默认 20 |
| offset | integer，可选 | 默认 0，不小于 0 |

请求示例：

```bash
curl "$CONNANY_BASE_URL/v1/connections/conn_github_example/tools?external_user_id=user_123&read_only=true" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

响应示例：

```json
{"data":[{"name":"github.get_me","connector":"github","description":"Get details of the authenticated GitHub user.","read_only":true,"required_permissions":["GitHub MCP: current user access"],"input_schema":{"type":"object","properties":{}}}],"total":1,"next_offset":null}
```

工具来自连接器的工具目录（见下文「工具目录」），不需要每次请求上游；连接器还没有目录时，会用这个连接的凭证读取一次并写入目录。next_offset 为 null 表示结束。调用前遵循返回的 input_schema，不要硬编码工具总数和参数。未知读写标记按非只读处理，权限描述不是当前账号已拥有的权限证明。个别账号可能因套餐或组织策略用不了某个工具，调用时会返回上游错误。

## 调用工具

`POST /v1/connections/{id}/tools/{name}/call`

路径中的 name 为列出工具返回的完整工具名，如 github.get_me，最长 150 字符。

| JSON 字段 | 类型 | 说明 |
| --- | --- | --- |
| external_user_id | string，必填 | 后端绑定的用户 ID |
| input | object，可选 | 按 input_schema 填写，默认 {} |

请求示例：

```bash
curl -X POST "$CONNANY_BASE_URL/v1/connections/conn_github_example/tools/github.get_me/call" \
  -H "Authorization: Bearer $CONNANY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"external_user_id":"user_123","input":{}}'
```

响应示例：

```json
{"data":{"content":[{"type":"text","text":"{\"login\":\"mike-dev\",\"id\":12345678}"}],"structuredContent":{"login":"mike-dev","id":12345678}},"request_id":"req_example"}
```

data 为上游工具结果：官方 MCP 工具保留 content、structuredContent 等字段；兼容 GitHub REST 工具（github.installations.list、github.repositories.list 等）返回对应 REST 数据，不能混用解析方式。上游工具失败会返回错误，不视为成功。

API Key 本身不是只读密钥。写入控制由接入方后端实施，不能依赖模型传 confirmed。写请求超时后结果可能不确定，不要盲目重试；当前没有统一 Idempotency-Key 支持。

## 工具目录

`GET /v1/tools`

返回所有已启用连接器提供的工具，和用户无关，只需 API Key。适合在用户连接之前展示能力，或开发时预览工具；对话中请使用「列出连接的工具」。

| Query 参数 | 类型 | 说明 |
| --- | --- | --- |
| connector | string，可选 | 只返回某个连接器的工具，如 notion / github / sentry |
| query | string，可选 | 搜索名称或描述，最长 500 字符，精确名称优先 |
| read_only | string，可选 | true 只读；false 非只读；省略返回全部 |
| limit | integer，可选 | 1–100，默认 20 |
| offset | integer，可选 | 默认 0，不小于 0 |

请求示例：

```bash
curl "$CONNANY_BASE_URL/v1/tools?connector=github&query=get_me&limit=5&read_only=true" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

响应示例：

```json
{"data":[{"name":"github.get_me","connector":"github","description":"Get details of the authenticated GitHub user.","read_only":true,"required_permissions":["GitHub MCP: current user access"],"input_schema":{"type":"object","properties":{}}}],"total":1,"next_offset":null}
```

next_offset 为 null 表示结束。工具目录来自上游官方 MCP：上游只向已登录用户提供工具列表，因此目录在管理员于后台「同步工具目录」，或任一用户完成授权、检查连接时更新。尚未同步的连接器没有工具，GET /v1/connectors 中 tools_synced_at 为 null。

目录是连接器级别的：个别账号可能因套餐或组织策略用不了某个工具，调用时会返回上游错误。调用前遵循返回的 input_schema，不要硬编码工具总数和参数。未知读写标记按非只读处理，权限描述不是当前账号已拥有的权限证明。GitHub 的兼容 REST 工具（github.installations.list 等）不在目录中，但可以直接调用。

## 事件轮询

`GET /v1/events`

返回当前项目所有用户的事件，后端只需轮询这一个接口。Connany 没有 webhook 推送，那些不由 agent 后端发起的状态变化（例如管理员在后台断开连接、用户在平台上撤销授权）只能通过事件得知。

| Query 参数 | 类型 | 说明 |
| --- | --- | --- |
| after | string，可选 | 上一页 next_cursor，最多 18 位数字，默认 0 |
| external_user_id | string，可选 | 只看某个用户的事件 |
| connection_id | string，可选 | 只看某个连接的事件 |
| type | string，可选 | 只看某类事件，如 connection.revoked |
| limit | integer，可选 | 1–100，默认 100 |

请求示例：

```bash
curl "$CONNANY_BASE_URL/v1/events?after=0" \
  -H "Authorization: Bearer $CONNANY_API_KEY"
```

响应示例：

```json
{"data":[{"seq":"12","type":"connection.connected","external_user_id":"user_123","connection_id":"conn_example","data":{"connector":"notion"},"created_at":"2026-09-26T12:00:00.000Z"},{"seq":"13","type":"connection.reauth_required","external_user_id":"user_456","connection_id":"conn_other","data":{},"created_at":"2026-09-26T12:05:00.000Z"}],"next_cursor":"13"}
```

按 seq 升序返回。保存 next_cursor，下次作为 after 传入，即可不重复、不遗漏地继续拉取；空页时保留当前游标并稍后再轮询。每个事件带 external_user_id，后端据此分发给对应用户。

| type | 发生时机 | 建议处理 |
| --- | --- | --- |
| connection.connected | 用户完成授权 | 刷新账号列表 |
| connection.failed | 授权失败或取消，data 含 session_id、error_code | 提示用户重试 |
| connection.reauth_required | 调用工具或刷新令牌时发现授权失效 | 提示用户重新连接 |
| connection.revoked | 连接被断开，包括管理员在后台断开 | 从界面移除该账号 |
| tool.succeeded / tool.failed | 每次工具调用，data.tool 为工具名 | 审计、排查问题 |

事件只属于当前项目，不包含业务正文或凭证。新事件类型请容错处理。

## 自定义 MCP 服务器

用户可以按 URL 添加目录里没有的远程 MCP 服务器。添加后它就是一个只属于这个用户的连接器，名称形如 `mcp_1a2b3c4d5e`，之后按普通连接器使用：`POST /v1/connectors/{name}/sessions` 创建授权会话，授权完成后列工具、调用工具、断开。

`POST /v1/custom-connectors`

```bash
curl -X POST "$CONNANY_BASE_URL/v1/custom-connectors" \
  -H "Authorization: Bearer $CONNANY_API_KEY" -H "Content-Type: application/json" \
  -d '{"external_user_id":"user_123","url":"https://mcp.example.com/mcp"}'
```

响应示例（201）：

```json
{"name":"mcp_1a2b3c4d5e","title":"Example","url":"https://mcp.example.com/mcp","website":"https://mcp.example.com","avatar_url":"https://connect.example.com/connectors/mcp_1a2b3c4d5e/avatar.svg","created_at":"2026-10-09T08:00:00.000Z"}
```

- Connany 按 MCP 授权规范发现授权方式：未授权的 `initialize` 返回 401 和受保护资源元数据（RFC 9728），再读授权服务器元数据（RFC 8414），然后用动态客户端注册（RFC 7591）注册客户端。只接受支持 PKCE S256 的 OAuth 服务器；不需要登录的服务器和只支持 API Key 的服务器暂不支持。
- URL 必须是 https，不带查询参数、片段和账号密码，并且域名只能解析到公网地址。之后发往该服务器的每个请求（授权、换 token、工具调用）都重新做这项检查，不跟随重定向。
- 同一用户重复添加同一 URL 返回同一个连接器（名称由项目、用户和 URL 决定）。每个用户最多 20 个。
- 自定义连接器只对添加它的 `external_user_id` 可见：不出现在 `GET /v1/connectors` 和 `GET /v1/tools` 中，其他用户用它的名称创建会话会得到 `connector_not_found`。
- 工具是否只读来自服务器自己的声明，接入方应当把它当作不可信信息；调用参数会发给该服务器。
- 图标是名称首字母，不抓取对方网站的图标。

失败时返回 422 和以下错误码之一：`invalid_server_url`、`server_unreachable`、`server_not_public`、`not_mcp_server`、`server_auth_unsupported`、`server_registration_unsupported`、`server_registration_failed`；超过数量上限返回 409 `custom_connector_limit`。

`GET /v1/custom-connectors?external_user_id=user_123`

返回 `{ "data": [ ... ] }`，字段同上，按添加时间排序。

`DELETE /v1/custom-connectors/{name}?external_user_id=user_123`

撤销并删除该用户对它的所有连接（上游撤销尽力而为），再删除授权会话、工具目录、注册的客户端和连接器本身。返回 `{"name":"mcp_1a2b3c4d5e","removed":true,"revoked":1}`。

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
  connector: selectedConnection.connector,
  allowWrites: false,
});
// 将 bound.tools 转换为你的模型框架要求的工具格式。
// 模型调用由后端分发：await bound.call(toolName, argumentsObject)。
```

适配器仅暴露 list_tools / call_tool，用户和连接由后端绑定。默认拒绝非只读工具；需要写入时显式 allowWrites: true，可用 allowedTools 限定完整工具名称。这是 SDK 后端策略，直接调用 HTTP 工具调用接口不会应用此 SDK 策略。

SDK 还提供 connectors、createSession、getSession、listConnections、getConnection、checkConnection、reconnect、disconnect、listAccess、listTools、callTool、toolCatalog、events。请求超时 60 秒，不自动重试。ConnanyError 提供 status、code、requestId 和 details。

## 错误与重试

```json
{"error":{"code":"reauth_required","message":"Authorization expired or was revoked. Reconnect this account."},"request_id":"req_example"}
```

| HTTP / code | 处理方式 |
| --- | --- |
| 400 invalid_request | 检查字段类型与必填项；可能包含 fields |
| 400 connector_mismatch | 工具与连接所属的连接器不一致 |
| 400 tool_not_found | 先列出工具确认工具名 |
| 401 unauthorized | 检查 Key 是否正确、已吊销，或项目已停用 |
| 404 not_found | 对象不存在或不属于当前项目/用户 |
| 404 connector_not_found | 连接器名称错误，以 GET /v1/connectors 返回为准 |
| 409 reauth_required | 引导原账号重新授权 |
| 409 connection_revoked / new_connection_required | 创建新的连接会话 |
| 422 server_* / not_mcp_server / invalid_server_url | 添加自定义 MCP 服务器失败，见「自定义 MCP 服务器」 |
| 410 session_unavailable | 连接链接过期或已使用，重新生成 |
| 429 rate_limited | 遵循 Retry-After，减少轮询频率 |
| mcp_tool_error 或其他上游错误 | 检查工具参数、资源权限与上游状态 |
| 500 internal_error | 保存 X-Request-Id 联系管理员 |

不要将所有 403/404、上游错误或超时都当作 token 过期。SDK 也可能抛出网络/超时异常。响应体不是 JSON 时 SDK 使用 invalid_response。少数协议层错误可能没有 body 内的 request_id，以响应头为准。

## 健康检查

`GET /health` 无需 API Key。检查服务和数据库可达性，返回 `{status:"ok", version:"0.1.0"}`，不保证第三方平台可用。部署探针可使用本接口。

