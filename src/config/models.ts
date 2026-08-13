// Central registry of selectable text models (Gemini + OpenRouter) + per-agent model
// preference storage.
//
// Phase 6-A — smart routing: quick, low-risk chat edits (ChiefOrchestrator.executeQuickTasks,
// via ReActExecutionLoop's isQuickTask flag) auto-downgrade to whatever's cheapest with
// budget actually remaining right now (see QUICK_TASK_MODEL_TIERS / getCheapestAvailableModel
// below) instead of reaching for a fixed model regardless of quota state. 'gemini-3.1-pro-preview'
// is deliberately excluded from that tier list — it's reserved for the critic's final review
// pass (ROLE_DEFAULTS.critic) and, since Phase 6-A, for the dev1-3 escalation target too (see
// react-loop.ts DEV_1_TO_3_ESCALATED_MODEL), so a quick edit can never eat into the quota the
// review pass depends on.
//
// Phase 10 — OpenRouter models joined the registry alongside Gemini (see ModelProvider /
// `provider` below). There is deliberately NO user-facing model picker for Chief or Miko —
// role -> model assignment is decided entirely by the backend (ROLE_DEFAULTS + the escalation
// /quick-task tiers below), the same way it already was before OpenRouter existed. Adding
// OpenRouter models to AVAILABLE_MODELS makes them real, callable options for that backend
// routing (see src/lib/llm/unified-client.ts for how a call is actually dispatched to
// OpenRouter vs Gemini) without opening up manual per-user selection.
//
// Chief and Miko can each run a different model simultaneously. Of the four Dev agents,
// dev1/dev2/dev3 are hardcoded to 'gemini-3.5-flash' (see
// ReActExecutionLoop.DEV_1_TO_3_HARDCODED_MODEL in engine/react-loop.ts) regardless of
// what's selected here — they're the fast/cheap parallel workers, so pinning them keeps
// cost and latency predictable. (Previously pinned to 'gemini-3.5-flash-lite' — bumped one
// tier up because round-robin quick-task assignment could put a lite-tier model behind a
// single user-facing edit with no fallback.) dev4 is the exception and still inherits
// Chief's chosen text model (via ModelManager.getModel('chief')), so there's always one
// dev-agent lane running whatever "brain" Chief is currently using, and quick tasks now
// prefer dev4 first (see ChiefOrchestrator.executeQuickTasks) for exactly that reason.
// Critic is a separate role so the review pass can (and by default does) run a different
// model than whatever generated the code — see ROLE_DEFAULTS below.

import { KeyManager } from './keys';

export type ModelProvider = 'gemini' | 'openrouter';

export interface ModelOption {
  id: string;
  label: string;
  kind: 'text' | 'image';
  provider: ModelProvider;
  description: string;
}

// Model IDs current as of the Gemini 3.x line + the OpenRouter catalog (Aug 2026).
export const AVAILABLE_MODELS: ModelOption[] = [
  // ---- Gemini (native, via @google/genai + the user's Gemini key pool) ----
  {
    id: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    kind: 'text',
    provider: 'gemini',
    description: 'Default. Best balance of speed and quality for planning + coding.',
  },
  {
    id: 'gemini-3.5-flash',
    label: 'Gemini 3.5 Flash',
    kind: 'text',
    provider: 'gemini',
    description: 'Prior-gen flash model. Solid general fallback.',
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash Lite',
    kind: 'text',
    provider: 'gemini',
    description: 'Fastest & cheapest text model — best for quick chat, worse at deep reasoning.',
  },
  {
    id: 'gemini-3.1-flash',
    label: 'Gemini 3.1 Flash',
    kind: 'text',
    provider: 'gemini',
    description: 'Low-latency, cost-effective multimodal model optimized for high-frequency, lightweight tasks. Supports text, image, video, audio, and PDF inputs; designed for high-volume agentic workflows, simple data extraction, and applications where latency and API cost are the primary constraints.',
  },
  {
    // NOTE: 'gemini-3-pro-preview' (no ".1") was retired by Google on 2026-03-09 — it no
    // longer exists as a callable model. 'gemini-3.1-pro-preview' is its GA replacement and
    // is the only correct id here. Keep this comment if anyone's ever tempted to "fix" the
    // id back to gemini-3-pro-preview because the label below says "Gemini 3.1 Flash Pro
    // Preview" — the label is just a short display name, the id is what matters and must
    // keep the ".1".
    id: 'gemini-3.1-pro-preview',
    label: 'Gemini 3.1 Flash Pro Preview',
    kind: 'text',
    provider: 'gemini',
    description: 'Strongest Gemini reasoning, higher latency/cost. Default for code review, where catching what the author missed matters more than speed.',
  },

  // ---- OpenRouter (via src/lib/llm/unified-client.ts + the user's OpenRouter key pool) ----
  {
    id: 'nvidia/nemotron-3-ultra',
    label: 'NVIDIA Nemotron 3 Ultra',
    kind: 'text',
    provider: 'openrouter',
    description: "NVIDIA's largest Nemotron 3 tier — strongest reasoning of the OpenRouter lineup, higher latency/cost.",
  },
  {
    id: 'nvidia/nemotron-3-super',
    label: 'NVIDIA Nemotron 3 Super',
    kind: 'text',
    provider: 'openrouter',
    description: 'Mid-tier Nemotron 3 — strong general-purpose reasoning at a lower cost than Ultra.',
  },
  {
    id: 'qwen/qwen3-coder-480b-a35b',
    label: 'Qwen3 Coder 480B A35B',
    kind: 'text',
    provider: 'openrouter',
    description: "Qwen3's large MoE coding specialist (480B total / 35B active params) — tuned for agentic coding and long-context repo work.",
  },
  {
    id: 'qwen/qwen3-next-80b-a3b',
    label: 'Qwen3 Next 80B A3B',
    kind: 'text',
    provider: 'openrouter',
    description: "Qwen3's efficient next-gen MoE (80B total / 3B active params) — fast, cheap general-purpose text model.",
  },
  {
    id: 'cohere/north-mini-code',
    label: 'Cohere North Mini Code',
    kind: 'text',
    provider: 'openrouter',
    description: "Cohere's compact North model tuned for code — low latency, good for quick edits and small diffs.",
  },
  {
    id: 'nvidia/nemotron-3-nano-omni',
    label: 'NVIDIA Nemotron 3 Nano Omni',
    kind: 'text',
    provider: 'openrouter',
    description: 'Smallest/fastest Nemotron 3 tier with omni (multi-input) support — best for high-volume, low-complexity calls.',
  },
];

/**
 * Phase 6-A — cheapest-first routing tiers for quick, low-risk edits. Deliberately excludes
 * 'gemini-3.1-pro-preview': that model is reserved for the critic's final review pass (see
 * ROLE_DEFAULTS.critic below) and for the dev1-3 mid-task escalation target — never for a
 * quick task's normal (non-escalated) generation call. Ordered cheap -> strong so
 * getCheapestAvailableModel can walk it and stop at the first tier that still has pool
 * budget left. Gemini-only by design (see getProvider doc) so a quick edit's normal path
 * never depends on the user having configured an OpenRouter key.
 */
export const QUICK_TASK_MODEL_TIERS: string[] = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
];

/**
 * The one text model Phase 6-A's auto-downgrade routing will never select for a quick task's
 * generation call. Reserved for the critic role's final review pass (CodeCritic.review) and
 * used as the dev1-3 escalation target for non-quick (blueprint) subtasks only — see
 * react-loop.ts.
 */
export const CRITIC_RESERVED_MODEL = 'gemini-3.1-pro-preview';

const STORAGE_PREFIX = 'theta_model_';
export type ModelAgentRole = 'chief' | 'miko' | 'critic';

// Per-role default model, used whenever the user hasn't explicitly picked one for that
// role yet. Critic defaults to the strongest available text model rather than mirroring
// Chief/dev's default — the point of a separate critic role is a genuinely different
// model reviewing the code, not the same model checking its own work by default.
//
// There is no UI that lets a person override these per role (see the Phase 10 note at the
// top of this file) — ModelManager.getModel below only ever returns one of these defaults,
// so this table is, in practice, the single place that decides which model each role runs.
const ROLE_DEFAULTS: Record<ModelAgentRole, string> = {
  chief: 'gemini-3.5-flash',
  miko: 'gemini-3.5-flash-lite',
  critic: 'gemini-3.1-pro-preview',
};

export class ModelManager {
  /**
   * Resolves the model for a role. There is intentionally no way for a person to set this
   * per role (no model picker in the UI — see the Phase 10 note above); role -> model
   * assignment is fully backend-controlled via ROLE_DEFAULTS. `setModel` below still exists
   * (and getModel still checks storage first) purely so a *stale* override written by a
   * pre-Phase-10 build of Theta doesn't silently outlive the model it pointed at — if the
   * stored id no longer resolves to a real entry in AVAILABLE_MODELS, it's ignored and the
   * role default is used instead.
   */
  public static getModel(role: ModelAgentRole): string {
    const fallback = ROLE_DEFAULTS[role] ?? 'gemini-3.6-flash';
    if (typeof window === 'undefined') return fallback;
    const stored = localStorage.getItem(STORAGE_PREFIX + role);
    if (stored && AVAILABLE_MODELS.some((m) => m.id === stored)) return stored;
    return fallback;
  }

  /** Kept for back-compat / tooling; nothing in the UI calls this anymore (see getModel doc). */
  public static setModel(role: ModelAgentRole, modelId: string): void {
    if (typeof window === 'undefined') return;
    localStorage.setItem(STORAGE_PREFIX + role, modelId);
  }

  public static isImageModel(modelId: string): boolean {
    const found = AVAILABLE_MODELS.find((m) => m.id === modelId);
    return found?.kind === 'image';
  }

  public static getOption(modelId: string): ModelOption | undefined {
    return AVAILABLE_MODELS.find((m) => m.id === modelId);
  }

  /** Which provider a model id belongs to, for routing the actual API call and picking the
   *  right key pool (see KeyManager). Unknown ids (e.g. a legacy id no longer in the
   *  registry) default to 'gemini' — every id Theta has ever hardcoded outside this file
   *  (DEV_1_TO_3_HARDCODED_MODEL, DEV_1_TO_3_ESCALATED_MODEL, CRITIC_RESERVED_MODEL) is a
   *  Gemini id, so that's the safe default rather than guessing OpenRouter. */
  public static getProvider(modelId: string): ModelProvider {
    return AVAILABLE_MODELS.find((m) => m.id === modelId)?.provider ?? 'gemini';
  }

  /**
   * Phase 6-A — walks `tiers` (default QUICK_TASK_MODEL_TIERS, cheapest first) and returns
   * the first model that still has pool budget remaining right now, per
   * KeyManager.getPoolRemainingBudget. This is what lets a quick, low-risk edit genuinely
   * "auto-downgrade to the cheapest model with budget remaining" instead of always reaching
   * for the same fixed cheap model even once that model's own daily quota is gone while a
   * slightly pricier tier still has room.
   *
   * If every tier is in observed cooldown, this returns the cheapest tier anyway (index 0) rather than
   * quietly climbing into the critic-reserved model to dodge the exhausted quota — an
   * all-tiers-exhausted state should surface as a paused task via the normal per-turn budget
   * governor (ReActExecutionLoop.ensureBudgetForTurn), not a silent escalation that eats into
   * the review pass's dedicated budget.
   */
  public static getCheapestAvailableModel(tiers: string[] = QUICK_TASK_MODEL_TIERS): string {
    for (const model of tiers) {
      if (KeyManager.getPoolRemainingBudget(model, ModelManager.getProvider(model)) > 0) return model;
    }
    return tiers[0] ?? 'gemini-3.5-flash-lite';
  }
}
