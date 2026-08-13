-- Phase 3/4 follow-up: seq is project-local, not globally unique.
-- Without this, the first checkpoint/commit in a second project can collide with
-- the same seq value from another project even though project_id scoping is correct.
DROP INDEX IF EXISTS public.idx_step_checkpoints_seq;
DROP INDEX IF EXISTS public.idx_commits_seq;

DROP INDEX IF EXISTS public.ux_step_checkpoints_project_seq;
CREATE UNIQUE INDEX IF NOT EXISTS ux_step_checkpoints_project_seq
  ON public.step_checkpoints(project_id, seq);

DROP INDEX IF EXISTS public.ux_commits_project_seq;
CREATE UNIQUE INDEX IF NOT EXISTS ux_commits_project_seq
  ON public.commits(project_id, seq);
