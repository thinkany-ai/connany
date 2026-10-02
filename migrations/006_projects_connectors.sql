-- Terminology: a workspace owns connectors (with their OAuth apps) and projects;
-- a project owns API keys and its users' connections. Only one workspace exists today.
CREATE TABLE IF NOT EXISTS workspaces (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO workspaces(id,name) VALUES('ws_default','Default') ON CONFLICT(id) DO NOTHING;

ALTER TABLE projects ADD COLUMN IF NOT EXISTS workspace_id text NOT NULL DEFAULT 'ws_default' REFERENCES workspaces(id);

CREATE TABLE IF NOT EXISTS api_keys (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_project ON api_keys(project_id);
INSERT INTO api_keys(id,project_id,key_hash,key_prefix,created_at)
SELECT 'key_' || substr(md5(p.id),1,24), p.id, p.api_key_hash, COALESCE(p.key_prefix,'cn_live_'), p.key_created_at FROM projects p;
ALTER TABLE projects DROP COLUMN api_key_hash, DROP COLUMN key_prefix, DROP COLUMN key_created_at;

ALTER TABLE provider_apps RENAME TO connector_apps;
ALTER TABLE connector_apps RENAME COLUMN provider TO connector;
ALTER TABLE connector_apps ADD COLUMN workspace_id text NOT NULL DEFAULT 'ws_default' REFERENCES workspaces(id);
ALTER TABLE connector_apps DROP CONSTRAINT IF EXISTS provider_apps_provider_client_id_key;
ALTER TABLE connector_apps ADD CONSTRAINT connector_apps_workspace_connector_client_key UNIQUE(workspace_id,connector,client_id);

ALTER TABLE provider_settings RENAME TO connectors;
ALTER TABLE connectors RENAME COLUMN provider TO name;
ALTER TABLE connectors ADD COLUMN workspace_id text NOT NULL DEFAULT 'ws_default' REFERENCES workspaces(id);
ALTER TABLE connectors DROP CONSTRAINT provider_settings_pkey;
ALTER TABLE connectors ADD PRIMARY KEY (workspace_id,name);

ALTER TABLE connections RENAME COLUMN provider TO connector;
ALTER TABLE connections RENAME COLUMN provider_app_id TO connector_app_id;
ALTER INDEX IF EXISTS connections_provider_app RENAME TO connections_connector_app;
ALTER TABLE connect_sessions RENAME COLUMN provider TO connector;
ALTER TABLE connect_sessions RENAME COLUMN provider_app_id TO connector_app_id;

UPDATE admin_audit SET action='connector.saved' WHERE action='provider.saved';
