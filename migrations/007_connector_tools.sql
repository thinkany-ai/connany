-- Tool catalog per connector. Upstream MCP servers only list tools to signed-in users, so the
-- catalog is captured from an administrator sync or a user's own authorization and cached here.
CREATE TABLE IF NOT EXISTS connector_tools (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  connector text NOT NULL,
  tools jsonb NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, connector)
);
-- Administrator tool-sync authorizations reuse the OAuth session flow without belonging to a project.
ALTER TABLE connect_sessions ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'connection';
ALTER TABLE connect_sessions ALTER COLUMN project_id DROP NOT NULL;
