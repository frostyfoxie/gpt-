import { KeyManager } from './keys';
import type { ModelProvider } from './models';

/** Masks all but the last 4 characters of a key for display — never show a full key back once saved. */
function maskKey(key: string): string {
  if (key.length <= 4) return '*'.repeat(key.length);
  return `${'*'.repeat(Math.max(0, key.length - 4))}${key.slice(-4)}`;
}

/** Static per-provider copy for the two pool sections rendered below. */
const PROVIDER_COPY: Record<ModelProvider, { title: string; placeholder: string; blurb: string }> = {
  gemini: {
    title: 'Gemini API Key Pool',
    placeholder: 'AIzaSy...',
    blurb:
      'Add one or more free-tier Gemini API keys. Every agent (Chief, Miko, the dev agents, the ' +
      'critic) shares this pool and automatically rotates to whichever key still has quota left — ' +
      'add more keys any time to raise your daily ceiling.',
  },
  openrouter: {
    title: 'OpenRouter API Key Pool',
    placeholder: 'sk-or-v1-...',
    blurb:
      'Add one or more OpenRouter API keys. Any role the backend automatically routes to an ' +
      'OpenRouter model (see Settings → About for the current model list) draws from this pool the ' +
      'same way the Gemini pool works — shared across roles, rotated to whichever key still has quota.',
  },
};

export class KeyModalManager {
  private static initialized = false;

  constructor() {
    if (typeof window !== 'undefined' && !KeyModalManager.initialized) {
      // Ensure backend configuration is set immediately on initialization, before the user
      // ever opens Settings — this is what lets people use Theta with only their Gemini keys.

      this.initModalUI();
      KeyModalManager.initialized = true;
    }
  }

  /**
   * Injects the Key Configuration Modal into the DOM if missing.
   *
   * Phase 3: replaced the old 6 fixed role-labeled inputs with a free-form list — add as many
   * (or as few) Gemini keys as you have, no longer locked to exactly one key per role. Every
   * agent role now draws from this shared pool (see KeyManager.getAvailableKey), so one
   * exhausted key no longer stalls a whole role the way a fixed chiefKey/mikoKey/etc. did.
   *
   * Phase 10: the modal now renders two independent pool sections — Gemini and OpenRouter —
   * built from the same markup/behavior via buildPoolSectionHtml/bindPoolEvents/renderPoolList
   * parameterized by provider, rather than duplicating the whole block twice.
   */
  private initModalUI() {
    if (typeof window === 'undefined') return;
    if (document.getElementById('apiKeysModal')) return;

    const modalHtml = `
      <div id="apiKeysModal" class="hidden fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
        <div class="bg-theta-panel border border-theta-border rounded-xl shadow-2xl p-5 w-full max-w-md space-y-4 text-xs max-h-[85vh] overflow-y-auto">
          <div class="flex items-center justify-between border-b border-theta-border pb-2">
            <h3 class="font-semibold text-theta-text flex items-center gap-2 text-sm">
              <i data-lucide="key" class="w-4 h-4 text-theta-accent"></i> API Key Pools
            </h3>
            <button id="closeKeysModalBtn" class="text-theta-muted hover:text-theta-text">
              <i data-lucide="x" class="w-4 h-4"></i>
            </button>
          </div>

          ${this.buildPoolSectionHtml('gemini')}
          <div class="border-t border-theta-border"></div>
          ${this.buildPoolSectionHtml('openrouter')}

          <div class="flex justify-end space-x-2 pt-2 border-t border-theta-border">
            <button id="closeKeysModalBtn2" class="px-3 py-1.5 rounded-md text-theta-muted hover:text-theta-text bg-theta-bg border border-theta-border">Done</button>
          </div>
        </div>
      </div>
    `;

    document.body.insertAdjacentHTML('beforeend', modalHtml);
    if ((window as any).lucide) (window as any).lucide.createIcons();
    this.bindEvents();
    this.renderPoolList('gemini');
    this.renderPoolList('openrouter');
  }

  private buildPoolSectionHtml(provider: ModelProvider): string {
    const copy = PROVIDER_COPY[provider];
    return `
      <div class="space-y-2">
        <h4 class="font-medium text-theta-text text-[11px]">${copy.title}</h4>
        <p class="text-[11px] text-theta-muted">
          ${copy.blurb} Keys are stored only for this browser session and never uploaded to Theta servers. A page/browser restart may require you to enter them again.
        </p>
        <div id="keyPoolList-${provider}" class="space-y-1.5 max-h-40 overflow-y-auto pr-1"></div>
        <div class="flex gap-2 pt-1">
          <input type="password" id="newKeyInput-${provider}" placeholder="${copy.placeholder}" class="flex-1 bg-theta-bg border border-theta-border rounded-md px-2.5 py-1.5 text-theta-text focus:border-theta-accent focus:outline-none font-mono">
          <button id="addKeyBtn-${provider}" class="px-3 py-1.5 rounded-md text-white bg-theta-accent hover:bg-theta-accentHover font-medium shrink-0">Add</button>
        </div>
      </div>
    `;
  }

  private bindEvents() {
    const modal = document.getElementById('apiKeysModal');
    const openMenuItem = document.getElementById('openApiKeysMenuItem');
    const closeBtn = document.getElementById('closeKeysModalBtn');
    const closeBtn2 = document.getElementById('closeKeysModalBtn2');

    const showModal = () => {
      this.renderPoolList('gemini');
      this.renderPoolList('openrouter');
      modal?.classList.remove('hidden');
    };

    if (openMenuItem) {
      openMenuItem.addEventListener('click', () => {
        document.getElementById('settingsMenu')?.classList.add('hidden');
        showModal();
      });
    }

    if (typeof window !== 'undefined') {
      (window as any).openApiKeysModal = showModal;
    }

    const hideModal = () => modal?.classList.add('hidden');
    closeBtn?.addEventListener('click', hideModal);
    closeBtn2?.addEventListener('click', hideModal);

    this.bindPoolEvents('gemini');
    this.bindPoolEvents('openrouter');
  }

  private bindPoolEvents(provider: ModelProvider) {
    const addBtn = document.getElementById(`addKeyBtn-${provider}`);
    const newKeyInput = document.getElementById(`newKeyInput-${provider}`) as HTMLInputElement | null;

    const addCurrentInput = () => {
      const val = newKeyInput?.value.trim() || '';
      if (!val) return;
      KeyManager.addKey(val, provider);
      if (newKeyInput) newKeyInput.value = '';
      this.renderPoolList(provider);
      if (typeof (window as any).showToast === 'function') {
        (window as any).showToast(`Key added to ${PROVIDER_COPY[provider].title.replace(' API Key Pool', '')} pool!`, 'success');
      }
    };

    addBtn?.addEventListener('click', addCurrentInput);
    newKeyInput?.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') addCurrentInput();
    });
  }

  /** Renders `provider`'s current pool as a removable list, showing each key masked (last 4 chars only). */
  private renderPoolList(provider: ModelProvider) {
    const list = document.getElementById(`keyPoolList-${provider}`);
    if (!list) return;

    const pool = KeyManager.getPool(provider);
    const label = PROVIDER_COPY[provider].title.replace(' API Key Pool', '');

    if (pool.length === 0) {
      list.innerHTML = `<p class="text-theta-muted text-[11px] italic py-2">No keys yet — add at least one ${label} key below to get started.</p>`;
      return;
    }

    list.innerHTML = pool
      .map(
        (key, i) => `
      <div class="flex items-center justify-between gap-2 bg-theta-bg border border-theta-border rounded-md px-2.5 py-1.5">
        <div class="flex flex-col min-w-0">
          <span class="font-mono text-theta-text truncate">${maskKey(key)}</span>
          <span class="text-theta-muted text-[10px]">Key ${i + 1} of ${pool.length}</span>
        </div>
        <button data-remove-key-index="${i}" data-remove-key-provider="${provider}" class="text-theta-muted hover:text-red-400 shrink-0" title="Remove this key">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>`
      )
      .join('');

    if ((window as any).lucide) (window as any).lucide.createIcons();

    list.querySelectorAll('[data-remove-key-index]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const idx = Number((btn as HTMLElement).dataset.removeKeyIndex);
        const target = KeyManager.getPool(provider)[idx];
        if (target === undefined) return;
        KeyManager.removeKey(target, provider);
        this.renderPoolList(provider);
        if (typeof (window as any).showToast === 'function') {
          (window as any).showToast(`Key removed from ${label} pool.`, 'info');
        }
      });
    });
  }
}
