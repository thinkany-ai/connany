# 架构与运行

## 结构

```text
src/app.ts                 REST、浏览器入口、cookie、安全响应头
src/service.ts             多租户连接生命周期、刷新与审计
src/connectors/index.ts    连接器运行时：OAuth、上游调用与旧 GitHub REST 工具
src/connectors/catalog.ts  内置连接器目录
src/connectors/hosted-mcp.ts 官方 MCP 授权、动态工具与调用
src/crypto.ts              AES-256-GCM、SHA-256、随机标识
src/pages.ts               无外部依赖的托管连接页面
src/admin/                 管理员认证、后台路由和页面
src/connector-store.ts     连接器配置、加密的连接器应用凭证与连接归属
src/workspaces.ts          用户工作空间的创建与归属
public/admin.*             后台 CSS 和原生浏览器 JS
sdk/client.ts              可复制的服务端 TypeScript SDK
migrations/001_initial.sql 数据库定义
scripts/                   初始化环境、迁移、项目创建
```

这是一个 TypeScript / Hono / PostgreSQL 模块化单体。连接页为服务端 HTML，无前端构建或 React 依赖；首版也未引入 ORM，直接使用参数化 SQL，把锁和事务边界写清楚。

数据表：`workspaces`、`connectors`、`connector_apps`、`connector_tools`（按连接器缓存的工具目录，只含工具定义）、`projects`、`api_keys`、`connect_sessions`、`connections`、`events`、`rate_limits`。层级为 后台用户 → 工作空间 → 连接器 + 项目 → API Key + 用户连接；终端用户用项目内的 `external_user_id` 映射。每个后台用户拥有一个工作空间（`workspaces.owner_id`），后台的所有查询都按当前用户的工作空间过滤，API 请求按 API Key 所属项目的工作空间过滤。升级前的数据所在的默认工作空间 `ws_default` 归第一个系统管理员；`project:create` 命令行也在该工作空间创建项目。管理后台另有 admin_users、admin_sessions、admin_login_limits、admin_audit 和 schema_migrations。

## 部署

完整 Docker Compose 与 Kubernetes 步骤见 [部署目录](../deploy/README.md)。

1. 准备持久 PostgreSQL 15+，使用 TLS（按数据库服务要求配置 `DATABASE_URL`），限制数据库网络访问，启用备份。
2. 创建并保存稳定的 `TOKEN_ENCRYPTION_KEY`，设置公开 HTTPS 域名和端口。平台应用凭证通过管理后台填写。密钥通过部署平台 secret 注入；不要放进镜像或版本库。
3. `npm ci && npm run build`；部署前运行 `npm run db:migrate`，运行 `npm start`。
4. HTTPS 反向代理转发到 API 端口，健康检查 `/health`；保留 Cookie 和 Origin，不修改回调 query。不要缓存 API、连接页面或回调。
5. 使用 `npm run admin:create -- admin@example.com` 创建管理员。登录 `/admin` 配置平台、创建项目，把 API key 安全交给 agent 后端开发者。

容器方式：

```bash
docker build -t connany .
# .env 中 DATABASE_URL 必须是容器能访问的数据库地址；不能照搬宿主机 localhost。
docker run --rm --env-file .env connany node dist/scripts/migrate.js
docker run --rm --env-file .env -p 3000:3000 connany
# 单独创建项目，同样仅显示一次 key。
docker run --rm --env-file .env connany node dist/scripts/create-project.js \
  'My agent' 'https://agent.example/settings/connections'
```

`compose.yaml` 只用于本地 PostgreSQL，并仅绑定本机端口；其中默认密码不用于生产。

## 凭证与隔离

- API key 高熵生成，数据库只保存 SHA-256 哈希。每次 API 调用校验项目，再用 `external_user_id` 校验连接归属。
- Connect URL 令牌、OAuth state 和浏览器绑定 cookie 在数据库中只存哈希；PKCE verifier 和平台凭证使用 AES-256-GCM。
- 凭证加密附加认证数据包含项目、平台和连接 ID，不能把密文复制到另一个连接解密。
- 当前密钥为 env 中单个 32 字节主密钥，**还不是 KMS 信封加密**。丢失密钥会导致凭证无法恢复；轮换前需实现/执行完整重加密迁移，不要直接覆盖旧值。
- 同一连接的工具调用、刷新与重连/断开通过 PostgreSQL 行锁协调，支持多个实例。首版会在第三方调用期间持有行锁，所以同一连接的请求会排队；适合低并发试点。
- 刷新后即使业务读取失败，仍提交轮换后的凭证，避免把已失效 refresh token 留在数据库。平台刷新成功到数据库提交之间的进程崩溃仍是分布式失败窗口，必要时用户重新授权。
- 断开先提交本地 revoked 状态，再调用上游。上游撤销失败保留加密凭证供同一 DELETE 重试，不能继续调用工具；成功后清除密文。无自动撤销重试 worker。
- 工具包含读取与写入。SDK 两工具适配器默认只读，写入由 Agent 后端显式开启；项目 API key 本身不是只读密钥。没有 token 导出、任意 HTTP 代理或任意 GraphQL 接口。

`identity` 仅保存展示所需的账号/工作区/安装元数据。events 不包含资源正文、请求参数、token 或平台原始错误内容。代码不记录 callback URL；反向代理和 APM 也应关闭 `/connect/*`、`/oauth/*` 的 URL/query/body 日志。

## GitHub 和共享应用边界

每个平台目前共用一套上游应用，项目在 Connany 内逻辑隔离，但共享的上游应用授权可能被平台复用或合并。不能把 Connany 的项目隔离理解成平台侧独立 OAuth grant。

同一上游账号跨多个项目授权时，上游撤销或权限变更可能影响其他连接。将公共托管服务开放给不相关客户之前，应验证各平台的授权合并语义与分发要求，按项目或工作空间引入独立的连接器应用配置。当前建议用于受控试点，不承诺跨项目的平台级权限隔离。

Notion 和 Linear 通过官方 MCP，以用户授权及上游实际权限为准；GitHub 使用用户 token，仓库访问受用户权限和 App 安装范围共同限制。权限不足的 403/404 保持为上游错误，不一律误判为 token 过期。

## 状态与运维

- OAuth 会话 15 分钟有效。`processing` 因进程终止未完成时，期限过后查询返回 `expired`，用户重新连接。
- 授权拒绝、无效 state、重复回调或浏览器不匹配不会产生可用连接。
- 平台外部撤销在下次调用时检测，也可主动调用连接检查接口。检查仅发现上游工具，不保证特定资源可读写。没有接收平台 webhook，也没有后台定期健康检查。
- 撤销失败需重试 DELETE；GitHub/Notion 已失效 token 可能让上游返回非成功状态，不能把所有 400/401 都当作撤销成功。
- 限流为数据库持久化的每项目固定分钟窗口 120 次。公开网页应另配网关/IP 限流；不要把项目限流当作公网防滥用保护。
- API `X-Request-Id` 可关联事件和客户端报告（工具调用响应也带 request_id）；当前 events 本身按用户、连接、工具和时间查询，没有完整分布式 tracing。
- 按自己的保留策略定期删除过期 `connect_sessions` 和历史 `events`。首版不自动清理，避免未经配置删除审计数据。
- 管理后台提供项目创建、编辑、停用，以及 API Key 新建与吊销（每个项目最多 2 把有效 Key，用于平滑轮换）；API Key 无法调用管理接口。数据库迁移按版本记录并用事务/锁串行执行。
- 平台应用 Secret 加密保存并按应用 ID 与既有连接绑定。旧 `.env` 凭证只进行初始导入，不能覆盖后台修改。详见 [admin.md](admin.md)。

## 后续扩展

优先补：按项目配置上游应用、历史应用配置管理、平台事件接收、带签名及重试的推送 webhook、KMS 密钥管理。写入能力已存在；项目级服务端工具策略、确认流程和幂等性治理仍需完善。

## 测试边界

单元测试检查加密、配置和平台协议；集成测试连接真实 PostgreSQL，在随机 schema 内运行并清理，上游 HTTP 服务使用测试替身。它们验证内部生命周期及并发一致性，不证明平台应用已通过审核或真实账号已授权。
