/**
 * Backoff/retry wrapper for Gemini API calls, specifically targeting HTTP 429 /
 * RESOURCE_EXHAUSTED quota-exceeded responses. A free-tier quota error from Google looks
 * like this (the raw JSON error body, which the @google/genai SDK typically serializes into
 * the thrown Error's `.message` rather than exposing as structured fields):
 *
 *   {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"...",
 *     "details":[..., {"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"36s"}]}}
 *
 * Detection below checks structured fields first (in case a future SDK version does expose
 * them) and falls back to regex over the stringified message either way — the same
 * defense-in-depth approach `explainGeminiAuthError` already uses in gemini-error.ts for the
 * 401 case, kept consistent here rather than assuming a shape the SDK doesn't guarantee.
 *
 * This module does NOT touch prompts, tool schemas, or any business logic — it only wraps
 * the network call itself. Non-quota errors (auth, network, malformed request, etc.) are not
 * retried here; they pass straight through on the first failure so we don't waste budget
 * retrying something backoff can't fix. explainGeminiAuthError still owns the 401 case.
 */

export class TokenLimitError extends Error {
  public readonly original: unknown;
  constructor(original: unknown) {
    super('Token limit reached.');
    this.name = 'TokenLimitError';
    this.original = original;
  }
}

export class QuotaExceededError extends Error {
  public readonly original: unknown;

  constructor(message: string, original: unknown) {
    super(message);
    this.name = 'QuotaExceededError';
    this.original = original;
  }
}

export interface BackoffOptions {
  /** Optional callback when Google explicitly reports a quota cooldown. */
  onQuotaCooldown?: (delayMs: number, code?: number) => void;
  /** Max retry attempts after the initial call (so 3 = up to 4 total attempts). Default 3. */
  maxRetries?: number;
  /** Base delay for exponential backoff when no retryDelay is present, in ms. Default 1000. */
  baseDelayMs?: number;
  /** Cap for exponential backoff delay, in ms. Default 30000. */
  maxDelayMs?: number;
  /** Called right before each wait — attempt number (1-based), the delay in ms, and a short human-readable reason. Useful for surfacing a toast at call sites that have one available. */
  onRetry?: (attempt: number, delayMs: number, reason: string) => void;
}

const DEFAULTS: Required<Omit<BackoffOptions, 'onRetry' | 'onQuotaCooldown'>> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

function isTokenLimitError(error: unknown): boolean {
  const message = (error as any)?.message ? String((error as any).message) : String(error ?? '');
  return /(token limit|maximum (?:input|context|output) tokens|context length|too many tokens|prompt is too long|input.*too large)/i.test(message);
}

function isQuotaExceededError(error: unknown): boolean {
  const status = (error as any)?.status ?? (error as any)?.error?.status;
  const code = (error as any)?.code ?? (error as any)?.error?.code ?? (error as any)?.status_code;
  if (status === 'RESOURCE_EXHAUSTED' || code === 429) return true;

  const message = (error as any)?.message ? String((error as any).message) : String(error ?? '');
  return /RESOURCE_EXHAUSTED/i.test(message) || /"code"\s*:\s*429/.test(message);
}

/**
 * Parses a Google RetryInfo `retryDelay` value like "36s" or "36.697176258s" into whole ms,
 * rounded up (better to wait slightly too long than to re-hit the wall early). Returns null
 * if no RetryInfo is present — callers fall back to exponential backoff in that case.
 */
function extractRetryDelayMs(error: unknown): number | null {
  const details = (error as any)?.details ?? (error as any)?.error?.details ?? null;
  if (Array.isArray(details)) {
    const retryInfo = details.find(
      (d: any) => typeof d?.['@type'] === 'string' && d['@type'].includes('RetryInfo')
    );
    const parsed = parseDelayString(retryInfo?.retryDelay);
    if (parsed !== null) return parsed;
  }

  const message = (error as any)?.message ? String((error as any).message) : String(error ?? '');
  const match = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  return match ? Math.ceil(parseFloat(match[1]) * 1000) : null;
}

function parseDelayString(raw: unknown): number | null {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/^(\d+(?:\.\d+)?)s$/);
  return match ? Math.ceil(parseFloat(match[1]) * 1000) : null;
}

/**
 * Phase 2: exported so callers outside this module (specifically ChiefOrchestrator's
 * autopilot retry) can honor the same "wait exactly what Google told us" logic this module
 * already applies internally, even when all they have is a plain string (e.g. a
 * QuotaExceededError's `.message`, already stringified by the time it reaches a caller several
 * layers up) rather than the original thrown error object. Reuses the same regex
 * `extractRetryDelayMs` applies to a stringified message, so behavior stays identical whether
 * the delay is read from the live error or from text derived from it later.
 */
export function parseRetryDelayFromText(text: string): number | null {
  const match = text.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/) || text.match(/retry in (\d+(?:\.\d+)?)s/i);
  return match ? Math.ceil(parseFloat(match[1]) * 1000) : null;
}

/**
 * Phase 2: exported version of the same jittered-exponential-backoff math `callWithBackoff`
 * uses internally, for callers that need to compute a stand-in delay outside of an actual
 * retry loop (e.g. the orchestrator's autopilot retry, which waits once between two separate
 * top-level task attempts rather than retrying the same call).
 */
export function computeBackoffDelayMs(
  attempt: number,
  opts: { baseDelayMs?: number; maxDelayMs?: number } = {}
): number {
  const baseDelayMs = opts.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULTS.maxDelayMs;
  const cap = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
  return Math.floor(Math.random() * cap);
}

/** Exponential backoff with full jitter (random 0..cap rather than a fixed value) so several concurrent callers hitting the same wall don't all retry in lockstep and immediately re-collide. */
function backoffDelayMs(attempt: number, opts: Required<Omit<BackoffOptions, 'onRetry' | 'onQuotaCooldown'>>): number {
  const cap = Math.min(opts.baseDelayMs * 2 ** (attempt - 1), opts.maxDelayMs);
  return Math.floor(Math.random() * cap);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps a single Gemini API call with 429/RESOURCE_EXHAUSTED-aware retry.
 *
 * On a quota error: waits for Google's own `retryDelay` when present — the honest option,
 * since Google is telling you exactly how long the wall lasts — otherwise falls back to
 * exponential backoff with jitter. Retries up to `maxRetries` times total. On final failure,
 * throws `QuotaExceededError` wrapping the original error (message preserved) so callers can
 * distinguish "genuinely out of quota" from any other failure and surface it accordingly.
 */
export async function callWithBackoff<T>(fn: () => Promise<T>, opts: BackoffOptions = {}): Promise<T> {
  const merged = { ...DEFAULTS, ...opts };
  let lastError: unknown;

  for (let attempt = 0; attempt <= merged.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (isTokenLimitError(error)) throw new TokenLimitError(error);
      if (!isQuotaExceededError(error)) throw error;
      if (attempt === merged.maxRetries) break;

      const retryDelay = extractRetryDelayMs(error);
      const delayMs = retryDelay ?? backoffDelayMs(attempt + 1, merged);
      opts.onQuotaCooldown?.(delayMs, 429);
      const reason = retryDelay
        ? `quota exceeded — Google says retry in ${Math.ceil(retryDelay / 1000)}s`
        : `quota exceeded — backing off ${Math.ceil(delayMs / 1000)}s`;
      opts.onRetry?.(attempt + 1, delayMs, reason);
      if (typeof window !== 'undefined') {
        try {
          window.dispatchEvent(new CustomEvent('theta:retry-wait', { detail: { reason, delayMs, attempt: attempt + 1, projectId: (window as any).activeProject?.id || null } }));
        } catch {}
      }
      await sleep(delayMs);
    }
  }

  const message = (lastError as any)?.message ? String((lastError as any).message) : String(lastError);
  throw new QuotaExceededError(message, lastError);
}
