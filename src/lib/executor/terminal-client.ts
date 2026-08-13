import { getActiveProjectId } from '../../engine/active-project';
import { getAccessToken } from '../supabase/auth';
import { LocalExecutor } from './local-executor';
import { logTerminalRun, emitExecutionRun, logReActStep } from '../supabase/logger';
import { recordExecutionHealth, getExecutionHealth } from './execution-health';

export interface TerminalClientCallbacks {
  onReady?: () => void;
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void;
  onCommandDone?: (event: { success: boolean; exitCode: number | null; cwd?: string; files?: any[] }) => void;
  onClosed?: (code: number | null, signal: string | null) => void;
  onError?: (message: string) => void;
}

/** Real terminal transport backed by the active project's isolated CodeSandbox VM. */
export class TerminalClient {
  private connected = false;
  private callbacks: TerminalClientCallbacks;
  private files: { path: string; content: string }[] = [];

  constructor(callbacks: TerminalClientCallbacks = {}) { this.callbacks = callbacks; }

  async connect(projectId: string, files: { path: string; content: string }[], callbacks?: TerminalClientCallbacks) {
    this.callbacks = { ...this.callbacks, ...(callbacks || {}) };
    this.files = files || [];
    if (!projectId || projectId !== getActiveProjectId()) throw new Error('No matching active project.');
    const token = await getAccessToken();
    if (!token) throw new Error('You must be signed in to open the terminal.');
    const response = await fetch('/api/executor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'ensure', projectId }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || `Terminal connection failed (${response.status}).`);
    this.connected = true;
    this.callbacks.onReady?.();
  }

  isConnected(): boolean { return this.connected; }

  private activeProcessName: string | null = null;
  private polling = false;
  private commandGeneration = 0;

  async send(command: string): Promise<void> {
    if (!this.connected) throw new Error('Terminal is not connected.');
    const projectId = getActiveProjectId();
    if (!projectId) throw new Error('No authenticated active project.');

    if (command === '\u0003') {
      await this.interrupt();
      return;
    }

    if (LocalExecutor.canRun(command)) {
      const local = await LocalExecutor.run(command);
      if (local.stdout) this.callbacks.onOutput?.('stdout', local.stdout);
      if (local.stderr) this.callbacks.onOutput?.('stderr', local.stderr);
      this.callbacks.onCommandDone?.({ success: local.success, exitCode: local.exitCode, cwd: '/workspace' });
      const prev = getExecutionHealth(projectId);
      recordExecutionHealth(projectId, { commands: (prev?.commands || 0) + 1, successes: (prev?.successes || 0) + (local.success ? 1 : 0), failures: (prev?.failures || 0) + (local.success ? 0 : 1), lastCommand: command, lastExitCode: local.exitCode, lastError: local.success ? undefined : local.stderr });
      void logTerminalRun({ command, success: local.success, stdout: local.stdout, stderr: local.stderr, exitCode: local.exitCode });
      if (!local.success) throw new Error(local.stderr || 'Local command failed.');
      return;
    }

    const token = await getAccessToken();
    if (!token) throw new Error('No authenticated session.');
    const generation = ++this.commandGeneration;
    const response = await fetch('/api/executor', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'terminalStart', projectId, command, files: this.files, syncFiles: !this.activeProcessName }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.processName) {
      const message = data?.error || `Terminal command failed to start (${response.status}).`;
      this.callbacks.onError?.(message);
      throw new Error(message);
    }

    this.activeProcessName = String(data.processName);
    void logReActStep({
      stepId: 0,
      agentId: 'terminal',
      thought: `Started real terminal command: ${command}`,
      action: 'terminal_execute',
      actionInput: { command },
      status: 'executing',
    });
    let stdoutOffset = 0;
    let stderrOffset = 0;
    let stdout = '';
    let stderr = '';
    const started = Date.now();
    const abortController = new AbortController();
    try {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (generation !== this.commandGeneration) return;
        const poll = await fetch('/api/executor', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ action: 'terminalPoll', projectId, processName: this.activeProcessName, command, agentId: 'terminal', stdoutOffset, stderrOffset }),
          signal: abortController.signal,
        });
        const state = await poll.json().catch(() => null);
        if (!poll.ok || !state) throw new Error(state?.error || `Terminal polling failed (${poll.status}).`);
        if (generation !== this.commandGeneration) return;
        if (state.stdout) { stdout += state.stdout; this.callbacks.onOutput?.('stdout', state.stdout); }
        if (state.stderr) { stderr += state.stderr; this.callbacks.onOutput?.('stderr', state.stderr); }
        stdoutOffset = Number(state.stdoutOffset) || stdoutOffset;
        stderrOffset = Number(state.stderrOffset) || stderrOffset;
        if (!state.running) {
          const exitCode = state.exitCode == null ? null : Number(state.exitCode);
          const success = Boolean(state.success);
          this.callbacks.onCommandDone?.({ success, exitCode, cwd: state.cwd, files: Array.isArray(state.files) ? state.files : undefined });
          const prev = getExecutionHealth(projectId);
          recordExecutionHealth(projectId, { commands: (prev?.commands || 0) + 1, successes: (prev?.successes || 0) + (success ? 1 : 0), failures: (prev?.failures || 0) + (success ? 0 : 1), totalMs: (prev?.totalMs || 0) + (Date.now() - started), lastCommand: command, lastExitCode: exitCode, lastError: success ? undefined : stderr });
          void emitExecutionRun({ command, success, stdout, stderr, exitCode, agentId: 'terminal', persist: false });
          this.activeProcessName = null;
          if (!success) throw new Error(stderr || `Command failed with exit code ${exitCode ?? 'unknown'}.`);
          return;
        }
        if (Date.now() - started > 190_000) {
          await this.interrupt();
          throw new Error('Terminal command exceeded the maximum client wait time.');
        }
      }
    } finally {
      if (generation !== this.commandGeneration) abortController.abort();
      if (this.activeProcessName && Date.now() - started > 190_000) this.activeProcessName = null;
    }
  }

  async interrupt(): Promise<void> {
    const token = await getAccessToken();
    const projectId = getActiveProjectId();
    const processName = this.activeProcessName;
    if (!token || !projectId || !processName) return;
    // Invalidate the current polling loop immediately so the UI can accept a new command
    // without waiting for the remote process to report its final state.
    this.commandGeneration++;
    this.activeProcessName = null;
    try {
      await fetch('/api/executor', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'interrupt', projectId, processName }),
      });
    } finally {
      this.callbacks.onCommandDone?.({ success: false, exitCode: 130 });
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.callbacks.onClosed?.(0, null);
  }
}
