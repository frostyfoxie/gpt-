import { vfsSync } from './lib/supabase/vfs-sync';
import { logAdapter } from './lib/supabase/log-translator';
import { runSupabaseSelfCheck, showStartupHealthBanner } from './lib/supabase/self-check';
import { ChiefChatAdapter } from './ui-adapters/chief-chat-adapter';
import { MikoChatAdapter } from './ui-adapters/miko-chat-adapter';
import { KeyModalManager } from './config/keys-modal';
import { KeyManager } from './config/keys';
import { ModelManager, AVAILABLE_MODELS } from './config/models';
import { QuotaStatusPanel } from './ui-adapters/quota-status-panel';
import { AuthGate } from './ui-adapters/auth-gate';
import { CommitManager } from './engine/commits';
import { CodeRunnerTools } from './tools/code-runner-tools';
import { FileSystemTools } from './tools/file-system-tools';
// Side-effect import: attaches window.FileDiffService (Phase 4 diff view). Imported directly
// here rather than through src/lib/diff/index.ts to avoid a cycle — see the comment at the
// top of file-diff-service.ts.
import './lib/diff/file-diff-service';
import { TerminalClient } from './lib/executor/terminal-client';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { getAccessToken } from './lib/supabase/auth';
import { ProjectsRepo } from './lib/supabase/projects';

// index.html's plain (non-module) inline <script> used to reach these with
// `import('/src/lib/supabase/auth.ts')` / `import('/src/lib/supabase/projects.ts')` at runtime.
// That doesn't do what it looks like it does: Vite's HTML plugin only treats import(...) calls
// inside a real `type="module"` script as part of its JS module graph. Inside a plain script,
// it treats the target as a generic ASSET reference (the same bucket as `<img src="...">`) and,
// for files under the inline-asset size threshold, base64-inlines the file as a `data:` URI —
// using Vite's own mime-type guesser, which has a long-standing unfixed bug mapping `.ts` to
// `video/mp2t` (MPEG transport stream) instead of a JS type (vitejs/vite#10124, #10271). Even
// with the right MIME type, what gets inlined is raw, UNTRANSPILED TypeScript source — real type
// annotations included — which can never execute via a browser's import() regardless. The build
// itself succeeds (no ENOENT); the failure only shows up live, in the browser console, as
// "Failed to fetch dynamically imported module: data:video/mp2t;base64,...". Exposing the two
// functions those call sites actually need as real globals — sourced from Vite's real module
// graph, so they're correctly bundled/transpiled — removes the dynamic import entirely.
declare global {
  interface Window {
    JSZip: typeof JSZip;
    saveAs: typeof saveAs;
    thetaGetAccessToken: typeof getAccessToken;
    thetaTouchProjectUpdatedAt: (projectId: string) => Promise<void>;
  }
}
if (typeof window !== 'undefined') {
  window.JSZip = JSZip;
  window.saveAs = saveAs;
  window.thetaGetAccessToken = getAccessToken;
  window.thetaTouchProjectUpdatedAt = (projectId: string) => ProjectsRepo.touchUpdatedAt(projectId);
}

export class ThetaSuiteApplication {
  private chiefAdapter?: ChiefChatAdapter;
  private mikoAdapter?: MikoChatAdapter;
  private keyModalManager!: KeyModalManager;
  private quotaStatusPanel!: QuotaStatusPanel;
  private authGate!: AuthGate;

  constructor() {
    if (typeof window !== 'undefined') {
      // Handles cases where DOM is already loaded before script runs
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => this.init());
      } else {
        this.init();
      }
    }
  }

  /**
   * Bootstraps all interconnected subsystems
   */
  private init() {
    console.log('[Theta Suite] Initializing multi-agent workspace runtime...');

    // 0. Auth gate — subscribes onAuthStateChange before anything else runs, so the OAuth
    // redirect-back (Supabase parses the session out of the URL on load) is caught and the
    // UI flips from #authGate to #workspaceShell without needing a manual page refresh.
    this.authGate = new AuthGate();

    // 1. Initialize API Key Modal Manager
    this.keyModalManager = new KeyModalManager();

    // 2. Instantiate Chat Adapters so UI event bindings exist immediately
    this.chiefAdapter = new ChiefChatAdapter();
    this.mikoAdapter = new MikoChatAdapter();

    // 2b. Phase 4 — persistent quota status badge/panel (read-only telemetry, no agent logic).
    this.quotaStatusPanel = new QuotaStatusPanel();

    // 3. Check key configuration status
    if (!KeyManager.isConfigured()) {
      console.warn('[Theta Suite] Gemini API keys not fully configured. Opening setup modal...');
      const modal = document.getElementById('apiKeysModal');
      if (modal) modal.classList.remove('hidden');

      if (typeof (window as any).showToast === 'function') {
        (window as any).showToast('Please configure at least one Gemini API key to begin.', 'error');
      }
    }

    // Real CodeSandbox terminal transport — the UI terminal sends commands to an authenticated
    // persistent bash session rather than emulating shell commands in the browser.
    (window as any).TerminalClient = TerminalClient;

    // 4. Attach Log Adapter to UI Terminal
    console.log('[Theta Suite] Real-time Log Translator attached to #terminalOutput.');

    // 5. Attach VFS Synchronizer & Log Adapter to Global Scope
    (window as any).vfsSync = vfsSync;
    (window as any).logAdapter = logAdapter;
    (window as any).ModelManager = ModelManager;
    (window as any).AVAILABLE_MODELS = AVAILABLE_MODELS;
    (window as any).CommitManager = CommitManager;
    // Lets the interactive Terminal tab (index.html) run real npm/node/python/git-style
    // commands against the live project via the CodeSandbox executor, when one is configured,
    // instead of only ever showing the "virtual shell" fallback message.
    (window as any).CodeRunnerTools = CodeRunnerTools;
    (window as any).FileSystemTools = FileSystemTools;

    // 6. Startup self-check: confirm Supabase is reachable and the tables Theta depends on
    // most (file locking, checkpoints) actually have the columns the app expects, instead
    // of finding out mid-task via a silent failure. Fire-and-forget — never blocks boot.
    void runSupabaseSelfCheck().then((result) => {
      if (result.ok) return;
      console.error('[Theta Suite] Supabase self-check failed:', result.issues);
      showStartupHealthBanner(result.issues);
      if (typeof (window as any).showToast === 'function') {
        (window as any).showToast('Supabase self-check failed — see the banner for details.', 'error');
      }
    });

    console.log('[Theta Suite] System initialized successfully. All agents ready.');
  }
}

// Export global suite runner instance safely
export const thetaSuiteApp = new ThetaSuiteApplication();
