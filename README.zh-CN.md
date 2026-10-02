<p align="center"><img src="public/brand/logo.svg" width="80" alt="Connany logo"></p>
<h1 align="center">Connany</h1>
<p align="center">连接 Agent 与用户的工具、账号和工作空间。</p>
<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a></p>


Connany 是面向 Agent 产品的开源多租户连接器服务。统一管理用户授权、连接和凭证，Agent 后端通过 REST API 或 TypeScript SDK 列出工具、操作已授权数据，无需接触平台 token。

支持 **Notion MCP、GitHub App + MCP、Linear MCP**。MCP 是上游接入方式；Connany 当前对 Agent 提供 REST API 和 SDK，不是通用 MCP Server 托管平台。

## 功能

- 管理后台：连接器配置一次并同步工具目录，为每个 agent 创建项目，管理项目的 API Key（支持不停机轮换），查看用户连接及操作记录，阅读 API 文档和 Agent 接入指南；系统管理员还可以管理后台用户（系统管理员 / 普通用户）。
- 用户授权：托管 OAuth 页面、一次性 state、浏览器绑定、GitHub/Linear PKCE。
- 项目隔离：每个 API Key 属于一个项目，用户数据按 `project_id + external_user_id` 归属。
- 连接管理：多账号和工作区、查询、主动检查、重连、断开及上游撤销重试。
- 工具列出与调用：通过 `GET /v1/connections/{id}/tools` 列出用户连接可用的官方 MCP 工具（连接前可用 `GET /v1/tools` 浏览连接器的工具目录）、参数 schema 和读写标记，通过 `POST /v1/connections/{id}/tools/{name}/call` 调用；SDK 可仅向模型暴露 `list_tools` / `call_tool` 两个工具。
- 事件流：一个项目级接口（`GET /v1/events`）汇总所有用户的连接、需要重新授权、断开和工具调用事件。
- 凭证保护：AES-256-GCM 加密连接器与用户凭证、API Key 仅保存哈希、事务锁协调刷新和调用。

## 快速开始

需要 Node.js 22+、npm、PostgreSQL 15+。以下使用 Docker 启动本地数据库：

```bash
git clone git@github.com:thinkany-ai/connany.git
cd connany
npm ci
npm run setup
docker compose up -d postgres
npm run db:migrate
npm run admin:create -- admin@example.com
npm run dev   # 或：make dev
```

管理员密码交互输入，至少 8 位。`npm run setup` 生成 `.env` 和随机加密密钥，不覆盖已有文件。根目录 `compose.yaml` 仅启动本地 PostgreSQL，默认密码仅供开发。

- 管理后台：<http://localhost:3000/admin>，侧边栏「文档」包含 API 文档和 Agent 接入指南。
- 公开 API 文档：<http://localhost:3000/docs>，支持中英文、代码复制、Markdown 和 SDK 下载。
- 健康检查：<http://localhost:3000/health>

已有数据库时直接配置 `.env` 的 `DATABASE_URL`，跳过 Docker 步骤。端口占用时同时修改 `PORT` 和 `PUBLIC_BASE_URL`。日常开发运行 `make dev`：依赖变化时自动安装，启动 PostgreSQL、执行迁移并以热更新模式运行（仅当 `DATABASE_URL` 指向 compose 数据库的 54329 端口时才启动 Docker）。服务端修改自动重启，静态页面资源刷新即可。

## 配置连接器

| 连接器 | 配置方式 | 能力 |
| --- | --- | --- |
| Notion | 后台一键启用官方 MCP，自动注册 OAuth 客户端 | 页面、数据库、工作区搜索 |
| GitHub | 后台配置 GitHub App 的 Client ID、Client Secret、App slug | 仓库、Issue、Pull Request 等官方 MCP 工具 |
| Linear | 后台一键启用官方 MCP，自动注册 OAuth 客户端 | Issue、项目、团队协作 |

启用连接器后，在卡片上点一次「同步工具目录」：上游 MCP 只向已登录用户提供工具列表，所以用你自己的账号授权一次，Connany 只保存工具定义。用户仍需授权自己的账号；GitHub 仓库访问还需要安装 App 并选择仓库。详见 [连接器配置](docs/connector-setup.md)。

## Agent 接入

1. 在后台「项目」中为 agent 创建项目，保存生成的 API Key。
2. 将服务地址和 API Key 配置到 Agent 后端。
3. 为用户创建授权会话（`POST /v1/connectors/{name}/sessions`），引导用户在托管页面完成授权。
4. 对话中把用户已连接账号的工具交给模型，并通过对应连接调用；需要的平台还没连接时，在对话中展示授权按钮。

可直接复制无依赖的 [TypeScript SDK](sdk/client.ts)，或运行示例：

```bash
export CONNANY_API_KEY='cn_live_replace_with_your_key'
npm run example:agent -- notion
# 也可选择 github / linear
```

API Key 仅放在后端。SDK 两工具适配器默认只读，写操作由后端显式设置 `allowWrites: true`；上游最终权限由用户授权和平台决定。

- [Agent 接入指南](docs/agent-integration.md)
- [REST API 文档](docs/api.md) · [English API reference](docs/api.en.md)
- [管理后台说明](docs/admin.md)

## Docker 部署

仓库包含完整应用与 PostgreSQL 的 Compose 配置：

```bash
cp deploy/docker/.env.example deploy/docker/.env
# 编辑 .env：填入 POSTGRES_PASSWORD、TOKEN_ENCRYPTION_KEY 和公开域名。
# 分别可用 openssl rand -hex 24 和 openssl rand -base64 32 生成密码/密钥。
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yaml up -d --build
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yaml exec app \
  node dist/scripts/create-admin.js admin@example.com
```

数据库健康后自动执行迁移，再启动应用。应用仅绑定本机端口；生产需配置 HTTPS 反向代理。具体环境变量、外部数据库、升级与备份见 [Docker 部署说明](deploy/README.md#docker-compose)。

## Kubernetes 部署

`deploy/k8s/` 提供 Namespace、Deployment（含迁移 initContainer）、Service 和 HTTPS Ingress 模板。使用外部 PostgreSQL，凭证通过 Secret 注入。

1. 使用 GitHub Actions 发布到 `ghcr.io/thinkany-ai/connany` 的镜像（或自行构建），修改模板的镜像标签、域名与 Ingress/TLS 配置。
2. 创建命名空间和 `connany-runtime` Secret。
3. 应用 Deployment/Service，等待迁移和 rollout 完成。
4. 创建管理员后应用 Ingress。

完整命令、私有镜像、升级及故障排查见 [Kubernetes 部署说明](deploy/README.md#kubernetes)。

## 环境变量

| 变量 | 含义 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串；生产按数据库要求配置 TLS |
| `PUBLIC_BASE_URL` | 公开 HTTPS origin，无路径；仅 localhost / 127.0.0.1 允许 HTTP |
| `TOKEN_ENCRYPTION_KEY` | 32 字节随机值的 base64 编码；必须备份并跨重启保持稳定 |
| `PORT` | 监听端口，默认 3000 |
| `MIGRATE_ON_START` | 启动时自动执行未完成的数据库迁移；设为 `false` 时需自行运行 `node dist/scripts/migrate.js` |

连接器凭证在后台配置；`.env.example` 中 GitHub 相关变量仅用于兼容旧版的一次性导入。

## 开发与验证

```bash
npm run typecheck
npm test
npm run build
# 在独立随机 schema 内测试，结束后清理；建议使用专用测试数据库。
TEST_DATABASE_URL='postgres://connany:connany@localhost:54329/connany' npm run test:integration
npx playwright install chromium
TEST_DATABASE_URL='postgres://connany:connany@localhost:54329/connany' npm run test:browser
```

浏览器测试使用模拟平台，不能替代真实账号授权验证。GitHub Actions 执行类型检查、构建、单元、集成和浏览器测试；`main` 分支和 `v*` 标签测试通过后会构建多架构镜像并推送到 GHCR。

```text
src/          Hono 服务、授权流程、连接器和管理后台
public/       管理后台、API 文档与品牌资源
sdk/          无依赖 TypeScript 服务端 SDK
migrations/   PostgreSQL 迁移
scripts/      环境初始化、迁移和管理员命令
examples/     Agent 接入示例
deploy/       Docker Compose 与 Kubernetes 部署模板
docs/         接入、配置和运行文档
tests/        单元、集成及浏览器测试
```

## 当前边界

- 连接器配置由多个项目共享；平台侧授权可能复用，项目内隔离不等于独立的上游 OAuth grant。
- 当前使用 REST/SDK 和事件轮询，尚无对 Agent 的 MCP 服务端或推送 webhook。每个后台用户拥有独立的工作空间（连接器、项目、用户连接各自隔离），同一工作空间内的项目共用连接器配置。
- 无自动凭证主密钥轮换、审计数据清理或上游撤销重试 worker。
- 公开部署需自行配置 HTTPS、数据库备份和入口限流。

详见 [架构、运维与限制](docs/operations.md)。欢迎通过 Issue 和 Pull Request 参与改进。

## License

代码采用 [MIT License](LICENSE)。第三方名称和品牌资产归各自所有者所有，不因本项目 MIT 协议授予商标权；见 [第三方声明](THIRD_PARTY_NOTICES.md)。
