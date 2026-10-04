# MCP 与 Skill 接入

Connany 本身也是一个 MCP Server。普通用户在 Claude Code、Codex、Cursor 等 agent 中添加一次 Connany，就能用自己的账号使用所有已启用的连接器，例如在 Claude Code 中说「查一下 PostHog 昨天的活跃用户」「把这周的 Linear issue 整理成 Notion 页面」。

这与 [Agent 接入指南](agent-integration.md) 是两种用法：

| | REST API / SDK | MCP + Skill |
| --- | --- | --- |
| 面向 | 开发 agent 产品的团队 | 使用现成 agent 的个人 |
| 身份 | 项目 API Key + `external_user_id` | 用户自己的 Connany 账号（OAuth 登录） |
| 连接归属 | 项目下的终端用户 | 用户的「个人 MCP」项目 |

## 用户如何接入

以下命令中的地址已替换为当前部署。

**1. 添加 MCP 服务**

```bash
# Claude Code：添加后在 Claude Code 中运行 /mcp，选择 connany 登录
claude mcp add --transport http connany https://connany.example.com/mcp

# Codex
codex mcp add connany --url https://connany.example.com/mcp
codex mcp login connany
```

其他支持远程 MCP 和 OAuth 的客户端，填写服务地址 `https://connany.example.com/mcp` 即可。首次连接时客户端会打开浏览器：登录（或注册）Connany 账号，在授权页点「允许」。

**2. 安装 Skill（推荐）**

```bash
# Claude Code
mkdir -p ~/.claude/skills/connany && curl -fsSL https://connany.example.com/skills/connany/SKILL.md -o ~/.claude/skills/connany/SKILL.md
# Codex
mkdir -p ~/.codex/skills/connany && curl -fsSL https://connany.example.com/skills/connany/SKILL.md -o ~/.codex/skills/connany/SKILL.md
```

Skill 告诉 agent 什么时候该用 Connany、如何把连接链接交给用户并等待授权完成、调用前先读参数说明、修改数据前先向用户确认。服务端返回的 `SKILL.md` 已填好当前部署的 MCP 地址；源文件在仓库的 [`skills/connany/SKILL.md`](../skills/connany/SKILL.md)。

**3. 在对话中使用**

用户提出需求后，agent 的典型流程：

1. `list_connectors`：发现 PostHog 还没连接。
2. `connect`（`connector: "posthog"`）：返回连接链接，agent 把链接发给用户，并调用 `wait_for_connection` 等待。用户在浏览器中授权 PostHog 后，agent 立即继续，用户不需要回到对话确认；授权成功页会提示回到发起连接的客户端（如 Codex）。
3. `search_tools`（`query: "trends", connector: "posthog"`）→ `describe_tool` 查看参数。
4. `call_read_tool` 调用只读工具，根据结果回答。

之后再问同一服务不需要重新授权。连接显示在后台「用户连接」的「个人 MCP」项目下，可随时断开。

## MCP 工具

Connany 不把上游的工具逐个暴露给客户端（PostHog 一家就有约 750 个工具、约 5 MB 定义，会占满 agent 的上下文），而是提供 7 个固定工具：

| 工具 | 说明 | 只读 |
| --- | --- | --- |
| `list_connectors` | 已连接的账号（含 `id`、状态）和可连接的服务 | 是 |
| `connect` | 生成连接链接（15 分钟内有效，连接成功后失效）；传 `connection_id` 则重新授权已有连接 | 否 |
| `wait_for_connection` | 用户打开链接后等待授权完成（每次最多约 45 秒，未完成返回 `pending` 可再次调用），完成后返回新连接 | 是 |
| `search_tools` | 按关键词搜索已连接服务的工具，返回名称、是否只读和简介 | 是 |
| `describe_tool` | 某个工具的完整说明和 `input_schema` | 是 |
| `call_read_tool` | 调用只读工具（上游标记 `readOnlyHint`） | 是 |
| `call_write_tool` | 调用会修改数据的工具 | 否（`destructiveHint`） |

读写分成两个工具：客户端按工具名设置权限，可以让 `call_read_tool` 免确认、`call_write_tool` 每次确认。工具是否只读由上游 MCP 的标注决定，`call_read_tool` 会拒绝调用非只读工具。同一服务连接了多个账号时，调用需要传 `connection_id`。

## 可用的连接器

个人 MCP 使用的连接器配置：

1. 用户自己工作空间中已启用的连接器；
2. 否则使用平台工作空间（第一个系统管理员的工作空间，即 `ws_default`）中已启用的连接器。

因此运营方只需在管理员账号下启用连接器，所有注册用户都能直接连接。用户自己在「连接器」中启用的同名连接器优先。

## 协议与安全

- **传输**：Streamable HTTP，`POST /mcp`，无状态 JSON 响应（不使用 SSE 和会话）；支持 MCP 协议版本 `2025-11-25`、`2025-06-18`、`2025-03-26`、`2024-11-05`。请求体上限 1 MB。
- **OAuth 2.1**：
  - 发现：`/.well-known/oauth-protected-resource/mcp`（RFC 9728）、`/.well-known/oauth-authorization-server`（RFC 8414）；未授权的 `/mcp` 请求返回 401 和 `WWW-Authenticate: Bearer resource_metadata=…`。
  - 动态客户端注册 `POST /oauth2/register`（RFC 7591），只发放公开客户端（`token_endpoint_auth_method: none`）。回调地址须为 HTTPS、本机 HTTP 或应用自定义协议；本机地址允许端口不同（RFC 8252）。
  - 授权 `GET /oauth2/authorize`：要求 PKCE S256，跳转到后台登录和授权页；`resource` 只能是本服务的 `/mcp`。
  - 令牌 `POST /oauth2/token`：授权码 10 分钟有效且只能用一次（重复使用会吊销该授权）；访问令牌 1 小时，刷新令牌 30 天且每次刷新轮换。
  - 吊销 `POST /oauth2/revoke`（RFC 7009）；用户也可以在后台「设置 → 授权应用」中撤销已授权的客户端。
- 数据库只保存授权码和令牌的哈希。每个令牌只能访问其用户的个人项目；每个用户每分钟最多 120 次 MCP 工具请求。
- 上游返回的内容可能包含他人写入的文本，Skill 要求 agent 把它当作数据而不是指令。
