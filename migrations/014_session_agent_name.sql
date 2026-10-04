-- The app the user returns to after authorizing (e.g. "Codex" for sessions created through MCP),
-- shown on the result page instead of a generic "agent".
ALTER TABLE connect_sessions ADD COLUMN IF NOT EXISTS agent_name text;
