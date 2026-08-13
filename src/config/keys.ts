import { RequestBudget } from '../lib/request-budget';
import type { ModelProvider } from './models';

/**
 * Phase 3: keys are no longer role-locked (chiefKey/mikoKey/dev1Key/.../criticKey). Every
 * agent role now draws from one shared pool of N user-supplied keys, so one exhausted
 * key doesn't stall a whole role — see KeyManager.getAvailableKey below. `pool` is an
 * arbitrary-length list; there's no fixed slot count anymore.
 *
 * Phase 10: there are now two independent pools, one per provider (Gemini / OpenRouter) —
 * see PROVIDER_STORAGE_KEYS. Every method below takes an explicit `provider` (defaulting to
 * 'gemini' for back-compat with pre-Phase-10 call sites) rather than inferring it, since this
 * module cannot import from config/models.ts (models.ts imports KeyManager already; a
 * two-way import would be circular) — callers resolve the provider for a model via
 * ModelManager.getProvider(model) and pass it in.
 */
export interface AgentKeys {
  pool: string[];
}

/** Pre-Phase-3 shape, kept only so getKeys() can migrate an existing saved Gemini key set. */
interface LegacyAgentKeys {
  chiefKey?: string;
  mikoKey?: string;
  dev1Key?: string;
  dev2Key?: string;
  dev3Key?: string;
  dev4Key?: string;
  criticKey?: string;
}

/** One sessionStorage key per provider — kept separate so a Gemini-only user's saved pool is
 *  untouched by Phase 10, and so the two pools never accidentally merge. */
const PROVIDER_STORAGE_KEYS: Record<ModelProvider, string> = {
  gemini: 'theta_suite_gemini_keys',
  openrouter: 'theta_suite_openrouter_keys',
};

const PROVIDER_LABELS: Record<ModelProvider, string> = {
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
};

/** Agent role — kept as a type for call-site parity and logging; it no longer determines
 *  which key is used (see class doc on getAvailableKey). */
export type BudgetAgentId = 'chief' | 'miko' | 'dev1' | 'dev2' | 'dev3' | 'dev4' | 'critic';

/**
 * Thrown by getAvailableKey when every key in the pool is out of quota for the requested
 * model. Carries resetInMs (from RequestBudget.getResetInMs, minimized across the whole pool)
 * so callers can tell the person a concrete "try again in ~N minutes" instead of a bare
 * "exhausted".
 */
export class PoolExhaustedError extends Error {
  public readonly model: string;
  public readonly resetInMs: number;

  constructor(model: string, resetInMs: number, provider: ModelProvider = 'gemini') {
    const minutes = Math.max(1, Math.ceil(resetInMs / 60000));
    super(
      `All keys in your ${PROVIDER_LABELS[provider]} pool are out of daily quota for "${model}". Resets in ~${minutes} minute(s), ` +
        `or add another key in settings to keep going now.`
    );
    this.name = 'PoolExhaustedError';
    this.model = model;
    this.resetInMs = resetInMs;
  }
}

export class KeyManager {
  /**
   * Keys currently claimed by an in-flight call. This is a SOFT signal used only to break
   * ties in getAvailableKey's LRU ordering (prefer a key nobody else is actively using right
   * now) — it never blocks selection or causes a throw. Shared across both provider pools:
   * the values themselves (raw key strings) are already unique per provider in practice, so
   * one Set/Map is fine. Concurrent quick tasks dispatched via Promise.all are the reason
   * this exists: without it, several tasks starting in the same tick would all pick the same
   * "least recently used" key at once. Callers that hold a key across a multi-turn task
   * should call releaseKey once the task completes so the next pick elsewhere isn't
   * needlessly biased away from it; callers that don't (e.g. long-lived instances like
   * ChiefOrchestrator/MikoChatAdapter spanning many unrelated calls) are fine leaving it — it
   * only ever costs a slightly less-optimal LRU pick, never a stall.
   */
  private static inUse: Set<string> = new Set();
  private static lastUsedAt: Map<string, number> = new Map();

  /**
   * Retrieves the stored key pool for `provider` from sessionStorage (session-scoped by
   * design), migrating an old fixed-role Gemini key set (chiefKey/mikoKey/dev1-4Key/criticKey)
   * into the new pool format on first read if found. The legacy format only ever existed for
   * Gemini, so migration is skipped entirely for 'openrouter'.
   */
  public static getKeys(provider: ModelProvider = 'gemini'): AgentKeys | null {
    if (typeof window === 'undefined') return null;
    const stored = sessionStorage.getItem(PROVIDER_STORAGE_KEYS[provider]);
    if (!stored) return null;

    let parsed: any;
    try {
      parsed = JSON.parse(stored);
    } catch {
      return null;
    }

    if (Array.isArray(parsed?.pool)) {
      return { pool: parsed.pool.filter((k: unknown): k is string => typeof k === 'string' && k.trim().length > 0) };
    }

    if (provider !== 'gemini') return { pool: [] };

    // Legacy format: migrate the old fixed-role keys into a de-duplicated pool and persist it,
    // so this only happens once per browser. A user who had e.g. the same key pasted into two
    // role slots ends up with one pool entry, not two — the pool cares about distinct
    // credentials, not how many roles used to point at them.
    const legacy = parsed as LegacyAgentKeys;
    const legacyValues = [
      legacy.chiefKey,
      legacy.mikoKey,
      legacy.dev1Key,
      legacy.dev2Key,
      legacy.dev3Key,
      legacy.dev4Key,
      legacy.criticKey,
    ].filter((k): k is string => typeof k === 'string' && k.trim().length > 0);

    const migrated: AgentKeys = { pool: Array.from(new Set(legacyValues)) };
    if (migrated.pool.length > 0) {
      this.saveKeys(migrated, provider);
    }
    return migrated;
  }

  /** Saves the key pool for `provider` to sessionStorage; keys are intentionally not persisted across browser restarts. */
  public static saveKeys(keys: AgentKeys, provider: ModelProvider = 'gemini'): void {
    if (typeof window === 'undefined') return;
    sessionStorage.setItem(PROVIDER_STORAGE_KEYS[provider], JSON.stringify({ pool: keys.pool }));
    // Phase 4: tell anything watching (the quota dashboard) that the pool itself changed,
    // not just a budget number — same no-op-if-unwatched contract as RequestBudget's event.
    window.dispatchEvent(new CustomEvent(KeyManager.POOL_CHANGED_EVENT, { detail: { provider } }));
  }

  public static readonly POOL_CHANGED_EVENT = 'theta:keys-changed';

  /** Subscribes to pool add/remove/migrate changes (either provider); returns an unsubscribe function. */
  public static onPoolChange(listener: () => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const handler = () => listener();
    window.addEventListener(KeyManager.POOL_CHANGED_EVENT, handler);
    return () => window.removeEventListener(KeyManager.POOL_CHANGED_EVENT, handler);
  }

  /** Returns the current pool for `provider` (never null — an empty array if nothing is configured). */
  public static getPool(provider: ModelProvider = 'gemini'): string[] {
    return this.getKeys(provider)?.pool ?? [];
  }

  /** Adds one key to `provider`'s pool (no-op if blank or already present). */
  public static addKey(key: string, provider: ModelProvider = 'gemini'): void {
    const trimmed = key.trim();
    if (!trimmed) return;
    const keys = this.getKeys(provider) || { pool: [] };
    if (!keys.pool.includes(trimmed)) {
      keys.pool.push(trimmed);
      this.saveKeys(keys, provider);
    }
  }

  /** Removes one key from `provider`'s pool and clears its in-memory bookkeeping. */
  public static removeKey(key: string, provider: ModelProvider = 'gemini'): void {
    const keys = this.getKeys(provider);
    if (!keys) return;
    keys.pool = keys.pool.filter((k) => k !== key);
    this.saveKeys(keys, provider);
    this.inUse.delete(key);
    this.lastUsedAt.delete(key);
  }

  /**
   * Returns the least-recently-used pooled key (from `provider`'s pool) that still has quota
   * remaining for `model` (per RequestBudget's rolling 24h window), marking it in-use.
   * `agentId` is kept purely for logging/back-compat call-site parity — key selection itself
   * is agent-agnostic now, since the whole pool for a given provider is shared across every
   * role (that's the point of pooling: one exhausted key no longer stalls a role, because
   * that role just gets handed a different key).
   *
   * Throws PoolExhaustedError (with remaining-time-until-reset) if every key in the pool is
   * out of quota for this model. Throws a plain Error if no keys are configured at all.
   */
  public static getAvailableKey(agentId: BudgetAgentId, model: string, provider: ModelProvider = 'gemini'): string {
    const pool = this.getPool(provider);
    if (pool.length === 0) {
      throw new Error(
        `[KeyManager Error]: No ${PROVIDER_LABELS[provider]} API keys configured. Please add at least one ${PROVIDER_LABELS[provider]} key in settings. (requested by agent '${agentId}')`
      );
    }

    let best: { key: string; lastUsed: number } | null = null;
    let minResetInMs = Infinity;
    let hasAvailableQuotaKey = false;
    let hasInUseKey = false;

    for (const key of pool) {
      const remaining = RequestBudget.getRemainingBudget(key, model);
      if (remaining <= 0) {
        minResetInMs = Math.min(minResetInMs, RequestBudget.getResetInMs(key, model));
        continue;
      }
      hasAvailableQuotaKey = true;
      if (this.inUse.has(key)) {
        hasInUseKey = true;
        continue;
      }
      const candidate = { key, lastUsed: this.lastUsedAt.get(key) ?? 0 };
      if (!best || candidate.lastUsed < best.lastUsed) best = candidate;
    }

    if (!best) {
      if (hasAvailableQuotaKey && hasInUseKey) {
        const error = new Error(`All available ${PROVIDER_LABELS[provider]} keys are currently in use for ${model}.`);
        error.name = 'KeyPoolBusyError';
        throw error;
      }
      throw new PoolExhaustedError(model, Number.isFinite(minResetInMs) ? minResetInMs : RequestBudget.WINDOW_MS, provider);
    }

    this.inUse.add(best.key);
    this.lastUsedAt.set(best.key, Date.now());
    return best.key;
  }

  /** Sum of remaining quota for `model` across every key in `provider`'s pool — a rough "total room left" figure for UI/toasts. 0 if the pool is empty. */
  public static getPoolRemainingBudget(model: string, provider: ModelProvider = 'gemini'): number {
    return this.getPool(provider).reduce((sum, key) => sum + RequestBudget.getRemainingBudget(key, model), 0);
  }

  /** Releases a key claimed via getAvailableKey — see the inUse doc above for why this is a nicety, not a correctness requirement. Safe to call on a key that was never claimed. */
  public static releaseKey(key: string): void {
    this.inUse.delete(key);
  }

  /** True once at least one key has been added to `provider`'s pool. */
  public static isConfigured(provider: ModelProvider = 'gemini'): boolean {
    return this.getPool(provider).length > 0;
  }
}
