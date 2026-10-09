# 自定义 MCP 服务器

接入方的用户可以按 URL 添加目录里没有的远程 MCP 服务器，例如 `https://feeds.example/mcp`。添加后它就是一个**只属于这个用户**的连接器，之后的授权、列工具、调用、断开都走普通连接器的接口。API 见 [API 文档](api.md)「自定义 MCP 服务器」。

## 1. 流程

1. 接入方调用 `POST /v1/custom-connectors { external_user_id, url }`。
2. Connany 按 MCP 授权规范发现授权方式（`src/connectors/remote-mcp.ts`）：
   1. 不带凭证发一次 `initialize`，服务器应返回 401，`WWW-Authenticate` 里带 `resource_metadata`；
   2. 读受保护资源元数据（RFC 9728），找不到时依次尝试 `/.well-known/oauth-protected-resource{路径}` 和根路径；
   3. 读授权服务器元数据（RFC 8414，再退到 OpenID 发现），校验 `issuer` 与地址一致；
   4. 要求有 `registration_endpoint`（动态客户端注册，RFC 7591）、`code_challenge_methods_supported` 包含 `S256`，客户端认证方式优先 `none`。
3. 用发现结果拼出与内置托管 MCP 连接器相同的定义（`McpSpec`），向服务器动态注册客户端，回调地址是 `/oauth/{name}/callback`。
4. 在项目所在工作区写入 `connector_apps`、`connectors`（启用）和 `custom_connectors`。
5. 之后接入方用返回的 `name` 调 `POST /v1/connectors/{name}/sessions`，用户授权完成后工具目录按这个连接器缓存在 `connector_tools`。

名称 `mcp_` + 10 位十六进制，由项目、用户和规范化后的 URL 计算，所以同一用户重复添加同一地址返回同一个连接器，不会重复注册客户端。

## 2. 归属与可见性

- 只有添加它的（项目，`external_user_id`）能看到、连接和调用；其他用户或其他项目用它的名字创建会话返回 `connector_not_found`。
- 不出现在 `GET /v1/connectors`、`GET /v1/tools`、管理后台的连接器列表和 Connany 自己的 MCP 服务里。
- 每个用户最多 20 个。

## 3. 安全

自定义服务器没人审核过，Connany 对它的所有请求都经过 `guardFetch`：

- 只允许 https，URL 不能带账号密码；添加时还不能带查询参数和片段；
- 请求前解析域名，**所有**解析结果都必须是公网地址：拒绝回环、私有网段、链路本地（含云元数据地址 169.254.169.254）、运营商 NAT、组播、文档网段，以及嵌着这些 IPv4 的 IPv6 映射地址和 NAT64 地址；
- 不跟随重定向；
- 元数据最多读取 64KB，每个请求 10 秒超时（工具调用沿用托管 MCP 的 45 秒）。

本地开发时，如果机器上的代理开了 fake-IP 模式（所有域名都解析到 `198.18.0.0/15`），设置 `CUSTOM_MCP_ALLOW_FAKE_IP=true` 放行这个网段。只用于本地开发，线上不要设置。

已知的残留风险：地址在请求开始时检查，和实际建立连接之间有极短的间隔，理论上可能被 DNS rebinding 利用。要彻底防住需要在连接层固定解析结果，后续可以改为自定义 dispatcher。

其他要求：

- 受保护资源元数据里的 `resource` 必须与服务器同源，防止服务器借别人的资源标识收集 token。
- 服务器给出的名称只取一行可打印文字（最多 60 个字符），不抓取对方的图标，头像是名称首字母。
- 工具是否只读来自服务器自己的 `readOnlyHint`，是不可信的。调用参数会原样发给该服务器；接入方应当让用户确认后再调用（Sumus 对自定义服务器的每次调用都要求用户审批）。

## 4. 删除

`DELETE /v1/custom-connectors/{name}`：先尽力向上游撤销该用户每个连接的 token，再删除授权会话、连接、工具目录、`connectors`、`connector_apps` 和 `custom_connectors` 行。删除项目时一并删除该项目的自定义服务器。动态注册的客户端不会在对方服务器上注销（RFC 7592 很少被支持）。

## 5. 暂不支持

- 不需要登录的 MCP 服务器（`initialize` 直接成功），返回 `server_auth_unsupported`。
- 只支持 API Key 或自定义请求头的服务器。Key 只能在 Connany 托管的页面里输入，不能经过接入方的对话；以后单独设计。
- 不支持动态注册、需要管理员预先登记客户端的服务器（`server_registration_unsupported`）。

## 6. 验证

- `tests/custom-connectors.test.ts`：地址检查、发现流程与各类拒绝、授权和工具调用只经过受检的 fetcher。
- `tests/integration/custom.test.ts`（需要 `TEST_DATABASE_URL`）：添加、幂等、连接、调用、换进程后从数据库加载定义、跨用户和跨项目隔离、不进共享目录、删除和删除项目时的清理。
