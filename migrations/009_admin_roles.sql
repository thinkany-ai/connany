-- Console users: admin (system administrator) manages users; member uses the workbench only.
-- Accounts that already exist were created by the CLI and become administrators.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'admin' CHECK (role IN ('admin','member'));
ALTER TABLE admin_users ALTER COLUMN role SET DEFAULT 'member';
-- Keep audit history readable after a user is deleted.
ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS actor_email text;
ALTER TABLE admin_audit ALTER COLUMN admin_id DROP NOT NULL;
ALTER TABLE admin_audit DROP CONSTRAINT IF EXISTS admin_audit_admin_id_fkey;
ALTER TABLE admin_audit ADD CONSTRAINT admin_audit_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES admin_users(id) ON DELETE SET NULL;
