-- Phase 5: one persistent CodeSandbox VM per Theta project.
-- The CodeSandbox API key never enters the browser; only this opaque sandbox id is stored.
ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS execution_sandbox_id TEXT;

CREATE INDEX IF NOT EXISTS idx_projects_execution_sandbox_id
  ON public.projects(execution_sandbox_id)
  WHERE execution_sandbox_id IS NOT NULL;
