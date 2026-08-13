-- 008_execution_observability.sql
-- P1: make real execution history observable in Supabase Realtime.
ALTER TABLE public.execution_runs REPLICA IDENTITY FULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'execution_runs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.execution_runs;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_execution_runs_project_created
  ON public.execution_runs(project_id, created_at DESC);
