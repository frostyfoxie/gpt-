export type AgentName = 'miko' | 'chief';

export type AgentContextKind =
  | 'observation'
  | 'research'
  | 'finding'
  | 'question'
  | 'decision'
  | 'execution';

export interface AgentContextEvent {
  id: string;
  projectId?: string;
  source: AgentName;
  kind: AgentContextKind;
  text: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

const MAX_EVENTS = 100;
const STORAGE_KEY = 'theta_shared_agent_context_v1';
const listeners = new Set<(event: AgentContextEvent) => void>();
let events: AgentContextEvent[] = load();

function sanitize(text: string): string {
  return text
    .replace(/(?:api[_ -]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted-api-key]')
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, '[redacted-token]');
}

function load(): AgentContextEvent[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.slice(-MAX_EVENTS) : [];
  } catch {
    return [];
  }
}

function persist(): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));
  } catch {
    // Context sharing must never break the agent itself when storage is unavailable.
  }
}

export function publishAgentContext(input: Omit<AgentContextEvent, 'id' | 'createdAt' | 'text'> & { text: string }): AgentContextEvent {
  const event: AgentContextEvent = {
    ...input,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    text: sanitize(input.text),
  };
  events = [...events, event].slice(-MAX_EVENTS);
  persist();
  for (const listener of listeners) listener(event);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('theta:agent-context', { detail: event }));
  }
  return event;
}

export function getRecentAgentContext(projectId?: string, limit = 20, excludeSource?: AgentName): AgentContextEvent[] {
  return events
    .filter((event) => !projectId || !event.projectId || event.projectId === projectId)
    .filter((event) => !excludeSource || event.source !== excludeSource)
    .slice(-limit);
}

export function subscribeAgentContext(listener: (event: AgentContextEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function formatAgentContextForPrompt(eventsToUse: AgentContextEvent[]): string {
  if (!eventsToUse.length) return '(no shared observations yet)';
  return eventsToUse.map((event) => `[${event.source}/${event.kind}] ${event.text}`).join('\n');
}
