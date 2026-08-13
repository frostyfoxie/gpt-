import { getAccessToken } from '../supabase/auth';
import { getActiveProjectId } from '../../engine/active-project';

export interface ExecFileInput { path: string; content: string; }
export interface ExecRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  commandsRun?: string[];
  durationMs?: number;
  error?: string;
  executor?: 'local' | 'codesandbox';
  sandboxId?: string;
  processName?: string;
}
export interface BehaviorInteractionResult {
  criterion: string;
  matched: boolean;
  action: string;
  elementLabel?: string;
  clickFailed?: boolean;
}
export interface ExecBehaviorResult {
  success: boolean;
  servable: boolean;
  consoleErrors: string[];
  pageErrors: string[];
  interactions: BehaviorInteractionResult[];
  note?: string;
  buildOutput?: string;
  buildError?: string;
  error?: string;
}

function requireProjectId(): string {
  const id = getActiveProjectId();
  if (!id) throw new Error('No active project is selected.');
  return id;
}

const EXECUTOR_MANIFEST_PREFIX = 'theta_executor_manifest_v1:';

async function sha256(content: string): Promise<string> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const bytes = new TextEncoder().encode(content);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 2166136261;
  for (let i = 0; i < content.length; i++) { h ^= content.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `fnv1a-${(h >>> 0).toString(16)}`;
}

async function prepareIncrementalFiles(files: ExecFileInput[]): Promise<{ files: ExecFileInput[]; deletedPaths: string[] }> {
  if (typeof sessionStorage === 'undefined') return { files, deletedPaths: [] };
  const projectId = requireProjectId();
  const storageKey = `${EXECUTOR_MANIFEST_PREFIX}${projectId}`;
  let previous: Record<string, string> = {};
  try { previous = JSON.parse(sessionStorage.getItem(storageKey) || '{}'); } catch { previous = {}; }

  const next: Record<string, string> = {};
  const changed: ExecFileInput[] = [];
  for (const file of files) {
    const hash = await sha256(String(file.content ?? ''));
    next[file.path] = hash;
    if (previous[file.path] !== hash) changed.push(file);
  }
  const deletedPaths = Object.keys(previous).filter((path) => !(path in next));
  sessionStorage.setItem(storageKey, JSON.stringify(next));
  return { files: changed, deletedPaths };
}

async function api(action: string, body: Record<string, any> = {}): Promise<any> {
  const token = await getAccessToken();
  if (!token) throw new Error('You must be signed in to use the execution environment.');
  const response = await fetch('/api/executor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, projectId: requireProjectId(), ...body }),
  });
  let data: any = null;
  try { data = await response.json(); } catch { /* handled below */ }
  if (!response.ok) throw new Error(data?.error || `Executor request failed (${response.status}).`);
  return data;
}

export function isExecutorConfigured(): boolean {
  // The CodeSandbox secret stays server-side. This public flag is supplied by the
  // deployment only when /api/executor is configured.
  const enabled = (import.meta as any)?.env?.VITE_CODESANDBOX_EXECUTOR_ENABLED;
  return enabled === true || enabled === 'true';
}

export async function runProjectCommand(
  files: ExecFileInput[], command: string, timeoutMs = 60_000
): Promise<ExecRunResult> {
  try {
    const delta = await prepareIncrementalFiles(files);
    return await api('run', { files: delta.files, deletedPaths: delta.deletedPaths, command, timeoutMs });
  } catch (error: any) {
    return { success: false, stdout: '', stderr: '', exitCode: null, error: error?.message || String(error), executor: 'codesandbox' };
  }
}

export async function runProjectTests(files: ExecFileInput[], timeoutMs = 60_000): Promise<ExecRunResult> {
  try {
    const delta = await prepareIncrementalFiles(files);
    return await api('test', { files: delta.files, deletedPaths: delta.deletedPaths, timeoutMs });
  } catch (error: any) {
    return { success: false, stdout: '', stderr: '', exitCode: null, error: error?.message || String(error), executor: 'codesandbox' };
  }
}

export async function runProjectBehaviorCheck(
  files: ExecFileInput[], acceptanceCriteria: string[] = [], timeoutMs = 90_000
): Promise<ExecBehaviorResult> {
  try {
    const delta = await prepareIncrementalFiles(files);
    return await api('behavior', { files: delta.files, deletedPaths: delta.deletedPaths, acceptanceCriteria, timeoutMs });
  } catch (error: any) {
    return { success: false, servable: false, consoleErrors: [], pageErrors: [], interactions: [], error: error?.message || String(error) };
  }
}

export async function runProjectBackground(
  files: ExecFileInput[], command: string, name: string
): Promise<ExecRunResult> {
  try {
    const delta = await prepareIncrementalFiles(files);
    return await api('background', { files: delta.files, deletedPaths: delta.deletedPaths, command, name });
  } catch (error: any) {
    return { success: false, stdout: '', stderr: '', exitCode: null, error: error?.message || String(error), executor: 'codesandbox' };
  }
}

export async function stopProjectProcess(name: string): Promise<ExecRunResult> {
  try {
    return await api('stop', { name });
  } catch (error: any) {
    return { success: false, stdout: '', stderr: '', exitCode: null, error: error?.message || String(error), executor: 'codesandbox' };
  }
}

export async function ensureProjectSandbox(): Promise<{ sandboxId: string }> {
  return api('ensure');
}

export async function destroyProjectSandbox(): Promise<void> {
  await api('destroy');
}


export interface PreviewResult {
  success: boolean;
  url?: string;
  port?: number;
  processName?: string;
  framework?: string;
  sandboxId?: string;
  error?: string;
}

/** Start a project preview in the same isolated CodeSandbox used by the terminal.
 * The backend auto-detects the project stack and binds the requested port. */
export async function startProjectPreview(
  files: ExecFileInput[], port = 4173
): Promise<PreviewResult> {
  try {
    return await api('previewStart', { files, port });
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
}

export async function stopProjectPreview(port = 4173): Promise<PreviewResult> {
  try {
    return await api('previewStop', { port });
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
}

export async function getProjectPreviewUrl(port: number): Promise<PreviewResult> {
  try {
    return await api('preview', { port });
  } catch (error: any) {
    return { success: false, error: error?.message || String(error) };
  }
}
