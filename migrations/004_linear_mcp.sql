UPDATE connections SET status='reauth_required',updated_at=now()
WHERE provider='linear' AND status='connected' AND COALESCE(identity->>'transport','') <> 'mcp';
UPDATE connect_sessions SET status='error',error_code='linear_mcp_migration'
WHERE provider='linear' AND status IN ('pending','authorizing','processing')
AND NOT EXISTS (SELECT 1 FROM provider_apps a WHERE a.id=provider_app_id AND a.settings->>'transport'='mcp');
UPDATE provider_settings SET enabled=false WHERE provider='linear'
AND NOT EXISTS (SELECT 1 FROM provider_apps a WHERE a.id=active_app_id AND a.settings->>'transport'='mcp');
