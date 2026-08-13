/**
 * Execution Truth Ledger
 *
 * UI/log events must not claim that an agent/tool ran merely because the
 * orchestrator intended to run it. Callers should emit DISPATCHED only
 * immediately before the real model/tool request, and COMPLETED/FAILED only
 * after the real request resolves.
 */
export type ExecutionTruthStatus =
  | 'planned'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'skipped'
  | 'unverified';

export interface ExecutionTruthEvent {
  id: string;
  projectId?: string;
  stepId?: number;
  agentId?: string;
  kind: 'agent' | 'tool' | 'terminal' | 'checkpoint' | 'step';
  action: string;
  status: ExecutionTruthStatus;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

const key = (projectId?: string) =>
  `theta_execution_truth${projectId ? `_${projectId}` : ''}`;

export function recordExecutionTruth(
  event: Omit<ExecutionTruthEvent, 'id'>,
): ExecutionTruthEvent {
  const full: ExecutionTruthEvent = {
    ...event,
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
  };

  if (typeof window !== 'undefined') {
    try {
      const raw = localStorage.getItem(key(event.projectId));
      const items: ExecutionTruthEvent[] = raw ? JSON.parse(raw) : [];
      items.push(full);
      localStorage.setItem(key(event.projectId), JSON.stringify(items.slice(-500)));
      window.dispatchEvent(new CustomEvent('theta:execution-truth', { detail: full }));
    } catch {
      // Observability must never crash the task itself.
    }
  }

  return full;
}

export function getExecutionTruth(projectId?: string): ExecutionTruthEvent[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(key(projectId));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}
