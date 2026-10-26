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

## Google Search Console / Google Analytics

Google 不提供 Search Console 和 Analytics 的托管 MCP，也不支持动态客户端注册。这两个连接器由管理员在 Google Cloud 创建一个 OAuth 客户端，Connany 用用户的 token 直接调用 Google REST API，工具目录内置在 Connany 里，无需「同步工具目录」。两个连接器可以共用同一个 OAuth 客户端。

1. 在 [Google Cloud 控制台](https://console.cloud.google.com/) 选择或新建项目，在「API 和服务 → 库」中启用：
   - Search Console：**Google Search Console API**
   - Analytics：**Google Analytics Data API** 和 **Google Analytics Admin API**
2. 配置 OAuth 同意屏幕（Google Auth Platform）：填写应用名称、支持邮箱和授权域名，在「数据访问」中添加 `openid`、`email`、`https://www.googleapis.com/auth/webmasters.readonly`、`https://www.googleapis.com/auth/analytics.readonly`。
3. 在「凭据」创建 **Web 应用** 类型的 OAuth 客户端，「已获授权的重定向 URI」加入：
   - `https://connect.example.com/oauth/google_search_console/callback`
   - `https://connect.example.com/oauth/google_analytics/callback`
4. 在管理后台「连接器 → Google Search Console / Google Analytics → 配置」填写 Client ID 和 Client Secret 并保存，然后在「连接测试」发起授权，试读数据会列出账号可访问的站点 / GA4 媒体资源。

发布状态：

- **测试中（Testing）**：只有加入「测试用户」的 Google 账号（最多 100 个）能授权，且 refresh token **7 天后失效**，用户需要重新授权。适合自测。
- **正式版（In production）**：两个 scope 都是 Google 的敏感范围，对外开放前需要通过 Google 的应用验证（品牌信息、隐私政策、用途说明和演示视频），不需要安全评估。未验证时用户会看到「Google 尚未验证此应用」的提示。
- **内部（Internal）**：仅限 Google Workspace 组织内的账号，无需验证，refresh token 不会 7 天过期。

工具（全部只读）：

| 连接器 | 工具 |
|---|---|
| Google Search Console | `list_sites`、`query_search_analytics`（点击、展示、CTR、排名，可按查询词 / 页面 / 国家 / 设备 / 日期分组和过滤）、`list_sitemaps`、`inspect_url`（索引状态） |
| Google Analytics | `list_account_summaries`、`get_property`、`get_metadata`（可用维度与指标，含自定义）、`run_report`、`run_realtime_report` |

工具名为 `<连接器>.<工具>`，例如 `google_analytics.run_report`。返回结果整理为按维度、指标命名的行，数值指标转为数字；单次最多 1000 行，用 `start_row` / `offset` 翻页。Google 返回的错误说明（如 API 未启用、无权访问该媒体资源、指标名错误）会放在错误的 `details.upstream_message` 中，MCP 调用会直接展示给 agent。

授权时请求 `access_type=offline` 和 `prompt=consent`，保证每次授权都拿到 refresh token。账号以 Google userinfo 的 `sub` 识别，显示为邮箱。断开连接会调用 `https://oauth2.googleapis.com/revoke` 撤销 refresh token。

## Gmail

Gmail 同样没有官方托管 MCP，配置方式与上面的 Google 连接器相同，可以共用同一个 OAuth 客户端。

1. 在 Google Cloud 项目的「API 和服务 → 库」中启用 **Gmail API**。
2. OAuth 同意屏幕的「数据访问」中添加 `openid`、`email`、`https://www.googleapis.com/auth/gmail.modify`。
3. 在 OAuth 客户端的「已获授权的重定向 URI」加入 `https://connect.example.com/oauth/gmail/callback`。
4. 在管理后台「连接器 → Gmail → 配置」填写 Client ID 和 Client Secret，「连接测试」试读会返回邮箱地址和邮件数量。

`gmail.modify` 可以读取、起草、发送邮件和修改标签，但不能永久删除邮件。它是 Google 的**受限范围**（restricted scope）：测试中（Testing）和内部（Internal）应用可以直接使用；对外正式发布前，除应用验证外还需要通过第三方安全评估（CASA），每年复审。只给自己团队用时，建议使用 Google Workspace 的内部应用。

| 工具 | 说明 |
|---|---|
| `get_profile`、`list_labels` | 邮箱地址、邮件数量；系统标签与自定义标签的 ID |
| `search_messages` | Gmail 搜索语法（如 `from:alice is:unread newer_than:7d`），返回发件人、收件人、主题、时间、摘要和标签，用 `page_token` 翻页 |
| `get_message`、`get_thread` | 读取单封邮件或整个会话，正文解码为纯文本（只有 HTML 时转为文本），列出附件名称；正文默认最多 20000 字符 |
| `create_draft`、`send_draft`、`send_message`（写） | 起草、发送草稿或直接发送；`reply_to_message_id` 会放进原会话并带上 `In-Reply-To` / `References` |
| `modify_labels`（写） | 批量加减标签：已读（移除 `UNREAD`）、归档（移除 `INBOX`）、星标（添加 `STARRED`） |

## Zoho Mail

Zoho 没有支持动态注册的托管 MCP。管理员在 Zoho API Console 创建客户端，Connany 调用 Zoho Mail REST API。

1. 打开 [Zoho API Console](https://api-console.zoho.com/)，新建 **Server-based Applications** 类型的客户端，「Authorized Redirect URIs」填 `https://connect.example.com/oauth/zoho_mail/callback`。
2. 在客户端的 Settings 中开启 **Multi-DC**，并勾选需要支持的数据中心。不开启时，只有与客户端同一数据中心（通常是 zoho.com）的用户能授权。
3. 在管理后台「连接器 → Zoho Mail → 配置」填写 Client ID 和 Client Secret，「连接测试」试读会列出用户的邮件账户。

授权从 `accounts.zoho.com` 发起，Zoho 会把其他数据中心的用户转到所属数据中心，并在回调中带上 `accounts-server`。Connany 只接受已知的数据中心（com、eu、in、com.au、jp、uk、sa、zohocloud.ca、com.cn），之后换取 token、刷新、识别账号、调用 Mail API（`mail.zoho.<域>`）和撤销都在该数据中心进行。请求的 scope 为 `ZohoMail.accounts.READ`、`ZohoMail.folders.READ`、`ZohoMail.messages.ALL` 和 `AaaServer.profile.READ`，账号以 ZUID 识别，显示为邮箱。

| 工具 | 说明 |
|---|---|
| `list_accounts`、`list_folders` | 邮件账户（其他工具都需要 `account_id`）和文件夹 ID |
| `list_messages`、`search_messages` | 按文件夹列出（可筛选已读 / 未读），或用 Zoho 搜索语法（如 `sender:alice@example.com::has:attachment`）；用 `start` 翻页 |
| `get_message` | 读取单封邮件，正文默认转为纯文本 |
| `send_message`、`reply_message`、`create_draft`（写） | 发送、回复（可全部回复）、存为草稿；不填 `from_address` 时使用账户主地址 |

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

没有托管 MCP 或不支持动态注册的服务（如 Google、Zoho）使用 `auth: 'oauth'`：

- `oauth`：`authorize`、`token`，可选 `revoke`（RFC 7009，`revokeInQuery` 表示 token 放在查询参数里）、`userinfo`（OIDC，用 `sub` 或 `id` 识别账号；非 OIDC 的返回用 `profile` 映射）、`scope`、`tokenType`（API 请求的 Authorization 前缀，默认 `Bearer`）、`authorizeParams`、`servers`（多数据中心服务允许的 accounts server，由回调参数 `accounts-server` 选择），以及后台配置弹框中的 `console`（创建客户端的链接和说明）。管理员在后台填写 Client ID / Secret。
- `rest`：Connany 自己实现的工具，参考 `src/connectors/google.ts`、`gmail.ts`、`zoho-mail.ts`：每个工具有 zod 参数，以及单次请求构造加可选的结果整理（`request` / `response`），或需要多次请求时用 `run`。工具名用 `<连接器>.<小写下划线>`，与 MCP 工具名规则一致。工具目录随代码发布，不写入 `connector_tools`。

后台「连接器」、连接路由、工具校验、工具列表会自动出现新连接器，无需修改数据库。GitHub App 的安装流程仍在 `ConnectorRuntime`（`src/connectors/index.ts`）中单独实现。

升级到此版本需运行一次 `pnpm db:migrate`（`005_provider_catalog.sql` 移除数据库中写死的连接器名单约束）。

`006_projects_connectors.sql` 统一了术语：`provider_settings` / `provider_apps` 改名为 `connectors` / `connector_apps`，连接与会话的 `provider` 列改名为 `connector`，项目的 API Key 拆分到 `api_keys` 表（现有 Key 自动迁移、继续可用），并新增预留的 `workspaces` 表。

## Google Calendar、Drive、Sheets、Docs

这四个连接器使用 Google OAuth 和内置 REST 工具，可以与 Gmail 共用 OAuth 客户端，但各自配置、授权并保存连接。

1. 在 Google Cloud 中启用要使用的 API：Google Calendar API、Google Drive API、Google Sheets API、Google Docs API。
2. 创建「Web 应用」OAuth 客户端，在同意屏幕配置相应数据访问范围。
3. 为每个连接器添加回调 URI：`https://connect.example.com/oauth/<连接器 ID>/callback`。
4. 在 Connany 后台对应连接器填写 Client ID、Client Secret 并启用，再进行连接测试。

| 连接器 ID | 除 `openid email` 外的 scope（前缀均为 `https://www.googleapis.com/auth/`） | 内置工具 |
|---|---|---|
| `google_calendar` | `calendar.events`、`calendar.calendarlist.readonly` | `list_calendars`、`list_events`、`get_event`、`create_event`、`update_event`、`delete_event` |
| `google_drive` | `drive` | `list_files`、`get_file`、`create_folder`、`update_file`、`trash_file` |
| `google_sheets` | `spreadsheets` | `get_spreadsheet`、`read_values`、`update_values`、`append_values`、`clear_values`、`create_spreadsheet` |
| `google_docs` | `documents` | `get_document`、`create_document`、`insert_text`、`replace_text` |

完整工具名为 `<连接器 ID>.<工具名>`。工具经现有 REST 目录自动发布，不需要同步远程 MCP 工具或新增数据库迁移。SDK 默认只读；写入需按现有工具策略显式启用。

- Calendar 列表支持翻页，事件列表展开重复事件。创建、修改、删除事件默认 `send_updates=all`，会通知参会人；全天事件结束日期不包含当天。
- Drive 提供文件搜索、元数据和文件夹管理，支持共享云端硬盘文件；不提供二进制上传/下载，Docs/Sheets 内容使用对应连接器读取。`trash_file` 可恢复，不永久删除。为了搜索和管理用户已有文件，当前使用完整 `drive` 范围，而非仅应用创建/用户选择的文件范围。该范围属于受限范围，发布前按 [Google 的范围说明](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)完成适用的验证和安全评估。
- Sheets 的 `range` 使用 A1 格式，例如 `Sheet1!A1:D20`，读取时尽量指定有限范围。写入默认 `RAW`，需要计算公式时使用 `USER_ENTERED`。文件 ID 来自表格 URL 或 Drive 搜索。
- Docs 返回所有标签页的结构化内容；插入位置使用 UTF-16 索引，省略 `index` 为追加，省略 `tab_id` 为首个标签页。`replace_text` 默认匹配所有标签页。可传 `required_revision_id` 防止覆盖其他人的并发编辑。
- Sheets、Docs 后台测试会列出工具目录；验证实际数据访问需提供表格/文档 ID 调用读取工具。目录展示本身不代表文件读取已成功。

接口参考：[Calendar](https://developers.google.com/workspace/calendar/api/v3/reference)、[Drive](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)、[Sheets](https://developers.google.com/workspace/sheets/api/reference/rest)、[Docs](https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/batchUpdate)。

## Outlook

Outlook 使用 Microsoft Graph v1.0 REST API，支持邮件与日历。连接器 ID 为 `outlook`，使用 Microsoft 全球云的 `common` 授权端点。

1. 在 [Microsoft Entra 应用注册](https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade)创建应用，账户类型选择「任何组织目录中的账户和个人 Microsoft 账户」。
2. 添加 **Web** 重定向 URI：`https://connect.example.com/oauth/outlook/callback`。
3. 创建客户端密钥，在 Connany 后台填写应用（客户端）ID 和密钥的 **Value**（不是 Secret ID）。
4. 添加 Microsoft Graph **委托权限**：`User.Read`、`Mail.ReadWrite`、`Mail.Send`、`Calendars.ReadWrite`。授权请求还包括 `openid email profile offline_access`，用于登录和刷新令牌。租户策略可能要求管理员同意。
5. 启用连接器并进行连接测试，试读会返回 Microsoft 账号信息；邮箱/日历操作需要该账号有对应邮箱服务。

| 能力 | 工具（统一以 `outlook.` 为前缀） |
|---|---|
| 账号与邮件读取 | `get_profile`、`list_folders`、`list_messages`、`get_message` |
| 邮件写入 | `create_draft`、`send_draft`、`send_message`、`reply_message`、`mark_read`、`move_message` |
| 日历 | `list_calendars`、`list_events`、`get_event`、`create_event`、`update_event`、`delete_event` |

邮件搜索支持 Outlook 查询语法，如 `from:alice@example.com`。列表返回 `next_page_url`，后续请求将其原样传入 `page_url`，并保持相同的文件夹/日历 ID。连接器仅接受同一 Microsoft Graph 资源的分页 URL。邮件正文转换为有长度限制的纯文本，发送结果 `accepted: true` 只表示 Microsoft 已接受请求，不代表投递成功。

事件查询需要包含时区偏移的起止时间；创建事件的 `dateTime` 使用本地时间（不带偏移），`timeZone` 默认 UTC，也可传 Microsoft 支持的时区，如 `China Standard Time`。邀请、更新和删除会议可能向参会人发送通知。

断开连接会清除 Connany 保存的凭证。此连接器没有单独撤销该应用授权的远端接口；如需撤销 Microsoft 端的同意，请在 Microsoft 账户或组织的应用权限管理中移除授权。

接口参考：[委托授权](https://learn.microsoft.com/en-gb/graph/auth-v2-user)、[邮件列表](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0)、[发送邮件](https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0)、[日历时间窗口](https://learn.microsoft.com/en-us/graph/api/calendar-list-calendarview?view=graph-rest-1.0)。
