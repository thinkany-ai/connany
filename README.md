<p align="center"><img src="public/brand/logo.svg" width="80" alt="Connany logo"></p>
<h1 align="center">Connany</h1>
<p align="center">连接 Agent 与用户的工具、账号和工作空间。</p>

Connany 是面向 Agent 产品的开源多租户连接器服务。统一管理用户授权、连接和凭证，Agent 后端通过 REST API 或 TypeScript SDK 发现工具、操作已授权数据，无需接触平台 token。

支持 **Notion MCP、GitHub App + MCP、Linear MCP**。MCP 是上游接入方式；Connany 当前对 Agent 提供 REST API 和 SDK，不是通用 MCP Server 托管平台。

## 功能

- 管理后台：连接器配置、API Key 创建/停用/轮换、用户连接及操作记录。
- 用户授权：托管 OAuth 页面、一次性 state、浏览器绑定、GitHub/Linear PKCE。
- 多租户隔离：按 API Key 所属项目和 `external_user_id` 校验用户数据归属。
- 连接管理：多账号和工作区、查询、主动检查、重连、断开及上游撤销重试。
- 工具发现与调用：动态搜索官方 MCP 工具、参数 schema 和读写标记；SDK 可仅向模型暴露 `discover_actions` / `execute_action` 两个工具。
- 凭证保护：AES-256-GCM 加密平台凭证、API Key 仅保存哈希、事务锁协调刷新和调用。

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
npm run dev
```

管理员密码交互输入，至少 12 位。`npm run setup` 生成 `.env` 和随机加密密钥，不覆盖已有文件。根目录 `compose.yaml` 仅启动本地 PostgreSQL，默认密码仅供开发。

- 管理后台：<http://localhost:3000/admin>
- 公开 API 文档：<http://localhost:3000/docs>，支持中英文、代码复制、Markdown 和 SDK 下载。
- 健康检查：<http://localhost:3000/health>

已有数据库时直接配置 `.env` 的 `DATABASE_URL`，跳过 Docker 步骤。端口占用时同时修改 `PORT` 和 `PUBLIC_BASE_URL`。日常开发运行 `npm run dev`，服务端修改自动重启，静态页面资源刷新即可。

## 配置连接器

| 连接器 | 配置方式 | 能力 |
| --- | --- | --- |
| Notion | 后台一键启用官方 MCP，自动注册 OAuth 客户端 | 页面、数据库、工作区搜索 |
| GitHub | 后台配置 GitHub App 的 Client ID、Client Secret、App slug | 仓库、Issue、Pull Request 等官方 MCP 工具 |
| Linear | 后台一键启用官方 MCP，自动注册 OAuth 客户端 | Issue、项目、团队协作 |

用户仍需授权自己的账号；GitHub 仓库访问还需要安装 App 并选择仓库。详见 [连接器配置](docs/provider-setup.md)。

## Agent 接入

1. 在后台「API Keys」创建并保存密钥，登记授权返回地址。
2. 将服务地址和 API Key 配置到 Agent 后端。
3. 为用户创建连接会话，引导用户在托管页面完成授权。
4. 按用户和连接发现工具、执行调用。

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

1. 构建并推送镜像，修改模板的镜像、域名与 Ingress/TLS 配置。
2. 创建命名空间和 `connany-runtime` Secret。
3. 应用 Deployment/Service，等待迁移和 rollout 完成。
4. 创建管理员后应用 Ingress。

完整命令、私有镜像、升级及故障排查见 [Kubernetes 部署说明](deploy/README.md#kubernetes)。模板镜像地址不代表镜像已发布。

## 环境变量

| 变量 | 含义 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接串；生产按数据库要求配置 TLS |
| `PUBLIC_BASE_URL` | 公开 HTTPS origin，无路径；仅 localhost / 127.0.0.1 允许 HTTP |
| `TOKEN_ENCRYPTION_KEY` | 32 字节随机值的 base64 编码；必须备份并跨重启保持稳定 |
| `PORT` | 监听端口，默认 3000 |

平台凭证在后台配置；`.env.example` 中 GitHub 相关变量仅用于兼容旧版的一次性导入。

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

浏览器测试使用模拟平台，不能替代真实账号授权验证。GitHub Actions 执行类型检查、构建、单元、集成和浏览器测试。

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

- 平台配置由多个项目共享；平台侧授权可能复用，项目内隔离不等于独立的上游 OAuth grant。
- 当前使用 REST/SDK 和事件轮询，尚无对 Agent 的 MCP 服务端、推送 webhook 或按项目自带 OAuth 应用。
- 无自动凭证主密钥轮换、审计数据清理或上游撤销重试 worker。
- 公开部署需自行配置 HTTPS、数据库备份和入口限流。

详见 [架构、运维与限制](docs/operations.md)。欢迎通过 Issue 和 Pull Request 参与改进。

## License

代码采用 [MIT License](LICENSE)。第三方名称和品牌资产归各自所有者所有，不因本项目 MIT 协议授予商标权；见 [第三方声明](THIRD_PARTY_NOTICES.md)。
