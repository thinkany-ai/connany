-- Provider names are validated against the code catalog (src/providers/catalog.ts),
-- so adding a built-in provider does not require a schema change.
ALTER TABLE connect_sessions DROP CONSTRAINT IF EXISTS connect_sessions_provider_check;
ALTER TABLE connections DROP CONSTRAINT IF EXISTS connections_provider_check;
ALTER TABLE provider_apps DROP CONSTRAINT IF EXISTS provider_apps_provider_check;
ALTER TABLE provider_settings DROP CONSTRAINT IF EXISTS provider_settings_provider_check;
