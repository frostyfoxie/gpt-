-- Baseline schema for the authenticated, project-scoped deployment.
-- RLS is enabled below but intentionally has no anonymous allow policies.
-- Apply Supabase/migrations/002_auth_and_projects.sql and later migrations after
-- this file to add owner-scoped project policies and related auth metadata.

-- Enable UUID extension for workspace identification
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Shared Workspace State & Atomic File Lock Registry
CREATE TABLE IF NOT EXISTS public.shared_workspace_state (
  key TEXT PRIMARY KEY,
  value JSONB DEFAULT '{}'::jsonb,
  locked_by TEXT,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Agent ReAct Execution Logs (Streams live updates to #terminalOutput)
CREATE TABLE IF NOT EXISTS public.agent_react_logs (
  id BIGSERIAL PRIMARY KEY,
  step_id INT NOT NULL,
  subtask_id TEXT,
  agent_id TEXT NOT NULL,
  thought TEXT,
  action TEXT,
  action_input JSONB,
  observation TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 3. File History / Revision Snapshots
CREATE TABLE IF NOT EXISTS public.file_history (
  id BIGSERIAL PRIMARY KEY,
  file_path TEXT NOT NULL,
  content TEXT NOT NULL,
  modified_by TEXT NOT NULL,
  step_id INT NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 4. Shadow Git Step Checkpoints
CREATE TABLE IF NOT EXISTS public.step_checkpoints (
  step_id INT PRIMARY KEY,
  snapshot_tree JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 5. Commit History (manual "Commit" button + automatic per-step commits) — full
--    file-tree snapshots so any commit can be restored with one click.
CREATE TABLE IF NOT EXISTS public.commits (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  message TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'auto'
  snapshot_tree JSONB NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Phase 3: diff-based commits & checkpoints (fixes #9 -- full-tree snapshot on every
-- commit doesn't scale). Both `commits` and `step_checkpoints` now form a sequence
-- (`seq`, assigned in creation order): every 10th row ("anchor", `is_snapshot = true`)
-- keeps a full `snapshot_tree` copy for fast restore, and every other row stores only a
-- `diff` against the tree produced by the previous row in the sequence (see
-- src/lib/diff/tree-diff.ts and src/engine/commits.ts / src/lib/git/checkpoint.ts, which
-- replay diffs forward from the nearest anchor to reconstruct any row's tree).
ALTER TABLE public.commits ADD COLUMN IF NOT EXISTS seq BIGINT;
ALTER TABLE public.commits ADD COLUMN IF NOT EXISTS is_snapshot BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.commits ADD COLUMN IF NOT EXISTS diff JSONB;
ALTER TABLE public.commits ALTER COLUMN snapshot_tree DROP NOT NULL;

ALTER TABLE public.step_checkpoints ADD COLUMN IF NOT EXISTS seq BIGINT;
ALTER TABLE public.step_checkpoints ADD COLUMN IF NOT EXISTS is_snapshot BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.step_checkpoints ADD COLUMN IF NOT EXISTS diff JSONB;
ALTER TABLE public.step_checkpoints ALTER COLUMN snapshot_tree DROP NOT NULL;

-- Backfill: rows created before this migration were always full snapshots -- assign them
-- sequence numbers in creation order and mark them as anchors so existing history keeps
-- restoring correctly under the new replay logic.
UPDATE public.commits c
SET seq = ranked.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC) - 1 AS rn
  FROM public.commits
  WHERE seq IS NULL
) ranked
WHERE c.id = ranked.id;

UPDATE public.step_checkpoints c
SET seq = ranked.rn
FROM (
  SELECT step_id, ROW_NUMBER() OVER (ORDER BY created_at ASC) - 1 AS rn
  FROM public.step_checkpoints
  WHERE seq IS NULL
) ranked
WHERE c.step_id = ranked.step_id;

ALTER TABLE public.commits ALTER COLUMN seq SET NOT NULL;
ALTER TABLE public.step_checkpoints ALTER COLUMN seq SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_commits_seq ON public.commits(seq);
CREATE INDEX IF NOT EXISTS idx_commits_anchor_seq ON public.commits(is_snapshot, seq DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_step_checkpoints_seq ON public.step_checkpoints(seq);
CREATE INDEX IF NOT EXISTS idx_step_checkpoints_anchor_seq ON public.step_checkpoints(is_snapshot, seq DESC);

-- 6. Execution Runs — audit trail for the "strict debugging model": every real compile/test
--    pass executed by the isolated CodeSandbox executor, separate from
--    agent_react_logs because these carry real stdout/stderr from an actual command run, not
--    model "thoughts". (Formerly `sandbox_runs` when this ran through E2B — if upgrading an
--    existing project, run: ALTER TABLE public.sandbox_runs RENAME TO execution_runs;)
CREATE TABLE IF NOT EXISTS public.execution_runs (
  id BIGSERIAL PRIMARY KEY,
  step_id INT NOT NULL,
  agent_id TEXT NOT NULL,
  command TEXT,
  success BOOLEAN NOT NULL,
  stdout TEXT,
  stderr TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- NOTE: Whole-project autosave (restored automatically on page load) reuses the existing
-- `shared_workspace_state` table above under key = 'file_tree', so no extra table is needed.
--
-- NOTE: Chief's and Miko's chat transcripts are persisted the same way, under
-- key = 'chief_conversation' and key = 'miko_conversation' respectively (see
-- src/lib/supabase/conversation-sync.ts), so returning to a project doesn't lose the
-- discussion history. No extra table needed for these either.

-- Ensure full record details are broadcasted for Realtime listeners
ALTER TABLE public.shared_workspace_state REPLICA IDENTITY FULL;
ALTER TABLE public.agent_react_logs REPLICA IDENTITY FULL;
ALTER TABLE public.file_history REPLICA IDENTITY FULL;

-- Safe Realtime Publication Assignment (Prevents duplicate assignment errors)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'shared_workspace_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.shared_workspace_state;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'agent_react_logs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_react_logs;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'file_history'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.file_history;
  END IF;
END $$;

-- Indexes for query optimization and fast lookups
CREATE INDEX IF NOT EXISTS idx_file_history_path ON public.file_history(file_path, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_react_logs_step ON public.agent_react_logs(step_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_react_logs_created ON public.agent_react_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_commits_created ON public.commits(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_execution_runs_step ON public.execution_runs(step_id, created_at DESC);

-- Enable Row Level Security (RLS) & establish default workspace access policies
ALTER TABLE public.shared_workspace_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_react_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.file_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.step_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.execution_runs ENABLE ROW LEVEL SECURITY;

-- No anonymous policies are created in the baseline schema.
-- RLS remains enabled, so anon/authenticated users are denied by default until
-- the owner-scoped policies in migrations/002_auth_and_projects.sql are applied.
