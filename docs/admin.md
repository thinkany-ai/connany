# Connany 管理后台

管理后台位于 `/admin`。它面向运营 Connany 的管理员；接入的 agent 产品使用项目 API key，不使用管理员登录凭证。

## 首次启动

```bash
npm ci
npm run setup             # 已有 .env 会保留
# .env 只需确认 DATABASE_URL、PUBLIC_BASE_URL、TOKEN_ENCRYPTION_KEY
docker compose up -d postgres
npm run db:migrate
npm run admin:create -- admin@example.com
# 交互输入至少 12 位密码，不会回显
npm run dev
```

打开 http://localhost:3000/admin。无需在 `.env` 填平台 Client ID / Secret。

如果 3000 被其他项目占用，可以使用：

```bash
PORT=3100 PUBLIC_BASE_URL=http://localhost:3100 npm run dev
```

对应后台是 http://localhost:3100/admin，平台 callback 也应使用 3100。长期使用时把 `PORT` 和 `PUBLIC_BASE_URL` 一起写入 `.env`，与平台回调地址保持一致。

已有旧版本数据库先运行 `npm run db:migrate`，再重启服务。迁移保留已有项目及 API key。旧 `.env` 中完整的平台凭证会在首次启动时加密导入数据库，已有连接绑定到原应用；已有数据库配置不会被环境变量覆盖。

忘记密码时再次运行 `admin:create`，使用相同邮箱即可重置；该账号的既有登录会话会立即失效。

自动化部署支持 `--password-stdin`，从安全的 secret 注入渠道把密码传到标准输入；不要把密码写进命令行参数。生产建议把 `/admin` 放在组织的访问控制网关之后。

## 操作流程

### 1. 配置共享平台

进入「连接器」。Notion、Linear 等官方 MCP 连接器在卡片上点「启用」即可，自动注册客户端。GitHub 点「配置」，在弹框中填写 Client ID、Client Secret 和 App slug，并将弹框中的回调地址填入 GitHub App。

- 每个平台只配一次，所有 agent 项目共用当前默认应用。
- 页面展示准确的 callback URL，可直接复制到第三方平台后台。
- Secret 加密落库，保存后不回显。编辑时留空表示保留**同一 Client ID** 已存的 Secret。
- 首次配置或换成新 Client ID 时，必须填写新 Secret。
- 保存后立即生效，不需要重启；其他服务实例也从同一个数据库读取。
- 「接受新的用户授权」控制新会话和未启动会话；暂停不切断已有用户连接。要断开已有连接请到「用户连接」。已经开始的授权回调仍可完成。
- 「已启用」表示配置完整且允许发起授权，不代表已经经过真实平台认证。仍需做一次真实用户授权联调。
- 「同步工具目录」：上游官方 MCP 只向已登录用户提供工具列表。启用连接器后点击卡片上的「同步工具目录」，用你自己的账号授权一次，Connany 读取工具列表后立即撤销这次授权的令牌，不创建用户连接。之后 `GET /v1/tools` 即可返回该连接器的工具；用户授权或检查连接时目录也会自动更新。官方工具有变化时可再次同步。

平台后台设置细节见 [connector-setup.md](connector-setup.md)。

### 2. 为每个 Agent 或环境创建项目

术语：

- **连接器**：Notion、GitHub、Linear 等平台集成，在「连接器」中配置一次，所有项目共用。
- **项目**：一个接入 Connany 的 agent 产品或环境。用户连接、授权会话和事件都属于项目，`project_id + external_user_id` 唯一确定一个用户。
- **API Key**：访问某个项目的凭证。一个项目可以有多把 Key（最多 2 把有效），可以单独吊销。
- **工作空间**：数据库已预留 `workspaces` 表，连接器和项目都挂在默认工作空间下。后续支持多工作空间时，每个工作空间有自己的一套连接器和项目。

进入「项目」点「创建项目」，填写名称（例如 FastClaw 开发环境）。创建时会生成第一把 API Key，完整 Key 只在弹窗中显示一次，复制并安全保存到该 agent 的后端。Connany 只保存哈希和显示前缀，之后不能再查看。授权后返回地址由 Agent 后端在每次创建会话时传入，无需在后台登记。

不同 Agent 或开发/正式环境应分别创建项目，不要共用同一把 Key。

项目详情页支持：

- 重命名项目。
- 新建 API Key：可填写备注名（如 production）。每个项目最多 2 把有效 Key。
- 吊销 API Key：该 Key 立即失效，项目下的用户连接不受影响。
- 轮换：先新建 Key 并部署到 agent 后端，确认切换后再吊销旧 Key。期间两把 Key 同时有效，不会中断服务。
- 停用：项目的所有 Key 都无法调用 API，取消尚未开始/正在授权的会话。保留用户连接和审计，不直接撤销全部上游授权。已在执行中的请求可能完成。
- 启用：项目的有效 Key 恢复可用，已取消的授权会话不会复活，需要重新生成。
- 删除项目：所有 Key 立即失效，逐个撤销项目下用户连接的上游授权（尽力而为，失败不阻塞），随后删除用户连接、授权会话和事件记录，无法恢复。操作记录保留删除审计。

旧的 `/admin/keys` 地址会跳转到 `/admin/projects`。

「总览 → 查看接入说明」可下载完整 Markdown 文档及 TypeScript SDK。将服务地址、项目的 API Key 和文档交给对应 agent 开发者。

### 3. 查看用户连接与操作记录

「用户连接」可按 Project ID、连接器筛选；项目详情页也有入口，查看账号、工作区及状态；支持断开连接和重试失败的上游撤销。本地断开成功即禁止后续调用，平台撤销结果另外显示。

「操作记录」展示最近 100 条用户事件及管理员操作，不保存凭证和资源正文。后台时间显示为 UTC+8。

## 多个 Agent 共用应用的边界

支持这样的关系：

```text
一套连接器配置（Notion / GitHub / Linear）
                │
             Connany
        ┌───────┴───────┐
    项目 A           项目 B
      API Keys A      API Keys B
      用户连接 A       用户连接 B
```

用户仍需在每个 agent 中授权自己的账号。不同项目中相同的 `external_user_id` 不会被视为同一个 Connany 用户。一个项目的 key 无权调用另一个项目的连接。

这属于 Connany 内的逻辑隔离。平台授权页显示共享应用的品牌，而非每个 agent 的品牌；平台侧也可能复用、合并或一起撤销同一应用的授权。因此不能承诺跨项目独立的上游 OAuth grant。需要独立品牌、上游权限或撤销边界的客户，后续应采用按项目独立应用配置。

## 更换应用与更新 Secret

会话和连接都绑定 `connector_app_id`：

- 更换默认 Client ID 后，**新连接**使用新应用。
- 已生成的会话、已有连接及其重连继续使用原应用，防止 code/token 被错发给另一个 client。
- 同一 Client ID 更新 Secret 后，该应用下的新旧连接都会使用最新 Secret。
- 原应用配置会加密保留给旧连接使用，不会因切换默认应用删除。

当前编辑页面显示默认应用。如果要更新旧应用的 Secret，可以先以旧 Client ID 和新 Secret 保存，再切回目标默认应用（已存在的 Secret 可留空）；切换期间新会话会使用当时的默认应用，因此维护期间可暂停新授权。尚未提供独立的历史应用配置页面。

## 管理员安全机制

- 管理员通过服务端 CLI 创建，无公开注册入口。
- 密码使用带随机盐的 scrypt 哈希保存，登录 Cookie 为 HttpOnly、SameSite=Strict；HTTPS 下启用 Secure。
- 登录会话 8 小时有效；退出和重置密码可撤销会话。
- 管理写入接口校验 Origin、JSON Content-Type 和会话绑定的 CSRF token。
- 登录按账号及全局进行数据库限流：每账号 15 分钟最多 10 次、全局最多 100 次；成功登录重置该账号的计数。
- 后台只展示必要元数据；平台 Secret、用户 token、项目 key 哈希均不通过查询接口返回。
- HTML/JSON 使用 no-store；完整 API key 不进入 URL、localStorage 或 sessionStorage。
- `TOKEN_ENCRYPTION_KEY` 仍由环境/secret manager 管理，不在后台修改；需备份并保持稳定。

## 连接测试与 Agent 接入提示

「连接测试」页面地址为 `/admin/test`。创建测试专用 API Key，填入该 key 和测试用户 ID，选择平台，创建链接并在新标签页完成授权；返回后点击「检查授权结果」「试读数据」。测试直接使用正式 `/v1` API，验证项目密钥、OAuth 和只读调用。密钥仅保留在当前页面，刷新清空，不写入浏览器存储。测试连接会保留在「用户连接」中，按需断开；断开可能影响上游同一应用的共享授权。

`/admin/guide` 提供可复制的完整开发 Agent 提示与 Markdown 下载，自动带入当前服务地址，不包含密钥。API key 应另外配置到接入方后端环境变量。当前地址如果是 localhost，远程 agent 后端不可直接访问，需要先部署可访问的服务并更新回调地址。

GitHub 测试将账号授权与安装分开。授权后试读会列出组织，提供「添加组织 / 仓库」「管理仓库权限」入口，选择某个组织再试读仓库；安装或修改后再次点击试读刷新列表。
