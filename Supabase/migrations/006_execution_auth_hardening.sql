-- 006_execution_auth_hardening.sql
-- Harden the CodeSandbox executor's project association.
--
-- The API authenticates the caller with their Supabase access token and then
-- performs the ownership lookup server-side. SUPABASE_SERVICE_ROLE_KEY is used
-- only by the Vercel API when configured; it is never exposed to the browser.
-- The explicit user_id check in the API remains mandatory even with service role.
--
-- This migration is intentionally additive and safe to re-run.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS execution_sandbox_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS ux_projects_execution_sandbox_id
  ON public.projects(execution_sandbox_id)
  WHERE execution_sandbox_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_projects_user_id_last_opened
  ON public.projects(user_id, last_opened_at DESC);

-- Reassert the owner-scoped policies in case an older deployment has stale
-- or missing policies. Do not grant cross-user access.
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own" ON public.projects;
DROP POLICY IF EXISTS "insert_own" ON public.projects;
DROP POLICY IF EXISTS "update_own" ON public.projects;
DROP POLICY IF EXISTS "delete_own" ON public.projects;

CREATE POLICY "select_own" ON public.projects
  FOR SELECT USING (user_id = auth.uid());
CREATE POLICY "insert_own" ON public.projects
  FOR INSERT WITH CHECK (user_id = auth.uid());
CREATE POLICY "update_own" ON public.projects
  FOR UPDATE USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
CREATE POLICY "delete_own" ON public.projects
  FOR DELETE USING (user_id = auth.uid());

-- The execution sandbox is project-owned metadata; never put the CodeSandbox
-- API key in this table.
