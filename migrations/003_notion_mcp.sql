-- REST tokens cannot authenticate to Notion MCP. Retain them for explicit cleanup only.
UPDATE connections SET status='reauth_required', updated_at=now()
WHERE provider='notion' AND status='connected' AND COALESCE(identity->>'transport','') <> 'mcp';
UPDATE connect_sessions SET status='error',error_code='notion_mcp_migration'
WHERE provider='notion' AND status IN ('pending','authorizing','processing');
UPDATE provider_settings SET enabled=false WHERE provider='notion' AND NOT EXISTS (SELECT 1 FROM provider_apps a WHERE a.id=active_app_id AND a.settings->>'transport'='mcp');
