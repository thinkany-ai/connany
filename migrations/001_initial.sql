CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  api_key_hash text NOT NULL UNIQUE,
  return_urls jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS connections (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  external_user_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('notion','github','linear')),
  status text NOT NULL CHECK (status IN ('connected','reauth_required','revoked')),
  identity jsonb NOT NULL,
  credential_ciphertext text,
  expires_at timestamptz,
  revocation_status text NOT NULL DEFAULT 'not_requested',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connections_owner ON connections(project_id, external_user_id);
CREATE TABLE IF NOT EXISTS connect_sessions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  external_user_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('notion','github','linear')),
  return_url text,
  link_hash text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending',
  state_hash text UNIQUE,
  browser_hash text,
  verifier_ciphertext text,
  connection_id text REFERENCES connections(id),
  reconnect_id text REFERENCES connections(id),
  error_code text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS events (
  seq bigserial PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id),
  external_user_id text NOT NULL,
  type text NOT NULL,
  connection_id text,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_owner ON events(project_id, external_user_id, seq);
CREATE TABLE IF NOT EXISTS rate_limits (
  project_id text PRIMARY KEY REFERENCES projects(id),
  window_start timestamptz NOT NULL,
  count integer NOT NULL
);
