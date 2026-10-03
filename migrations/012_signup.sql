-- System-wide settings changed from the console. signup_enabled lets visitors create
-- member accounts (each with its own workspace); it is off until an administrator opens it.
CREATE TABLE IF NOT EXISTS system_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
