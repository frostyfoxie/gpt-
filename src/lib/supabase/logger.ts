import { supabase } from './vfs-sync';
import { getActiveProjectId } from '../../engine/active-project';

const LOCAL_LOG_PREFIX = 'theta_local_logs_';
type LocalLogRecord = { kind: 'agent' | 'execution'; row: any };

function localLogKey(): string {
  const projectId = getActiveProjectId();
  if (!projectId) throw new Error('No active project is selected.');
  return `${LOCAL_LOG_PREFIX}${projectId}`;
}

function emit(record: LocalLogRecord): void {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('theta:execution-log', { detail: record }));
    }
  } catch {}
}

function appendLocalLog(record: LocalLogRecord): void {
  try {
    const key = localLogKey();
    const raw = localStorage.getItem(key);
    const rows: LocalLogRecord[] = raw ? JSON.parse(raw) : [];
    rows.push(record);
    localStorage.setItem(key, JSON.stringify(rows.slice(-500)));
  } catch (err) {
    console.warn('[Logger] Local log fallback failed:', err);
  }
  emit(record);
}

export function loadLocalLogs(projectId: string): LocalLogRecord[] {
  try {
    const raw = localStorage.getItem(`${LOCAL_LOG_PREFIX}${projectId}`);
    const rows = raw ? JSON.parse(raw) : [];
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

function requireProjectId(): string {
  const id = getActiveProjectId();
  if (!id) throw new Error('No active project is selected.');
  return id;
}

export interface ReActLogPayload {
  stepId: number;
  subtaskId?: string;
  agentId: string;
  thought: string;
  action?: string;
  actionInput?: Record<string, any>;
  observation?: string;
  status: 'executing' | 'success' | 'failed' | 'thinking' | 'skipped';
}

export async function logReActStep(payload: ReActLogPayload): Promise<void> {
  const projectId = requireProjectId();
  const createdAt = new Date().toISOString();
  const row = { kind: 'agent' as const, row: { project_id: projectId, ...payload, created_at: createdAt } };
  const { error } = await supabase.from('agent_react_logs').insert({
    project_id: projectId,
    step_id: payload.stepId,
    subtask_id: payload.subtaskId || null,
    agent_id: payload.agentId,
    thought: payload.thought,
    action: payload.action || null,
    action_input: payload.actionInput || null,
    observation: payload.observation || null,
    status: payload.status,
    created_at: createdAt,
  });
  // Keep a local copy even when Supabase succeeds. This makes the Logs panel immediate and
  // resilient to realtime subscription delays/reconnects; history deduplication removes the
  // duplicate when the remote row is loaded later.
  if (error) console.error(`[Logger Error] Failed to persist ReAct step for ${payload.agentId}:`, error);
  appendLocalLog(row);
}

export async function recordFileRevision(filePath: string, content: string, modifiedBy: string, stepId: number): Promise<void> {
  const projectId = requireProjectId();
  const { error } = await supabase.from('file_history').insert({
    project_id: projectId, file_path: filePath, content, modified_by: modifiedBy, step_id: stepId, created_at: new Date().toISOString(),
  });
  if (error) console.error(`[Logger Error] Failed to record revision for ${filePath}:`, error);
}

export async function emitExecutionRun(payload: {
  command: string; success: boolean; stdout: string; stderr: string; exitCode: number | null;
  agentId?: string; stepId?: number; persist?: boolean;
}): Promise<void> {
  const projectId = requireProjectId();
  const row = {
    project_id: projectId, step_id: payload.stepId ?? 0, agent_id: payload.agentId || 'terminal',
    command: payload.command, success: payload.success,
    stdout: payload.stdout?.slice(0, 20000) || '',
    stderr: `${payload.stderr?.slice(0, 19000) || ''}${payload.exitCode != null ? `\n[exit code ${payload.exitCode}]` : ''}`.slice(0, 20000),
    created_at: new Date().toISOString(),
  };
  const event = { kind: 'execution' as const, row };
  if (payload.persist !== false) {
    const { error } = await supabase.from('execution_runs').insert(row);
    if (error) console.warn('[Logger] Failed to persist execution run:', error);
  }
  // Always mirror the event locally so the UI is instant even when Postgres Realtime is
  // delayed or unavailable. Remote history is deduplicated on reload.
  appendLocalLog(event);
}

export async function logTerminalRun(payload: { command: string; success: boolean; stdout: string; stderr: string; exitCode: number | null }): Promise<void> {
  await emitExecutionRun(payload);
}

export interface SandboxRunPayload {
  stepId: number; agentId: string; command: string; success: boolean; stdout: string; stderr: string;
}

export async function logSandboxRun(payload: SandboxRunPayload): Promise<void> {
  await emitExecutionRun({ ...payload, exitCode: payload.success ? 0 : null });
}
