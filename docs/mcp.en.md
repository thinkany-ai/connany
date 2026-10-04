# MCP and skill

Connany is also an MCP server. Add it once to an agent such as Claude Code, Codex or Cursor, and use every enabled connector with your own accounts, for example "how many active users did PostHog record yesterday?" or "turn this week's Linear issues into a Notion page".

This complements the [agent integration guide](agent-integration.md):

| | REST API / SDK | MCP + skill |
| --- | --- | --- |
| For | Teams building agent products | Individuals using an existing agent |
| Identity | Project API key + `external_user_id` | The user's own Connany account (OAuth sign-in) |
| Connections belong to | End users of a project | The user's "Personal MCP" project |

## Set up

The commands below use this deployment's address.

**1. Add the MCP server**

```bash
# Claude Code: then run /mcp in Claude Code and choose connany to sign in
claude mcp add --transport http connany https://connany.example.com/mcp

# Codex
codex mcp add connany --url https://connany.example.com/mcp
codex mcp login connany
```

Other clients that support remote MCP servers with OAuth only need the server URL `https://connany.example.com/mcp`. On first use the client opens a browser: sign in to (or sign up for) Connany and click **Allow**.

**2. Install the skill (recommended)**

```bash
# Claude Code
mkdir -p ~/.claude/skills/connany && curl -fsSL https://connany.example.com/skills/connany/SKILL.md -o ~/.claude/skills/connany/SKILL.md
# Codex
mkdir -p ~/.codex/skills/connany && curl -fsSL https://connany.example.com/skills/connany/SKILL.md -o ~/.codex/skills/connany/SKILL.md
```

The skill tells the agent when to use Connany, how to hand the user a connection link and wait for them to finish, to read a tool's schema before calling it, and to confirm with the user before changing data. The served `SKILL.md` already contains this deployment's MCP URL; the source is `skills/connany/SKILL.md` in the repository.

**3. Use it in conversations**

A typical flow after the user asks something:

1. `list_connectors`: PostHog is not connected yet.
2. `connect` (`connector: "posthog"`): returns a link. The agent shows it, the user authorizes PostHog in the browser and says they are done.
3. `search_tools` (`query: "trends", connector: "posthog"`), then `describe_tool` for the parameters.
4. `call_read_tool` runs the read-only tool and the agent answers from the result.

Later questions about the same service need no new authorization. Connections appear in the console under **User connections**, in the **Personal MCP** project, and can be disconnected anytime.

## MCP tools

Connany does not list every upstream tool to the client (PostHog alone has about 750 tools and 5 MB of definitions, which would fill the agent's context). It offers six fixed tools:

| Tool | Purpose | Read-only |
| --- | --- | --- |
| `list_connectors` | Connected accounts (with `id` and status) and services that can be connected | Yes |
| `connect` | A connection link (single use, valid for 15 minutes); with `connection_id` it reauthorizes an existing connection | No |
| `search_tools` | Keyword search over the tools of connected services: name, read-only flag and summary | Yes |
| `describe_tool` | Full description and `input_schema` of one tool | Yes |
| `call_read_tool` | Call a read-only tool (upstream `readOnlyHint`) | Yes |
| `call_write_tool` | Call a tool that changes data | No (`destructiveHint`) |

Reads and writes are separate tools because clients set permissions per tool name: `call_read_tool` can run without prompts while `call_write_tool` asks every time. Whether a tool is read-only comes from the upstream MCP annotations, and `call_read_tool` refuses other tools. With several accounts of one service connected, calls need `connection_id`.

## Available connectors

Personal MCP connections use:

1. connectors enabled in the user's own workspace, otherwise
2. connectors enabled in the platform workspace (the first administrator's, `ws_default`).

Operators therefore enable connectors once under the administrator account and every user can connect. A connector the user enabled themselves takes precedence.

## Protocol and security

- **Transport:** Streamable HTTP, `POST /mcp`, stateless JSON responses (no SSE, no sessions); MCP protocol versions `2025-11-25`, `2025-06-18`, `2025-03-26` and `2024-11-05`. Request bodies up to 1 MB.
- **OAuth 2.1:**
  - Discovery: `/.well-known/oauth-protected-resource/mcp` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414). Unauthorized `/mcp` requests get 401 with `WWW-Authenticate: Bearer resource_metadata=…`.
  - Dynamic client registration `POST /oauth2/register` (RFC 7591) issues public clients only (`token_endpoint_auth_method: none`). Redirect URIs must be HTTPS, loopback HTTP or an app scheme; loopback URIs may use another port (RFC 8252).
  - Authorization `GET /oauth2/authorize` requires PKCE S256 and continues on the console's sign-in and consent pages; `resource` must be this server's `/mcp`.
  - Tokens `POST /oauth2/token`: codes are valid for 10 minutes and single use (reuse revokes the grant); access tokens last 1 hour, refresh tokens 30 days and rotate on every refresh.
  - Revocation `POST /oauth2/revoke` (RFC 7009); users can also revoke clients in the console under **Settings → Authorized apps**.
- Only hashes of codes and tokens are stored. A token can only reach its user's personal project; each user can make up to 120 MCP tool requests per minute.
- Upstream content can contain text written by other people; the skill tells the agent to treat it as data, not instructions.
