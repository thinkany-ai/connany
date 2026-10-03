<p align="center"><img src="public/brand/logo.svg" width="80" alt="Connany logo"></p>
<h1 align="center">Connany</h1>
<p align="center">Connect agents to your users’ tools, accounts, and workspaces.</p>
<p align="center"><a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a></p>

Connany is an open-source, multi-tenant connector service for agent applications. It manages user authorization, connections, and credentials so your agent backend can list tools and work with authorized data through a REST API or TypeScript SDK, without handling provider tokens.

It ships with 25 connectors: **Notion, GitHub (App + MCP), Linear**, plus official hosted MCP servers for Sentry, PostHog, Atlassian, Vercel, Supabase, Neon, Netlify, GitLab, Cloudflare, Prisma, Stripe, PayPal, Square, ClickUp, monday.com, Airtable, Todoist, Miro, Canva, Intercom, Webflow and Wix. MCP is used to connect to upstream services; Connany exposes a REST API and SDK to agents, rather than hosting general-purpose MCP servers.

## Features

- **Admin console:** configure connectors once and sync their tool catalogs, create a project for each agent, manage each project's API keys (zero-downtime rotation), inspect user connections and activity, read the API docs and agent integration guide, and (as an administrator) manage console users as administrators or members.
- **User authorization:** hosted OAuth pages, single-use state, browser binding, and PKCE for GitHub and Linear.
- **Project isolation:** every API key belongs to a project; user data is scoped to `project_id + external_user_id`.
- **Connection management:** multiple accounts and workspaces, listing, active checks, reconnection, disconnection, and upstream revocation retries.
- **Tool listing and calls:** list the official MCP tools a user's connection can use with `GET /v1/connections/{id}/tools` (or browse each connector's catalog with `GET /v1/tools`), inspect parameter schemas and read/write metadata, and call them with `POST /v1/connections/{id}/tools/{name}/call`. The SDK can expose just two tools to a model: `list_tools` and `call_tool`.
- **Event feed:** one project-wide feed (`GET /v1/events`) reports connections, reauthorization needs, disconnections, and tool calls for every user.
- **Credential protection:** AES-256-GCM encryption for connector and user credentials, hashed API keys, and database transaction locks to coordinate token refresh and execution.

## Quick start

Requires Node.js 22+, npm, and PostgreSQL 15+. The following uses Docker to start a local database:

```bash
git clone git@github.com:thinkany-ai/connany.git
cd connany
npm ci
npm run setup
docker compose up -d postgres
npm run db:migrate
npm run admin:create -- admin@example.com
npm run dev   # or: make dev
```

Enter an administrator password of at least 8 characters when prompted. `npm run setup` creates `.env` with a random encryption key without overwriting an existing file. The root `compose.yaml` starts only PostgreSQL; its default password is for local development.

- Admin console: <http://localhost:3000/admin>; **Docs** in the sidebar holds the API docs and the agent integration guide.
- Public API docs: <http://localhost:3000/docs>, with English and Chinese content, copyable examples, and Markdown/SDK downloads.
- Health check: <http://localhost:3000/health>

To use an existing database, set `DATABASE_URL` in `.env` and skip the Docker step. If the port is occupied, update both `PORT` and `PUBLIC_BASE_URL`. For daily development, run `make dev`: it installs dependencies when the lockfile changes, starts PostgreSQL, applies migrations, and runs the server with hot reload (Docker is only used when `DATABASE_URL` points to the compose database on port 54329). Server changes restart the process, while static asset changes need a browser refresh.

## Configure connectors

| Connector | Setup | Capabilities |
| --- | --- | --- |
| Notion | Enable official MCP in the console; OAuth client registration is automatic | Pages, databases, and workspace search |
| GitHub | Configure a GitHub App’s Client ID, Client Secret, and App slug in the console | Repositories, issues, pull requests, and other official MCP tools |
| Linear | Enable official MCP in the console; OAuth client registration is automatic | Issues, projects, and team collaboration |
| 22 more hosted MCP servers | Same as Notion and Linear: enable in the console, registration is automatic | Error monitoring, analytics, deployments, databases, payments, project management, design, support and site builders |

After enabling a connector, click **Sync tool catalog** on its card once: upstream MCP servers list tools only to signed-in users, so you authorize with your own account and Connany keeps only the tool definitions. Users must still authorize their own accounts. GitHub repository access also requires installing the App and selecting repositories. See the [connector setup guide (Chinese)](docs/connector-setup.md).

## Integrate your agent

1. Create a project for your agent under **Projects** in the console and save its API key.
2. Configure the service URL and API key in your agent backend.
3. Create an authorization session for a user (`POST /v1/connectors/{name}/sessions`) and direct them to the hosted authorization page.
4. In conversations, give the model the tools of the user's connections and call them through those connections. If a needed connector is not connected yet, show an authorization button in the conversation.

Copy the dependency-free [TypeScript SDK](sdk/client.ts), or run the example:

```bash
export CONNANY_API_KEY='cn_live_replace_with_your_key'
npm run example:agent -- notion
# Also supports github / linear.
```

Keep API keys on the backend. The SDK’s two-tool adapter defaults to read-only access; your backend must explicitly set `allowWrites: true` to enable writes. Actual upstream access depends on the user’s authorization and provider permissions.

- [Agent integration guide (Chinese)](docs/agent-integration.md)
- [REST API reference](docs/api.en.md) · [中文 API 文档](docs/api.md)
- [Admin console guide (Chinese)](docs/admin.md)

## Docker deployment

The repository includes a Compose configuration for the application and PostgreSQL:

```bash
cp deploy/docker/.env.example deploy/docker/.env
# Edit .env: set POSTGRES_PASSWORD, TOKEN_ENCRYPTION_KEY, and the public origin.
# Generate the password with openssl rand -hex 24 and the key with openssl rand -base64 32.
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yaml up -d --build
docker compose --env-file deploy/docker/.env -f deploy/docker/compose.yaml exec app \
  node dist/scripts/create-admin.js admin@example.com
```

Once the database is healthy, migrations run before the application starts. The application binds to a loopback port; production deployments need an HTTPS reverse proxy. See the [Docker deployment guide (Chinese)](deploy/README.md#docker-compose) for environment variables, external databases, upgrades, and backups.

## Kubernetes deployment

`deploy/k8s/` contains templates for a Namespace, Deployment with a migration init container, Service, and HTTPS Ingress. It uses an external PostgreSQL database and injects credentials through a Secret.

1. Use the image GitHub Actions publishes to `ghcr.io/thinkany-ai/connany` (or build your own), then update the image tag, domain, and Ingress/TLS configuration in the templates.
2. Create the namespace and the `connany-runtime` Secret.
3. Apply the Deployment and Service, and wait for migrations and rollout to complete.
4. Create an administrator, then apply the Ingress.

See the [Kubernetes deployment guide (Chinese)](deploy/README.md#kubernetes) for full commands, private registries, upgrades, and troubleshooting.

## Environment variables

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string; configure TLS as required by your production database |
| `PUBLIC_BASE_URL` | Public HTTPS origin without a path; HTTP is allowed only for localhost / 127.0.0.1 |
| `TOKEN_ENCRYPTION_KEY` | 32 random bytes encoded as base64; back it up and keep it stable across restarts |
| `PORT` | Listening port; defaults to 3000 |
| `MIGRATE_ON_START` | Pending database migrations run automatically at startup; set to `false` to run them yourself with `node dist/scripts/migrate.js` |

Configure connector credentials in the console. The GitHub variables in `.env.example` support a one-time import for compatibility with older configurations.

## Development and validation

```bash
npm run typecheck
npm test
npm run build
# Tests use isolated random schemas and clean them up afterward. A dedicated test database is recommended.
TEST_DATABASE_URL='postgres://connany:connany@localhost:54329/connany' npm run test:integration
npx playwright install chromium
TEST_DATABASE_URL='postgres://connany:connany@localhost:54329/connany' npm run test:browser
```

Browser tests use simulated upstream services and do not replace authorization testing with real accounts. GitHub Actions runs type checks, builds, unit tests, integration tests, and browser tests, then publishes a multi-arch image to GHCR for `main` and `v*` tags.

```text
src/          Hono service, authorization flows, connectors, and admin console
public/       Admin console assets, API docs assets, and branding
sdk/          Dependency-free TypeScript backend SDK
migrations/   PostgreSQL migrations
scripts/      Environment setup, migrations, and administrator commands
examples/     Agent integration examples
deploy/       Docker Compose and Kubernetes deployment templates
docs/         Integration, configuration, and operations documentation
tests/        Unit, integration, and browser tests
```

## Current limitations

- Connector configuration is shared across projects, and upstream authorization may be reused. Project isolation does not imply separate upstream OAuth grants.
- The current interfaces are REST/SDK and event polling. There is no agent-facing MCP server or push webhook delivery yet. Each console user has their own workspace with its own connectors, projects and connections; projects within a workspace share its connector configuration.
- There is no automatic credential master-key rotation, audit retention cleanup, or background worker for upstream revocation retries.
- Public deployments must configure HTTPS, database backups, and ingress rate limiting.

See [architecture, operations, and limitations (Chinese)](docs/operations.md). Issues and pull requests are welcome.

## License

The code is licensed under the [MIT License](LICENSE). Third-party names and brand assets belong to their respective owners; the MIT license does not grant trademark rights. See [third-party notices](THIRD_PARTY_NOTICES.md).
