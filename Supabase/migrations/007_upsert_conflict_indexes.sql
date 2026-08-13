-- 007_upsert_conflict_indexes.sql
-- Fixes Postgres ON CONFLICT inference for project-scoped upserts.
-- The earlier Phase-3 indexes used partial predicates (project_id IS NOT NULL).
-- Supabase upsert({ onConflict: "project_id,key" }) cannot infer a partial
-- unique index from that conflict target. NULL project_id rows are still allowed
-- to coexist under an ordinary UNIQUE constraint, so the predicate is unnecessary.
-- Legacy project_id IS NULL rows remain intentionally orphaned/unreachable via the UI.

DROP INDEX IF EXISTS public.ux_shared_workspace_state_project_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_shared_workspace_state_project_key
  ON public.shared_workspace_state(project_id, key);

DROP INDEX IF EXISTS public.ux_step_checkpoints_project_step;
CREATE UNIQUE INDEX IF NOT EXISTS ux_step_checkpoints_project_step
  ON public.step_checkpoints(project_id, step_id);

DROP INDEX IF EXISTS public.ux_step_checkpoints_project_seq;
CREATE UNIQUE INDEX IF NOT EXISTS ux_step_checkpoints_project_seq
  ON public.step_checkpoints(project_id, seq);

DROP INDEX IF EXISTS public.ux_commits_project_seq;
CREATE UNIQUE INDEX IF NOT EXISTS ux_commits_project_seq
  ON public.commits(project_id, seq);
