-- PostHog now runs in tools mode (every tool listed individually) instead of its single
-- CLI-style `exec` tool. Drop the cached catalogs so they are rediscovered on next use.
DELETE FROM connector_tools WHERE connector = 'posthog';
