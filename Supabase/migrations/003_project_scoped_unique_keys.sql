-- 003_project_scoped_unique_keys.sql
-- Phase 3 infrastructure: make the existing shared-state/checkpoint tables capable of
-- storing the same logical key/step for multiple projects. Legacy rows with project_id NULL
-- are deliberately left untouched and remain unreachable through the Phase 3 UI.

ALTER TABLE public.shared_workspace_state
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT uuid_generate_v4();

UPDATE public.shared_workspace_state
SET id = uuid_generate_v4()
WHERE id IS NULL;

ALTER TABLE public.shared_workspace_state
  ALTER COLUMN id SET NOT NULL;

ALTER TABLE public.shared_workspace_state
  DROP CONSTRAINT IF EXISTS shared_workspace_state_pkey;

ALTER TABLE public.shared_workspace_state
  ADD CONSTRAINT shared_workspace_state_pkey PRIMARY KEY (id);

DROP INDEX IF EXISTS public.ux_shared_workspace_state_project_key;
CREATE UNIQUE INDEX IF NOT EXISTS ux_shared_workspace_state_project_key
  ON public.shared_workspace_state(project_id, key);

ALTER TABLE public.step_checkpoints
  ADD COLUMN IF NOT EXISTS id UUID DEFAULT uuid_generate_v4();

UPDATE public.step_checkpoints
SET id = uuid_generate_v4()
WHERE id IS NULL;

ALTER TABLE public.step_checkpoints
  ALTER COLUMN id SET NOT NULL;

ALTER TABLE public.step_checkpoints
  DROP CONSTRAINT IF EXISTS step_checkpoints_pkey;

ALTER TABLE public.step_checkpoints
  ADD CONSTRAINT step_checkpoints_pkey PRIMARY KEY (id);

DROP INDEX IF EXISTS public.ux_step_checkpoints_project_step;
CREATE UNIQUE INDEX IF NOT EXISTS ux_step_checkpoints_project_step
  ON public.step_checkpoints(project_id, step_id);
