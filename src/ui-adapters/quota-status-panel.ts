import { KeyManager } from '../config/keys';
import { RequestBudget } from '../lib/request-budget';
import { ModelManager, AVAILABLE_MODELS, QUICK_TASK_MODEL_TIERS } from '../config/models';
import type { ModelProvider } from '../config/models';
import { ReActExecutionLoop } from '../engine/react-loop';

/**
 * Phase 4 — read-only quota telemetry. This module renders live, it never decides anything:
 * all budget/key logic still lives in RequestBudget (Phase 2) and KeyManager (Phase 3); this
 * file only reads their public surface (getPool, getRemainingBudget, DEFAULT_DAILY_LIMIT) and
 * subscribes to their change events (RequestBudget.onChange / KeyManager.onPoolChange) to
 * re-render. No agent, engine, or orchestrator code is touched.
 *
 * Phase 10 — now covers both key pools (Gemini + OpenRouter), each rendered as its own
 * section in the detail panel. The Gemini section still shows exactly what it always has
 * (every role/tier model — see relevantModelsFor). The OpenRouter section shows every
 * OpenRouter model in the registry, since none of them is a fixed role/tier default yet
 * (see the Phase 10 note atop config/models.ts) — there's no "currently in use" subset to
 * narrow to, so the useful thing to show is "what could the backend route to if it did."
 *
 * UI shape: a small persistent badge in the header (always visible, like
 * #connectionStatusBadge next to it) summarizing overall pool health across both providers,
 * plus a click-to-expand dropdown with the full per-key/per-model breakdown the Phase 4 spec
 * asked for (masked key, assigned model(s), calls used / estimated daily limit, colored
 * state).
 */

type QuotaState = 'green' | 'amber' | 'red';

interface ModelRow {
  modelId: string;
  label: string;
  used: number;
  limit?: number;
  remaining?: number;
  state: QuotaState;
}

interface KeyRow {
  key: string;
  masked: string;
  models: ModelRow[];
}

function maskKey(key: string): string {
  if (key.length <= 4) return '*'.repeat(key.length);
  return `••••${key.slice(-4)}`;
}

function stateFor(remaining: number, resetInMs: number): QuotaState {
  if (remaining <= 0 && resetInMs > 0) return 'red';
  if (resetInMs > 0) return 'amber';
  return 'green';
}

const STATE_DOT_CLASS: Record<QuotaState, string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-400',
  red: 'bg-red-500',
};

const STATE_TEXT_CLASS: Record<QuotaState, string> = {
  green: 'text-emerald-400',
  amber: 'text-amber-400',
  red: 'text-red-400',
};

const STATE_BAR_CLASS: Record<QuotaState, string> = {
  green: 'bg-emerald-500',
  amber: 'bg-amber-400',
  red: 'bg-red-500',
};

const PROVIDER_LABELS: Record<ModelProvider, string> = {
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
};

export class QuotaStatusPanel {
  private static initialized = false;
  private unsubscribers: Array<() => void> = [];

  constructor() {
    if (typeof window === 'undefined' || QuotaStatusPanel.initialized) return;
    QuotaStatusPanel.initialized = true;
    this.injectDom();
    this.bindEvents();
    this.render();
  }

  /**
   * Every model actually reachable from the UI right now, for a given provider.
   *
   * Gemini: whatever Chief/Miko/Critic have selected (defaults if unset), the dev1-3
   * hardcoded lane and its escalation target (Phase 0/react-loop.ts), and — as of Phase
   * 6-A — the full QUICK_TASK_MODEL_TIERS list, since a quick chat edit can now land on any
   * tier in that list depending on which one currently has budget
   * (ModelManager.getCheapestAvailableModel), not just the old fixed dev1-3 model. So dev
   * agents (and every tier quick-task routing might actually pick) show up even though they
   * aren't a `ModelAgentRole` with their own picker.
   *
   * OpenRouter: no role/tier currently defaults to an OpenRouter id (see the Phase 10 note
   * atop config/models.ts), so there's nothing to narrow to — every OpenRouter model in the
   * registry is shown instead.
   *
   * De-duplicated; order is stable so the panel doesn't reshuffle between renders.
   */
  private relevantModelsFor(provider: ModelProvider): string[] {
    if (provider === 'openrouter') {
      return AVAILABLE_MODELS.filter((m) => m.provider === 'openrouter').map((m) => m.id);
    }
    const ids = [
      ModelManager.getModel('chief'),
      ModelManager.getModel('miko'),
      ModelManager.getModel('critic'),
      ReActExecutionLoop.DEV_1_TO_3_HARDCODED_MODEL,
      ReActExecutionLoop.DEV_1_TO_3_ESCALATED_MODEL,
      ...QUICK_TASK_MODEL_TIERS,
    ];
    return Array.from(new Set(ids));
  }

  private modelLabel(modelId: string): string {
    return ModelManager.getOption(modelId)?.label ?? AVAILABLE_MODELS.find((m) => m.id === modelId)?.label ?? modelId;
  }

  private buildRowsFor(provider: ModelProvider): KeyRow[] {
    const pool = KeyManager.getPool(provider);
    const models = this.relevantModelsFor(provider);
    return pool.map((key) => {
      const modelRows: ModelRow[] = models.map((modelId) => {
        const observed = RequestBudget.getObservedCallCount(key, modelId);
        const resetInMs = RequestBudget.getResetInMs(key, modelId);
        return {
          modelId,
          label: this.modelLabel(modelId),
          used: observed,
          limit: undefined,
          remaining: RequestBudget.getRemainingBudget(key, modelId),
          state: stateFor(RequestBudget.getRemainingBudget(key, modelId), resetInMs),
        };
      });
      return { key, masked: maskKey(key), models: modelRows };
    });
  }

  /** Worst-case color across a pool: for each model, take the BEST remaining % any key in the
   *  pool can offer (that's what KeyManager.getAvailableKey would actually hand out) — then
   *  the badge shows the worst of those per-model bests, since that's the model closest to
   *  genuinely stalling the pool rather than just one already-tired key. */
  private overallStateFor(rows: KeyRow[], provider: ModelProvider): QuotaState {
    if (rows.length === 0) return 'red';
    const models = this.relevantModelsFor(provider);
    let hasCooldown = false;
    for (const modelId of models) {
      const modelRows = rows.flatMap((r) => r.models.filter((m) => m.modelId === modelId));
      if (modelRows.some((m) => m.remaining === 0)) hasCooldown = true;
    }
    return hasCooldown ? 'amber' : 'green';
  }

  private injectDom(): void {
    if (document.getElementById('quotaStatusBadge')) return;
    const anchor = document.getElementById('quotaPanelAnchor');
    if (!anchor) return;

    const html = `
      <div class="relative">
        <button id="quotaStatusBadge" title="Model quota status" class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-mono bg-theta-bg text-theta-muted border border-theta-border transition-all duration-300 hover:opacity-80 cursor-pointer mr-1.5">
          <span class="relative flex h-2 w-2">
            <span id="quotaStatusDot" class="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
          </span>
          <span id="quotaStatusText">quota</span>
        </button>
        <div id="quotaStatusPanel" class="hidden absolute right-0 top-full mt-2 w-72 bg-theta-panel border border-theta-border rounded-xl shadow-2xl p-3 z-50 text-xs space-y-2 max-h-96 overflow-y-auto">
          <div class="flex items-center justify-between pb-2 border-b border-theta-border">
            <span class="font-semibold text-theta-text flex items-center gap-1.5">
              <i data-lucide="gauge" class="w-3.5 h-3.5 text-theta-accent"></i> Model Quota
            </span>
            <button id="closeQuotaPanelBtn" class="text-theta-muted hover:text-theta-text">
              <i data-lucide="x" class="w-3.5 h-3.5"></i>
            </button>
          </div>
          <div id="quotaStatusList" class="space-y-3"></div>
          <p class="text-[10px] text-theta-muted pt-1 border-t border-theta-border">Theta does not assume a fixed request/day quota. It only pauses a key/model when provider telemetry says it is rate-limited.</p>
        </div>
      </div>
    `;
    anchor.insertAdjacentHTML('beforebegin', html);
    if ((window as any).lucide) (window as any).lucide.createIcons();
  }

  private bindEvents(): void {
    const badge = document.getElementById('quotaStatusBadge');
    const panel = document.getElementById('quotaStatusPanel');
    const closeBtn = document.getElementById('closeQuotaPanelBtn');

    badge?.addEventListener('click', () => {
      panel?.classList.toggle('hidden');
      if (panel && !panel.classList.contains('hidden')) this.render();
    });
    closeBtn?.addEventListener('click', () => panel?.classList.add('hidden'));
    document.addEventListener('click', (e) => {
      if (!panel || panel.classList.contains('hidden')) return;
      const target = e.target as Node;
      if (!panel.contains(target) && !badge?.contains(target)) panel.classList.add('hidden');
    });

    // Live updates: a real call recorded, or either key pool changing (add/remove/migrate).
    this.unsubscribers.push(RequestBudget.onChange(() => this.render()));
    this.unsubscribers.push(KeyManager.onPoolChange(() => this.render()));
  }

  /** Re-renders both the always-visible badge and the (possibly hidden) detail panel. Cheap
   *  enough to call on every change event — it's a handful of localStorage reads, not a
   *  network call. */
  private render(): void {
    const geminiRows = this.buildRowsFor('gemini');
    const openrouterRows = this.buildRowsFor('openrouter');
    this.renderBadge(geminiRows, openrouterRows);
    this.renderList(geminiRows, openrouterRows);
  }

  private renderBadge(geminiRows: KeyRow[], openrouterRows: KeyRow[]): void {
    const dot = document.getElementById('quotaStatusDot');
    const text = document.getElementById('quotaStatusText');
    const badge = document.getElementById('quotaStatusBadge');
    if (!dot || !text || !badge) return;

    const totalKeys = geminiRows.length + openrouterRows.length;
    if (totalKeys === 0) {
      dot.className = 'relative inline-flex rounded-full h-2 w-2 bg-theta-muted';
      text.textContent = 'no keys';
      badge.title = 'No API keys configured yet — add one in settings.';
      return;
    }

    const states = [
      geminiRows.length > 0 ? this.overallStateFor(geminiRows, 'gemini') : null,
      openrouterRows.length > 0 ? this.overallStateFor(openrouterRows, 'openrouter') : null,
    ].filter((s): s is QuotaState => s !== null);
    const worst: QuotaState = states.includes('red') ? 'red' : states.includes('amber') ? 'amber' : 'green';

    dot.className = `relative inline-flex rounded-full h-2 w-2 ${STATE_DOT_CLASS[worst]}`;
    text.textContent = `${totalKeys} key${totalKeys === 1 ? '' : 's'}`;
    badge.title = `Quota: ${worst === 'green' ? 'healthy' : worst === 'amber' ? 'running low' : 'critical'} — click for details`;
  }

  private renderSection(provider: ModelProvider, rows: KeyRow[]): string {
    const label = PROVIDER_LABELS[provider];
    if (rows.length === 0) {
      return `
        <div class="space-y-1">
          <div class="text-[10px] font-semibold text-theta-muted uppercase tracking-wide">${label}</div>
          <p class="text-theta-muted text-[11px] italic py-1">No keys yet — add one via Settings → API Key Pools.</p>
        </div>`;
    }

    return `
      <div class="space-y-1.5">
        <div class="text-[10px] font-semibold text-theta-muted uppercase tracking-wide">${label}</div>
        ${rows
          .map(
            (row) => `
        <div class="bg-theta-bg border border-theta-border rounded-md p-2 space-y-1.5">
          <div class="font-mono text-theta-text text-[11px]">${row.masked}</div>
          <div class="space-y-1">
            ${row.models
              .map(
                (m) => `
              <div class="space-y-0.5">
                <div class="flex items-center justify-between text-[10px]">
                  <span class="text-theta-muted truncate pr-2">${m.label}</span>
                  <span class="${STATE_TEXT_CLASS[m.state]} font-mono shrink-0">${m.used} observed${m.remaining === 0 ? ' · cooldown' : ''}</span>
                </div>
                <div class="h-1 w-full bg-theta-panelHover rounded-full overflow-hidden">
                  <div class="h-full ${STATE_BAR_CLASS[m.state]}" style="width: ${m.remaining === 0 ? 100 : 8}%"></div>
                </div>
              </div>`
              )
              .join('')}
          </div>
        </div>`
          )
          .join('')}
      </div>`;
  }

  private renderList(geminiRows: KeyRow[], openrouterRows: KeyRow[]): void {
    const list = document.getElementById('quotaStatusList');
    if (!list) return;

    list.innerHTML = `${this.renderSection('gemini', geminiRows)}${this.renderSection('openrouter', openrouterRows)}`;
  }
}
