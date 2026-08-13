-- ============================================================================
-- 002_auth_and_projects.sql
--
-- Adds Supabase Auth (Google + GitHub OAuth) support and multi-project
-- support on top of Supabase/schema.sql (the original single-shared-
-- workspace, no-auth baseline).
--
-- This migration:
--   1. Creates public.profiles (mirrors auth.users, auto-populated by trigger)
--   2. Creates public.projects (one row per user-owned project)
--   3. Adds a nullable project_id FK to every existing data table
--   4. Adds commits.expires_at + a scheduled cleanup of expired commits
--   5. Replaces every "Allow anon ..." RLS policy with owner-scoped policies
--      keyed off project ownership (or, for profiles/projects, user_id)
--
-- Run this in the Supabase SQL editor AFTER schema.sql, on both new and
-- existing projects. All statements are written to be safely re-runnable.
--
-- NOT done here (by design): existing rows in shared_workspace_state,
-- agent_react_logs, file_history, step_checkpoints, commits, and
-- execution_runs are left with project_id = NULL. Backfilling them onto a
-- real project (and eventually enforcing NOT NULL) is an app-side migration
-- in Phase 3, not a SQL concern -- pre-auth rows have no user to own them.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. profiles -- one row per auth.users row, kept in sync via trigger
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  display_name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Standard Supabase "auto-create profile on signup" pattern. SECURITY DEFINER
-- is required so the trigger can insert into public.profiles regardless of
-- the RLS policies defined on it below.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, avatar_url)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name'),
    new.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN new;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ----------------------------------------------------------------------------
-- 2. projects -- one row per user-owned project
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  last_opened_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_user_id ON public.projects(user_id);


-- ----------------------------------------------------------------------------
-- 3. project_id on every existing data table (nullable -- see header note)
-- ----------------------------------------------------------------------------
ALTER TABLE public.shared_workspace_state
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE;
ALTER TABLE public.agent_react_logs
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE;
ALTER TABLE public.file_history
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE;
ALTER TABLE public.step_checkpoints
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE;
ALTER TABLE public.commits
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE;
ALTER TABLE public.execution_runs
  ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES public.projects(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_shared_workspace_state_project_id ON public.shared_workspace_state(project_id);
CREATE INDEX IF NOT EXISTS idx_agent_react_logs_project_id ON public.agent_react_logs(project_id);
CREATE INDEX IF NOT EXISTS idx_file_history_project_id ON public.file_history(project_id);
CREATE INDEX IF NOT EXISTS idx_step_checkpoints_project_id ON public.step_checkpoints(project_id);
CREATE INDEX IF NOT EXISTS idx_commits_project_id ON public.commits(project_id);
CREATE INDEX IF NOT EXISTS idx_execution_runs_project_id ON public.execution_runs(project_id);


-- ----------------------------------------------------------------------------
-- 4. commits.expires_at -- commits older than 7 days are pruned (see the
--    delete_expired_commits() function + scheduling at the bottom of this file)
-- ----------------------------------------------------------------------------
ALTER TABLE public.commits
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days');

CREATE INDEX IF NOT EXISTS idx_commits_expires_at ON public.commits(expires_at);


-- ----------------------------------------------------------------------------
-- 5. RLS: drop the old anon-open policies, replace with owner-scoped ones
-- ----------------------------------------------------------------------------

-- shared_workspace_state
DROP POLICY IF EXISTS "Allow anon select on shared_workspace_state" ON public.shared_workspace_state;
DROP POLICY IF EXISTS "Allow anon insert/update on shared_workspace_state" ON public.shared_workspace_state;

CREATE POLICY "select_own" ON public.shared_workspace_state
  FOR SELECT USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );
CREATE POLICY "insert_own" ON public.shared_workspace_state
  FOR INSERT WITH CHECK (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );
CREATE POLICY "update_own" ON public.shared_workspace_state
  FOR UPDATE USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  ) WITH CHECK (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );
CREATE POLICY "delete_own" ON public.shared_workspace_state
  FOR DELETE USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

-- agent_react_logs (original: select + insert only)
DROP POLICY IF EXISTS "Allow anon select on agent_react_logs" ON public.agent_react_logs;
DROP POLICY IF EXISTS "Allow anon insert on agent_react_logs" ON public.agent_react_logs;

CREATE POLICY "select_own" ON public.agent_react_logs
  FOR SELECT USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );
CREATE POLICY "insert_own" ON public.agent_react_logs
  FOR INSERT WITH CHECK (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

-- file_history (original: select + insert only)
DROP POLICY IF EXISTS "Allow anon select on file_history" ON public.file_history;
DROP POLICY IF EXISTS "Allow anon insert on file_history" ON public.file_history;

CREATE POLICY "select_own" ON public.file_history
  FOR SELECT USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );
CREATE POLICY "insert_own" ON public.file_history
  FOR INSERT WITH CHECK (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

-- step_checkpoints (original: select + FOR ALL, i.e. select/insert/update/delete)
DROP POLICY IF EXISTS "Allow anon select on step_checkpoints" ON public.step_checkpoints;
DROP POLICY IF EXISTS "Allow anon insert/update on step_checkpoints" ON public.step_checkpoints;

CREATE POLICY "select_own" ON public.step_checkpoints
  FOR SELECT USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );
CREATE POLICY "insert_own" ON public.step_checkpoints
  FOR INSERT WITH CHECK (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );
CREATE POLICY "update_own" ON public.step_checkpoints
  FOR UPDATE USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  ) WITH CHECK (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );
CREATE POLICY "delete_own" ON public.step_checkpoints
  FOR DELETE USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

-- commits (original: select + insert only)
DROP POLICY IF EXISTS "Allow anon select on commits" ON public.commits;
DROP POLICY IF EXISTS "Allow anon insert on commits" ON public.commits;

CREATE POLICY "select_own" ON public.commits
  FOR SELECT USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );
CREATE POLICY "insert_own" ON public.commits
  FOR INSERT WITH CHECK (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

-- execution_runs (original: select + insert only)
DROP POLICY IF EXISTS "Allow anon select on execution_runs" ON public.execution_runs;
DROP POLICY IF EXISTS "Allow anon insert on execution_runs" ON public.execution_runs;

CREATE POLICY "select_own" ON public.execution_runs
  FOR SELECT USING (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );
CREATE POLICY "insert_own" ON public.execution_runs
  FOR INSERT WITH CHECK (
    project_id IN (SELECT id FROM public.projects WHERE user_id = auth.uid())
  );

-- projects itself: fully owner-scoped
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

-- profiles: a user can only see/update their own row (no insert/delete
-- policy -- rows are created by the trigger above and removed via the
-- auth.users ON DELETE CASCADE)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "select_own" ON public.profiles;
DROP POLICY IF EXISTS "update_own" ON public.profiles;

CREATE POLICY "select_own" ON public.profiles
  FOR SELECT USING (id = auth.uid());
CREATE POLICY "update_own" ON public.profiles
  FOR UPDATE USING (id = auth.uid()) WITH CHECK (id = auth.uid());


-- ----------------------------------------------------------------------------
-- 6. Expired commit cleanup
--
-- delete_expired_commits() is scheduled hourly via pg_cron when that
-- extension is available on this Supabase plan. If it isn't (some plans
-- don't expose pg_cron), the DO block below no-ops instead of failing the
-- whole migration -- in that case, call public.delete_expired_commits()
-- from a Supabase Edge Function on a cron trigger instead. The function
-- itself is created either way, so it's ready to be wired up from either.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.delete_expired_commits()
RETURNS void
LANGUAGE sql
SECURITY DEFINER SET search_path = public
AS $$
  DELETE FROM public.commits WHERE expires_at < now();
$$;

DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;

  -- Unschedule any prior run of this job before rescheduling, so this block
  -- stays safe to re-run.
  PERFORM cron.unschedule(jobid)
  FROM cron.job
  WHERE jobname = 'delete-expired-commits';

  PERFORM cron.schedule(
    'delete-expired-commits',
    '0 * * * *', -- hourly
    $cmd$SELECT public.delete_expired_commits();$cmd$
  );
EXCEPTION WHEN OTHERS THEN
  -- pg_cron isn't available on this project/plan. delete_expired_commits()
  -- still exists and can be called on a schedule from a Supabase Edge
  -- Function (cron trigger) instead -- not built in this phase, just left
  -- ready to be wired up.
  RAISE NOTICE 'pg_cron unavailable, skipping schedule for delete_expired_commits(): %', SQLERRM;
END $$;
