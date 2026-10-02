-- Each console user owns a workspace; projects, connectors and connections belong to a
-- workspace, so users never see each other's data.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS owner_id text REFERENCES admin_users(id);
CREATE INDEX IF NOT EXISTS workspaces_owner ON workspaces(owner_id);
-- Existing data lives in the default workspace: give it to the first administrator.
UPDATE workspaces SET owner_id=(SELECT id FROM admin_users WHERE role='admin' ORDER BY created_at, id LIMIT 1)
WHERE id='ws_default' AND owner_id IS NULL;
-- Every other existing user starts with an empty workspace of their own.
INSERT INTO workspaces(id,name,owner_id)
SELECT 'ws_' || substr(md5(u.id),1,24), u.email, u.id FROM admin_users u
WHERE NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.owner_id=u.id);
-- Administrator tool syncs run without a project, so they record their workspace.
ALTER TABLE connect_sessions ADD COLUMN IF NOT EXISTS workspace_id text REFERENCES workspaces(id);
