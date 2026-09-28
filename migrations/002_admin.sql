CREATE TABLE IF NOT EXISTS admin_users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash text PRIMARY KEY,
  admin_id text NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS admin_login_limits (
  bucket text PRIMARY KEY,
  window_start timestamptz NOT NULL,
  count integer NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit (
  seq bigserial PRIMARY KEY,
  admin_id text NOT NULL REFERENCES admin_users(id),
  action text NOT NULL,
  target text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS provider_apps (
  id text PRIMARY KEY,
  provider text NOT NULL CHECK(provider IN ('notion','github','linear')),
  client_id text NOT NULL,
  secret_ciphertext text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider,client_id)
);
CREATE TABLE IF NOT EXISTS provider_settings (
  provider text PRIMARY KEY CHECK(provider IN ('notion','github','linear')),
  active_app_id text REFERENCES provider_apps(id),
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS key_prefix text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS key_created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE projects ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE connect_sessions ADD COLUMN IF NOT EXISTS provider_app_id text REFERENCES provider_apps(id);
ALTER TABLE connections ADD COLUMN IF NOT EXISTS provider_app_id text REFERENCES provider_apps(id);
CREATE INDEX IF NOT EXISTS connections_provider_app ON connections(provider_app_id);
