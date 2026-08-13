const KEY = 'theta_execution_health_v1';

export interface ExecutionHealth {
  projectId: string;
  commands: number;
  successes: number;
  failures: number;
  totalMs: number;
  lastCommand?: string;
  lastExitCode?: number | null;
  lastError?: string;
}

export function recordExecutionHealth(projectId: string, patch: Partial<ExecutionHealth>): void {
  try {
    const key = `${KEY}:${projectId}`;
    const previous = JSON.parse(localStorage.getItem(key) || '{}');
    const next: ExecutionHealth = { projectId, commands: previous.commands || 0, successes: previous.successes || 0, failures: previous.failures || 0, totalMs: previous.totalMs || 0, ...patch };
    localStorage.setItem(key, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent('theta:execution-health', { detail: next }));
  } catch {}
}

export function getExecutionHealth(projectId: string): ExecutionHealth | null {
  try {
    const value = JSON.parse(localStorage.getItem(`${KEY}:${projectId}`) || 'null');
    return value?.projectId ? value : null;
  } catch { return null; }
}
