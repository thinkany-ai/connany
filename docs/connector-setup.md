# Notion / GitHub / Linear 连接器配置

由 Connany 服务管理员执行。接入方只拿项目 key，不需要拿这些应用密钥。三个平台各使用一套后台配置的共享默认应用；尚未支持按项目自带应用。

先确定 `PUBLIC_BASE_URL`，例如 `https://connect.example.com`。不要带子路径。生产使用 HTTPS，开发允许 `http://localhost:3000`。OAuth redirect URI 必须与下面地址及 `.env` 中的域名一致；不要填 agent 的 `return_url`。

| 平台 | OAuth callback |
|---|---|
| Notion | `https://connect.example.com/oauth/notion/callback` |
| GitHub | `https://connect.example.com/oauth/github/callback` |
| Linear | `https://connect.example.com/oauth/linear/callback` |

本地测试将域名替换为 `http://localhost:3000`。若平台拒绝某个本地配置，使用你控制的 HTTPS 域名/隧道，并同步更新 `PUBLIC_BASE_URL` 和平台回调设置。访问者浏览器必须能访问 Connany；其他人电脑上的 localhost 不会指向你的电脑。

## Notion MCP

1. 配置 `PUBLIC_BASE_URL`，打开管理后台「连接器」。
2. 在 Notion 卡片上点「启用」。服务会向官方动态注册客户端，自动登记 `/oauth/notion/callback`；无需创建 Notion Public connection 或填写 Client Secret。
3. 在「连接测试」发起授权，用户会看到 Notion MCP 授权页和 Connany 客户端名称，选择工作区后授权。
4. 检查授权结果，再读取官方工具目录。实际工具和搜索能力取决于用户权限及 Notion 套餐。

更换服务域名后重新保存配置，注册匹配回调地址的新客户端。现有连接保留原客户端身份；重新授权应在原回调地址可用时进行。

旧版升级先运行 `pnpm db:migrate`，将旧 REST 连接标记为需要重新授权。请创建新的 Notion 连接；旧 token 不能复用，旧 action 名称不再支持。旧授权可在 Notion 的 Settings → Connections 中删除。原 NOTION_CLIENT_ID / NOTION_CLIENT_SECRET 配置不再使用。

官方服务：`https://mcp.notion.com/mcp`。OAuth 使用 PKCE，凭证加密保存，刷新仍由数据库连接锁串行保护。断开优先本地停用，再尝试官方撤销端点；若上游撤销失败会明确返回 failed，可在 Notion 设置中移除连接。

[官方客户端接入文档](https://developers.notion.com/guides/mcp/build-mcp-client)

## GitHub

工具调用已接入 GitHub 官方远程 MCP。授权仍使用下方 GitHub App 配置：官方远程 MCP 不提供与 Notion/Linear 相同的免配置动态注册。已有 App 和连接可复用，无需重新创建。后台连接测试会同时查询安装和官方 MCP 工具。

在 [New GitHub App](https://github.com/settings/apps/new) 创建应用；组织所有的应用从组织设置创建。已有 App 直接在其设置中更新权限，无需重新创建。

1. 在 GitHub Developer settings 创建 **GitHub App**。本版本不使用传统 OAuth App。
2. Callback URL 填 Connany 后台「连接器 → GitHub → 配置」弹框中的回调地址；开启用户访问 token 过期，以便使用 refresh token。
3. 在 GitHub App → Permissions & events → Repository permissions 中明确检查仓库权限。仓库列表接口要求 Metadata: Read-only，不要仅假设默认值已开启。如果安装页只有 “read access to public resources” 而没有仓库选择，说明应用未请求仓库权限。面向只读代码访问可设置 Contents: Read-only，并确认 Metadata: Read-only，保存后由已有安装的管理员接受新增权限，再选择仓库。Contents 会授予读取文件内容的上游权限。Connany 的动态目录提供已实现操作的参数、读写标记和所需权限，写入需要对应的 write 权限。
4. 根据试点用户选择可安装范围；要给其他账号/组织安装，不能限制为只允许自己的账号。
5. **不要开启 “Request user authorization (OAuth) during installation”**。本版本由 Connany 单独启动带 state/PKCE 的用户 OAuth 流程。账号 OAuth 成功后即可返回 agent；安装是独立操作，安装完成后返回 agent 刷新安装和仓库列表。
6. 不需要把 setup URL 指向 OAuth callback；本版本不消费安装回调。不需要 App 私钥或 installation token。
7. 首版未实现 GitHub webhook 接收；在应用配置中关闭 webhook 投递。
8. 在管理后台「连接器 → GitHub → 配置」填写 Client ID、Client Secret 和 App slug。以下环境变量仅用于旧版迁移：

```dotenv
GITHUB_CLIENT_ID=GitHubApp的ClientID
GITHUB_CLIENT_SECRET=GitHubApp的ClientSecret
GITHUB_APP_SLUG=应用URL中apps后面的slug
GITHUB_API_VERSION=2026-03-10
```

例如安装地址为 `https://github.com/apps/my-connany/installations/new`，slug 就是 `my-connany`。不要把 App ID 当作 Client ID。

GitHub App 安装授权决定仓库范围；用户 OAuth 决定操作主体。Connany 使用用户 token，通过 `/user/installations` 和 `/user/installations/{id}/repositories` 读取二者交集。安装 ID 来自已认证的 GitHub API，不信任浏览器 query 中的安装 ID。

若组织需要管理员批准、SSO 或尚未为 App 开放仓库，授权可能成功但仓库不可见。审批/安装完成后重新调用 installations，再查 repositories。断开只撤销用户 token，不删除整个组织的 App 安装。

官方文档：[应用类型](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps)、[用户 token 与 PKCE](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)、[安装列表](https://docs.github.com/en/rest/apps/installations)、[撤销 token](https://docs.github.com/en/rest/apps/oauth-applications#delete-an-app-token)。

## Linear MCP

1. 配置 PUBLIC_BASE_URL（本地可用 http://localhost:3100，生产使用 HTTPS）。
2. 管理后台「连接器」在 Linear 卡片上点「启用」。自动注册 Connany 客户端及 `/oauth/linear/callback`。
3. 在「连接测试」发起用户授权。使用官方 MCP 授权页，客户端显示 Connany，请求 Read、Write 权限。
4. 授权后读取官方工具目录，按实际返回的工具和参数调用。

不再需要创建 Linear OAuth 应用、填写 Client ID / Secret、配置 Webhooks 或 Client credentials。已创建的旧应用可保留，Connany 不再用于新授权。

升级先运行 `pnpm db:migrate`，旧自建 OAuth 连接将标记为需要重新授权。新增 Linear 连接即可，旧 action `linear.teams.list` / `linear.issues.list` 不再支持，使用动态发现的 `linear.<官方工具名>`。用户身份通过 MCP 的 get_user 查询当前用户取得；工作区字段仅在上游返回时提供，不使用团队名称冒充工作区。

官方服务：https://mcp.linear.app/mcp，OAuth Authorization Code + PKCE。客户端动态注册、凭证加密和刷新由 Connany 处理，agent 只需项目 API key。SDK 仍默认只读；写操作需后端启用 allowWrites。

[官方文档](https://linear.app/docs/mcp)

## 其他官方托管 MCP 连接器

以下连接器和 Notion、Linear 一样走官方 MCP 授权：管理员在「连接器」点启用，Connany 自动完成 OAuth 客户端注册（动态客户端注册，RFC 7591），然后点「同步工具目录」用自己的账号授权一次。不需要去各平台申请应用或填写凭证。

| 分类 | 连接器 |
| --- | --- |
| 开发与运维 | Sentry、PostHog、Vercel、Supabase、Neon、Netlify、GitLab、Cloudflare（Workers、KV、R2、D1）、Prisma |
| 支付 | Stripe、PayPal、Square |
| 协作与办公 | Atlassian（Jira、Confluence）、ClickUp、monday.com、Airtable、Todoist、Miro、Canva、Intercom |
| 建站 | Webflow、Wix |

说明：

- 端点、权限范围（scope）和 RFC 8707 resource 均取自各平台公开的 OAuth 元数据（RFC 9728 受保护资源元数据、RFC 8414 授权服务器元数据），并确认了动态注册、PKCE S256 和 Streamable HTTP 端点。是否能真实注册和授权，需要用真实账号点一次启用和同步来验证。
- Vercel、Supabase、monday.com、GitLab、Miro 只接受带密钥的客户端：注册时平台下发的 `client_secret` 会加密保存，换取令牌时按注册结果使用 `client_secret_post` 或 `client_secret_basic`。
- 平台拒绝注册时，后台会显示平台返回的状态码和错误说明（如 `400 · invalid_redirect_uri · …`），便于排查。常见原因是平台限制回调域名或要求人工审核。
- 账号名称按以下顺序获取：OIDC userinfo、id_token、令牌响应中的用户字段、JWT 格式的访问令牌。都没有时（例如令牌是不透明字符串且平台没有 userinfo），连接照常可用，但显示为「<平台> 账号」并标记 `identity.unverified=true`：这类连接不会和其他连接合并，重新授权时也无法确认是同一个账号。
- 未接入：Asana、Box、HubSpot 不支持动态注册；Figma 的 MCP 注册只对审核过的客户端开放；Hugging Face 的 MCP 不需要登录。

## 新增内置连接器

连接器统一登记在 `src/connectors/catalog.ts`。支持动态客户端注册和 PKCE 的官方远程 MCP 只需新增一条目录项：

- `website`、`label`、`description`、`icon`：后台卡片的官网、名称、能力描述和图标（内联 SVG，推荐 [Simple Icons](https://simpleicons.org)，CC0）。描述需在 `public/admin-i18n.js` 补英文。
- `auth: 'mcp'`，`mcp.origin` 填 MCP 域名，`mcp.endpoint` 填 MCP 路径（默认 `/mcp`）。
- `mcp.oauth`：授权服务器元数据中的 `authorize`、`token`、`register`，以及可选的 `revoke`、`userinfo`。不填时按旧约定使用 `origin + /authorize`、`/token`、`/register`。
- `mcp.scope`：受保护资源元数据的 `scopes_supported`（或 WWW-Authenticate 中的 scope）；`mcp.resource`：受保护资源元数据中的 `resource` 原样填写。
- `mcp.clientAuth`：授权服务器不支持 `none`（公开客户端）时填 `client_secret_post` 或 `client_secret_basic`。
- 可选 `identify` / `refreshIdentity`：平台有专门的「当前用户」工具时自定义账号识别；不填则使用上文的通用识别。

可以用下面的方式读取元数据（只读请求）：

```bash
curl -s -X POST https://mcp.example.com/mcp -H 'Content-Type: application/json' -d '{}' -D - -o /dev/null | grep -i www-authenticate
curl -s https://mcp.example.com/.well-known/oauth-protected-resource/mcp
curl -s https://<授权服务器>/.well-known/oauth-authorization-server
```

后台「连接器」、连接路由、工具校验、工具列表会自动出现新连接器，无需修改数据库。需要自定义 OAuth 的连接器（如 GitHub App）仍在 `ConnectorRuntime`（`src/connectors/index.ts`）中单独实现。

升级到此版本需运行一次 `pnpm db:migrate`（`005_provider_catalog.sql` 移除数据库中写死的连接器名单约束）。

`006_projects_connectors.sql` 统一了术语：`provider_settings` / `provider_apps` 改名为 `connectors` / `connector_apps`，连接与会话的 `provider` 列改名为 `connector`，项目的 API Key 拆分到 `api_keys` 表（现有 Key 自动迁移、继续可用），并新增预留的 `workspaces` 表。
