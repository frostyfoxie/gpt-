import { supabase } from '../lib/supabase/vfs-sync';
import { getActiveProjectId } from './active-project';

const STALE_LOCK_TIMEOUT_SECONDS = 30;

function requireProjectId(): string {
  const id = getActiveProjectId();
  if (!id) throw new Error('No active project is selected.');
  return id;
}

export async function acquireFileLock(agentId: string, filePath: string): Promise<boolean> {
  const projectId = requireProjectId();
  const lockKey = `lock:${filePath}`;
  const { data, error } = await supabase.rpc('acquire_project_file_lock', {
    p_project_id: projectId,
    p_key: lockKey,
    p_agent_id: agentId,
    p_file_path: filePath,
    p_stale_after_seconds: STALE_LOCK_TIMEOUT_SECONDS,
  });

  if (error) {
    // Never silently convert infrastructure failure into lock contention. Missing migration
    // 009 must be actionable; otherwise every agent would wait until its retry budget expires.
    const message = error?.message || 'Unknown Supabase RPC error.';
    console.error(`[state-lock] atomic acquire RPC failed for \"${lockKey}\".`, error);
    throw new Error(
      `File-lock service unavailable. Apply Supabase migration 009_atomic_file_locks.sql ` +
      `(RPC acquire_project_file_lock). Original error: ${message}`
    );
  }
  return data === true;
}

export async function releaseFileLock(agentId: string, filePath: string): Promise<void> {
  const projectId = requireProjectId();
  const lockKey = `lock:${filePath}`;
  const { error } = await supabase
    .from('shared_workspace_state')
    .delete()
    .eq('project_id', projectId)
    .eq('key', lockKey)
    .eq('locked_by', agentId);
  if (error) console.warn(`[state-lock] releaseFileLock failed for "${lockKey}".`, error);
}

export async function isFileLocked(filePath: string, currentAgentId: string): Promise<boolean> {
  const projectId = requireProjectId();
  const lockKey = `lock:${filePath}`;
  const { data, error } = await supabase
    .from('shared_workspace_state')
    .select('value, locked_by')
    .eq('project_id', projectId)
    .eq('key', lockKey)
    .maybeSingle();
  if (error) {
    console.error(`[state-lock] isFileLocked failed for "${lockKey}".`, error);
    return true;
  }
  if (!data || !data.locked_by || data.locked_by === currentAgentId) return false;
  const lockedAt = data.value?.lockedAt ? new Date(data.value.lockedAt).getTime() : 0;
  return Date.now() - lockedAt <= STALE_LOCK_TIMEOUT_SECONDS * 1000;
}
