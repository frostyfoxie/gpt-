-- Atomic project-scoped file locking for parallel dev agents.
-- This replaces the client-side SELECT -> UPSERT race with one PostgreSQL statement.
-- Existing project_id IS NULL rows remain orphaned/unreachable by design.
CREATE OR REPLACE FUNCTION public.acquire_project_file_lock(
  p_project_id UUID,
  p_key TEXT,
  p_agent_id TEXT,
  p_file_path TEXT,
  p_stale_after_seconds INTEGER DEFAULT 30
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claimed BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.projects
    WHERE id = p_project_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Project is not owned by the authenticated user';
  END IF;

  INSERT INTO public.shared_workspace_state (project_id, key, value, locked_by, updated_at)
  VALUES (
    p_project_id,
    p_key,
    jsonb_build_object('filePath', p_file_path, 'lockedAt', now()),
    p_agent_id,
    now()
  )
  ON CONFLICT (project_id, key) DO UPDATE
    SET value = jsonb_build_object('filePath', p_file_path, 'lockedAt', now()),
        locked_by = p_agent_id,
        updated_at = now()
    WHERE public.shared_workspace_state.locked_by = p_agent_id
       OR COALESCE((public.shared_workspace_state.value->>'lockedAt')::timestamptz, to_timestamp(0))
          < now() - make_interval(secs => p_stale_after_seconds)
  RETURNING TRUE INTO claimed;

  RETURN COALESCE(claimed, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_project_file_lock(UUID, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.acquire_project_file_lock(UUID, TEXT, TEXT, TEXT, INTEGER) TO authenticated;
