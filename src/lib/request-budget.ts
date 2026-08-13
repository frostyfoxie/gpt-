/**
 * Phase 2 — request-budget governor. Phase 3 note: this module now tracks budget purely by
 * (raw API key, model) — it has NO knowledge of agent roles or the KeyManager pool at all.
 * That's a deliberate split: KeyManager.getAvailableKey (Phase 3) is the thing that decides
 * WHICH key an agent should use out of the shared pool, and it does so by asking THIS module
 * "how much budget does key X have left on model Y" for every key in the pool. If this module
 * reached back into KeyManager to resolve an agent id to a key, the two files would import
 * each other (KeyManager needs budget numbers to pick a key; this module would need KeyManager
 * to resolve an agent id to a key) — so the contract here is strictly "give me a key string,
 * I'll tell you its budget," and the caller (KeyManager, or an engine call site holding a key
 * it already acquired) is responsible for supplying the actual key.
 *
 * Phase 0/1 cut the multiplier and made retries respect backoff, but neither stops several
 * quick tasks (each up to QUICK_TASK_MAX_TURNS calls) from running concurrently via
 * Promise.all and rapidly exhausting whatever provider quota currently applies in one burst —
 * followed by an autopilot retry doing it again. This
 * module gives the rest of the engine a way to ask "do I actually have budget left before I
 * spend it" instead of finding out from a 429.
 *
 * Tracked per (API key, model) because that's the thing Google actually rate-limits: two
 * agent roles sharing one physical key on the same model share one quota bucket, and a
 * single agent role switching models (dev1-3 escalating to a stronger model mid-task, see
 * ReActExecutionLoop.getModelForThisAgent) starts a fresh bucket for the new model. Now that
 * Phase 3 makes the whole pool sharable across every agent role, this per-key tracking is
 * exactly what lets KeyManager compare "real" remaining budget across every key in the pool
 * instead of a role-scoped guess. The raw key value itself is never stored — only a short
 * non-cryptographic hash of it — so this module doesn't duplicate the actual secret across
 * extra localStorage entries, and rotating a key naturally starts a clean bucket instead of
 * inheriting the old key's count.
 *
 * The local call history is an observation/telemetry window, not a claim about the provider's
 * actual quota window. Provider cooldown telemetry remains authoritative when the API supplies it.
 */

interface BudgetRecord {
  calls: number[];
  tokens: number[];
  cooldownUntil: number;
  lastQuotaCode?: number;
}
interface BudgetStore {
  [bucketKey: string]: BudgetRecord;
}

const STORAGE_KEY = 'theta_request_budget_v2';
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MIN_REQUEST_SPACING_MS = 350;
const OBSERVATION_WINDOW_MS = 60 * 1000;

// In-memory cache so a burst of calls in the same tick (e.g. several quick tasks dispatched
// via Promise.all) don't each re-parse localStorage from scratch. Loaded lazily on first use
// and kept in sync with every write.
let cache: BudgetStore | null = null;

function loadStore(): BudgetStore {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as BudgetStore) : {};
  } catch {
    return {};
  }
}

function saveStore(store: BudgetStore): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage full/unavailable (private browsing, quota, etc.) — the in-memory cache
    // still works for the rest of this session, it just won't survive a reload. Not worth
    // surfacing to the user for a budget-tracking nicety.
  }
}

function getStore(): BudgetStore {
  if (!cache) cache = loadStore();
  return cache;
}

/** Short non-cryptographic hash (32-bit, base36) — good enough to bucket keys without storing them verbatim a second time. Collisions between two real API keys are not a correctness concern here: worst case, two different keys share a quota bucket and one reports slightly less remaining budget than it actually has, which just makes the governor a little more conservative. */
function hashKey(raw: string): string {
  let h = 0;
  for (let i = 0; i < raw.length; i++) {
    h = (Math.imul(31, h) + raw.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function bucketKeyFor(apiKey: string, model: string): string {
  // Empty/missing key still buckets somewhere sane rather than throwing — a budget check is
  // a defensive "do I have room" question, not the place to surface a missing-key error.
  const safeKey = apiKey && apiKey.trim().length > 0 ? apiKey : 'unconfigured';
  return `${hashKey(safeKey)}:${model}`;
}

function getRecord(store: BudgetStore, bucket: string): BudgetRecord {
  const existing = store[bucket];
  if (!existing || Array.isArray((existing as any))) {
    const migrated = Array.isArray((existing as any)) ? { calls: existing as any as number[], tokens: [], cooldownUntil: 0 } : null;
    store[bucket] = migrated || { calls: [], tokens: [], cooldownUntil: 0 };
  }
  return store[bucket];
}

function prune(record: BudgetRecord): void {
  const now = Date.now();
  record.calls = record.calls.filter((t) => t > now - WINDOW_MS);
  record.tokens = record.tokens.filter((t) => t > now - OBSERVATION_WINDOW_MS);
  if (record.cooldownUntil < now) record.cooldownUntil = 0;
}

/**
 * Phase 4 — fired on `window` every time recordCall() actually records a call, so the quota
 * dashboard (src/ui-adapters/quota-status-panel.ts) can re-render live instead of polling
 * localStorage on a timer. Purely a UI notification: nothing in the engine listens for this,
 * so adding it doesn't touch agent logic, only tells anyone already watching that a number
 * changed. Safe to ignore if nothing is listening (dispatchEvent with no listeners is a no-op).
 */
const BUDGET_CHANGED_EVENT = 'theta:budget-changed';

export class RequestBudget {
  /** No fabricated quota number: Google rate limits vary by model, tier, project and usage.
   * This class only blocks on observed cooldowns and applies a small concurrency guard. */
  public static readonly DEFAULT_DAILY_LIMIT = Number.POSITIVE_INFINITY;
  public static readonly WINDOW_MS = WINDOW_MS;
  public static readonly CHANGED_EVENT = BUDGET_CHANGED_EVENT;

  /**
   * Subscribes to live budget changes; returns an unsubscribe function. No-op (returns a
   * no-op unsubscribe) outside a browser context.
   */
  public static onChange(listener: () => void): () => void {
    if (typeof window === 'undefined') return () => {};
    const handler = () => listener();
    window.addEventListener(BUDGET_CHANGED_EVENT, handler);
    return () => window.removeEventListener(BUDGET_CHANGED_EVENT, handler);
  }

  public static canProceed(apiKey: string, model: string): boolean {
    const store = getStore();
    const record = getRecord(store, bucketKeyFor(apiKey, model));
    prune(record);
    return record.cooldownUntil <= Date.now();
  }

  /** Returns Infinity when no provider quota is known. A finite value only appears after an
   * observed provider cooldown; Theta must not invent a hard daily quota such as 20. */
  public static getRemainingBudget(apiKey: string, model: string): number {
    const store = getStore();
    const record = getRecord(store, bucketKeyFor(apiKey, model));
    prune(record);
    return record.cooldownUntil > Date.now() ? 0 : Number.POSITIVE_INFINITY;
  }

  public static getResetInMs(apiKey: string, model: string): number {
    const store = getStore();
    const record = getRecord(store, bucketKeyFor(apiKey, model));
    prune(record);
    return Math.max(0, record.cooldownUntil - Date.now());
  }

  /** Record a successful/attempted model request with optional usage telemetry. */
  public static recordCall(apiKey: string, model: string, totalTokens?: number): void {
    const store = getStore();
    const bucket = bucketKeyFor(apiKey, model);
    const record = getRecord(store, bucket);
    prune(record);
    const now = Date.now();
    record.calls.push(now);
    if (Number.isFinite(totalTokens) && (totalTokens as number) >= 0) record.tokens.push(now);
    saveStore(store);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(BUDGET_CHANGED_EVENT, { detail: { apiKey, model } }));
    }
  }

  /** Learn an actual provider cooldown from a 429/503 response. No quota is guessed; the
   * provider's retry delay becomes the only hard stop. */
  public static recordProviderCooldown(apiKey: string, model: string, delayMs: number, code?: number): void {
    const store = getStore();
    const bucket = bucketKeyFor(apiKey, model);
    const record = getRecord(store, bucket);
    record.cooldownUntil = Math.max(record.cooldownUntil, Date.now() + Math.max(0, delayMs));
    record.lastQuotaCode = code;
    saveStore(store);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(BUDGET_CHANGED_EVENT, { detail: { apiKey, model, cooldownUntil: record.cooldownUntil, code } }));
    }
  }

  public static getObservedCallCount(apiKey: string, model: string): number {
    const store = getStore();
    const record = getRecord(store, bucketKeyFor(apiKey, model));
    prune(record);
    return record.calls.length;
  }

  /** For UI/debugging: current bucket id a key+model resolves to, without exposing the raw API key. */
  public static bucketIdFor(apiKey: string, model: string): string {
    return bucketKeyFor(apiKey, model);
  }
}
