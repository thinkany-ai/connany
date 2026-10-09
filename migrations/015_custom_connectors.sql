-- Remote MCP servers one user of a project added by URL (docs/custom-connectors.md).
-- The connector name (mcp_<10 hex>) is derived from project, user and URL, so adding the same
-- server again finds the same row. Its OAuth client lives in connector_apps / connectors like a
-- built-in hosted MCP connector's, in the project's workspace.
CREATE TABLE IF NOT EXISTS custom_connectors (
  name text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  external_user_id text NOT NULL,
  url text NOT NULL,
  label text NOT NULL,
  website text NOT NULL,
  -- McpSpec: origin, endpoint, oauth endpoints, scope, clientAuth, resource.
  spec jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT custom_connectors_name CHECK (name ~ '^mcp_[a-z0-9]{10}$')
);
CREATE INDEX IF NOT EXISTS custom_connectors_owner ON custom_connectors(project_id, external_user_id);
