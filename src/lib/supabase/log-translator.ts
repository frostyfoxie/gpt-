import { supabase, isSupabaseConfigured } from './vfs-sync';
import { loadLocalLogs } from './logger';
import { getActiveProjectId, onActiveProjectChanged } from '../../engine/active-project';
import { getExecutionTruth } from '../../engine/execution-truth';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function statusClass(status: string): string {
  if (status === 'failed') return 'text-rose-300';
  if (status === 'success') return 'text-emerald-300';
  if (status === 'executing') return 'text-amber-300';
  if (status === 'skipped') return 'text-yellow-300';
  return 'text-cyan-300';
}

function actionLabel(action: string | null | undefined): string {
  const labels: Record<string, string> = {
    list_files: 'INSPECT FILES', read_file: 'READ FILE', grep: 'SEARCH CODE', glob: 'FIND PATHS',
    write_file: 'WRITE FILE', edit_file: 'EDIT FILE', check_syntax: 'CHECK SYNTAX',
    review: 'REVIEW CODE', run_tests: 'RUN TESTS', run_behavior_check: 'BROWSER TEST',
    create_checkpoint: 'CREATE CHECKPOINT', restore_checkpoint: 'RESTORE CHECKPOINT',
    complete_step: 'COMPLETE STEP', fix_code: 'FIX CODE', terminal_execute: 'TERMINAL EXEC',
  };
  return labels[action || ''] || String(action || 'AGENT EVENT').replace(/_/g, ' ').toUpperCase();
}

export class LogTerminalAdapter {
  private logBuffer: string[] = [];
  private projectId: string | null = null;
  private channel: any = null;
  private loading = false;
  private eventKeys = new Set<string>();

  constructor() {
    this.bindProjectLifecycle();
    if (typeof window !== 'undefined') {
      window.addEventListener('theta:execution-log', (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (!detail || detail.row?.project_id !== this.projectId) return;
        if (detail.kind === 'agent') this.appendAgentEvent(detail.row, true);
        else if (detail.kind === 'execution') this.appendExecutionEvent(detail.row, true);
      });
      window.addEventListener('theta:execution-truth', (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (!detail || (detail.projectId || null) !== this.projectId) return;
        this.appendTruthEvent(detail, true);
      });
      window.addEventListener('theta:retry-wait', (event: Event) => {
        const detail = (event as CustomEvent).detail;
        if (!detail || (detail.projectId || null) !== this.projectId) return;
        this.appendTruthEvent({ ...detail, kind: 'tool', action: 'model_retry_wait', status: 'dispatched' }, true);
      });
    }
    if (!isSupabaseConfigured) {
      if (this.projectId) this.appendLocalOnly(this.projectId);
      return;
    }
    this.projectId = getActiveProjectId();
    if (this.projectId) { void this.loadProjectHistory(this.projectId); this.subscribeRealtime(this.projectId); }
  }

  private async appendLocalOnly(projectId: string) {
    const events = loadLocalLogs(projectId);
    this.logBuffer = events.map((event: any) => event.kind === 'agent' ? this.renderAgentEvent(event.row) : this.renderExecutionEvent(event.row)).slice(-400);
    this.repaintLogs();
  }

  private bindProjectLifecycle() {
    onActiveProjectChanged(async (project) => {
      this.projectId = project.id;
      this.logBuffer = [];
      this.unsubscribeRealtime();
      await this.loadProjectHistory(project.id);
      this.subscribeRealtime(project.id);
    });
    window.addEventListener('theta:active-project-cleared', () => {
      this.projectId = null;
      this.logBuffer = [];
      this.unsubscribeRealtime();
      this.repaintLogs();
    });
  }

  private unsubscribeRealtime() {
    if (this.channel) {
      void supabase.removeChannel(this.channel);
      this.channel = null;
    }
  }

  private subscribeRealtime(projectId: string) {
    this.channel = supabase
      .channel(`realtime-agent-logs-${projectId}`)
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'agent_react_logs', filter: `project_id=eq.${projectId}`,
      }, (payload: any) => this.appendAgentEvent(payload.new, true))
      .on('postgres_changes', {
        event: 'INSERT', schema: 'public', table: 'execution_runs', filter: `project_id=eq.${projectId}`,
      }, (payload: any) => this.appendExecutionEvent(payload.new, true))
      .subscribe();
  }

  private async loadProjectHistory(projectId: string) {
    if (this.loading) return;
    this.loading = true;
    try {
      const [agentResult, executionResult] = await Promise.all([
        supabase.from('agent_react_logs').select('*').eq('project_id', projectId).order('created_at', { ascending: true }).limit(300),
        supabase.from('execution_runs').select('*').eq('project_id', projectId).order('created_at', { ascending: true }).limit(100),
      ]);
      this.logBuffer = [];
      this.eventKeys.clear();
      const remoteEvents = [
        ...(agentResult.data || []).map((row: any) => ({ kind: 'agent', at: row.created_at, row })),
        ...(executionResult.data || []).map((row: any) => ({ kind: 'execution', at: row.created_at, row })),
      ];
      const remoteKeys = new Set(remoteEvents.map((event: any) => `${event.kind}|${event.row.created_at}|${event.row.agent_id}|${event.row.command || event.row.action || ''}`));
      const truthEvents = getExecutionTruth(projectId).map((row: any) => ({ kind: 'truth', at: row.finishedAt || row.startedAt || row.created_at || Date.now(), row }));
      const localEvents = loadLocalLogs(projectId)
        .filter((event: any) => !remoteKeys.has(`${event.kind}|${event.row.created_at}|${event.row.agent_id}|${event.row.command || event.row.action || ''}`))
        .map((event: any) => ({ kind: event.kind, at: event.row.created_at, row: event.row }));
      const events = [...remoteEvents, ...localEvents, ...truthEvents]
        .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      for (const event of events) {
        const key = event.kind === 'truth' ? `truth|${event.row.id || ''}` : this.eventKey(event.kind, event.row);
        this.eventKeys.add(key);
        if (event.kind === 'agent') this.logBuffer.push(this.renderAgentEvent(event.row));
        else if (event.kind === 'execution') this.logBuffer.push(this.renderExecutionEvent(event.row));
        else this.logBuffer.push(this.renderTruthEvent(event.row));
      }
      this.logBuffer = this.logBuffer.slice(-400);
      this.repaintLogs();
    } finally {
      this.loading = false;
    }
  }

  private eventKey(kind: string, log: any): string {
    return `${kind}|${log.id || ''}|${log.created_at || ''}|${log.agent_id || ''}|${log.step_id || ''}|${log.command || log.action || ''}|${log.observation || log.stdout || ''}`;
  }

  private appendAgentEvent(log: any, repaint = false) {
    if (log.project_id !== this.projectId) return;
    const key = this.eventKey('agent', log);
    if (this.eventKeys.has(key)) return;
    this.eventKeys.add(key);
    this.logBuffer.push(this.renderAgentEvent(log));
    this.logBuffer = this.logBuffer.slice(-400);
    if (repaint) this.repaintLogs();
  }

  private appendExecutionEvent(log: any, repaint = false) {
    if (log.project_id !== this.projectId) return;
    const key = this.eventKey('execution', log);
    if (this.eventKeys.has(key)) return;
    this.eventKeys.add(key);
    this.logBuffer.push(this.renderExecutionEvent(log));
    this.logBuffer = this.logBuffer.slice(-400);
    if (repaint) this.repaintLogs();
  }

  private renderAgentEvent(log: any): string {
    const at = new Date(log.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const agent = escapeHtml(String(log.agent_id || 'agent').toUpperCase());
    const action = escapeHtml(actionLabel(log.action));
    const status = escapeHtml(String(log.status || 'thinking').toUpperCase());
    const input = log.action_input ? `<div class="pl-4 text-theta-muted">input: ${escapeHtml(JSON.stringify(log.action_input))}</div>` : '';
    const thought = log.thought ? `<div class="pl-4 text-theta-terminalText">thought: ${escapeHtml(log.thought)}</div>` : '';
    const observation = log.observation ? `<div class="pl-4 ${statusClass(log.status)} whitespace-pre-wrap">observation: ${escapeHtml(log.observation)}</div>` : '';
    return `<div class="border-l border-theta-border/60 pl-2 py-1"><span class="text-theta-muted">[${at}]</span> <span class="text-indigo-300 font-semibold">[${agent}]</span> <span class="text-theta-text font-semibold">${action}</span> <span class="${statusClass(log.status)}">${status}</span>${thought}${input}${observation}</div>`;
  }

  private renderExecutionEvent(log: any): string {
    const at = new Date(log.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const agent = escapeHtml(String(log.agent_id || 'agent').toUpperCase());
    const command = escapeHtml(log.command || '(automatic project check)');
    const stdout = log.stdout ? `<pre class="pl-4 text-theta-terminalText whitespace-pre-wrap">${escapeHtml(log.stdout)}</pre>` : '';
    const stderr = log.stderr ? `<pre class="pl-4 text-rose-300 whitespace-pre-wrap">${escapeHtml(log.stderr)}</pre>` : '';
    return `<div class="border-l border-amber-500/30 pl-2 py-1"><span class="text-theta-muted">[${at}]</span> <span class="text-amber-300 font-semibold">[${agent}] EXEC</span> <span class="text-theta-text">$ ${command}</span> <span class="${log.success ? 'text-emerald-300' : 'text-rose-300'}">${log.success ? 'EXIT 0' : 'FAILED'}</span>${stdout}${stderr}</div>`;
  }

  private appendTruthEvent(event: any, repaint = false) {
    const key = `truth|${event.id || ''}`;
    if (this.eventKeys.has(key)) return;
    this.eventKeys.add(key);
    this.logBuffer.push(this.renderTruthEvent(event));
    this.logBuffer = this.logBuffer.slice(-400);
    if (repaint) this.repaintLogs();
  }

  private renderTruthEvent(event: any): string {
    const at = new Date(event.finishedAt || event.startedAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const agent = escapeHtml(String(event.agentId || 'system').toUpperCase());
    const status = escapeHtml(String(event.status || 'unverified').toUpperCase());
    const statusColor = event.status === 'failed' ? 'text-rose-300' : event.status === 'completed' ? 'text-emerald-300' : event.status === 'dispatched' ? 'text-amber-300' : 'text-cyan-300';
    const detail = event.error ? ` — ${escapeHtml(event.error)}` : '';
    const meta = event.metadata?.subtaskId ? ` [${escapeHtml(String(event.metadata.subtaskId))}]` : '';
    return `<div class="border-l border-cyan-500/30 pl-2 py-0.5"><span class="text-theta-muted">[${at}]</span> <span class="text-cyan-300 font-semibold">[TRUTH/${agent}]</span> <span class="text-theta-text">${escapeHtml(String(event.action || 'execution'))}${meta}</span> <span class="${statusColor}">${status}</span>${detail}</div>`;
  }

  private repaintLogs() {
    const stream = document.getElementById('agentLogStream');
    if (!stream) return;
    stream.innerHTML = this.getBufferedLogsHTML() || '<div class="text-theta-muted">No persisted agent activity for this project yet.</div>';
    const output = document.getElementById('terminalOutput');
    if (output) output.scrollTop = output.scrollHeight;
  }

  public getBufferedLogsHTML(): string { return this.logBuffer.join(''); }
}

export const logAdapter = new LogTerminalAdapter();
