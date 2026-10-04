-- Connany as an MCP server for end users (Claude Code, Codex, ...).
-- A personal project holds one console user's own connections. It has no API keys and is
-- reached only through OAuth grants issued to MCP clients; it stays out of the project list.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'api';
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_kind_check;
ALTER TABLE projects ADD CONSTRAINT projects_kind_check CHECK (kind IN ('api','personal'));
ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_id text REFERENCES admin_users(id);
CREATE UNIQUE INDEX IF NOT EXISTS projects_personal_owner ON projects(owner_id) WHERE kind = 'personal';

-- OAuth 2.1 clients registered dynamically (RFC 7591). Public clients only: PKCE, no secret.
CREATE TABLE IF NOT EXISTS oauth_clients (
  id text PRIMARY KEY,
  client_name text NOT NULL DEFAULT '',
  redirect_uris jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per authorization a user granted to a client: the single-use code, then the
-- current access / refresh token pair (rotated on refresh). Only hashes are stored.
CREATE TABLE IF NOT EXISTS oauth_grants (
  id text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  code_hash text UNIQUE,
  code_challenge text NOT NULL,
  code_expires_at timestamptz NOT NULL,
  access_hash text UNIQUE,
  access_expires_at timestamptz,
  refresh_hash text UNIQUE,
  refresh_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS oauth_grants_user ON oauth_grants(user_id);
