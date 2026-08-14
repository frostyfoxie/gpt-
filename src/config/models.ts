import { KeyManager } from './keys';

export type ModelProvider = 'gemini' | 'openrouter';

export interface ModelOption {
  id: string;
  label: string;
  kind: 'text' | 'image';
  provider: ModelProvider;
  description: string;
}

export const AVAILABLE_MODELS: ModelOption[] = [
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', kind: 'text', provider: 'gemini', description: 'Strong fast general-purpose model.' },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', kind: 'text', provider: 'gemini', description: 'Fast general-purpose model.' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', kind: 'text', provider: 'gemini', description: 'Very fast lightweight model.' },
  { id: 'gemini-3.1-flash', label: 'Gemini 3.1 Flash', kind: 'text', provider: 'gemini', description: 'Low-latency model for lightweight tasks.' },
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', kind: 'text', provider: 'gemini', description: 'Strong reasoning model for difficult engineering work.' },
  { id: 'nvidia/nemotron-3-ultra', label: 'NVIDIA Nemotron 3 Ultra', kind: 'text', provider: 'openrouter', description: 'Strong reasoning model available through OpenRouter.' },
  { id: 'nvidia/nemotron-3-super', label: 'NVIDIA Nemotron 3 Super', kind: 'text', provider: 'openrouter', description: 'Strong general-purpose model available through OpenRouter.' },
  { id: 'qwen/qwen3-coder-480b-a35b', label: 'Qwen3 Coder 480B A35B', kind: 'text', provider: 'openrouter', description: 'Coding-focused model for repository work.' },
  { id: 'qwen/qwen3-next-80b-a3b', label: 'Qwen3 Next 80B A3B', kind: 'text', provider: 'openrouter', description: 'Fast general-purpose model.' },
  { id: 'cohere/north-mini-code', label: 'Cohere North Mini Code', kind: 'text', provider: 'openrouter', description: 'Fast coding model.' },
  { id: 'nvidia/nemotron-3-nano-omni', label: 'NVIDIA Nemotron 3 Nano Omni', kind: 'text', provider: 'openrouter', description: 'Fast multimodal model.' },
];

const STORAGE_PREFIX = 'theta_model_';
export type ModelAgentRole = 'chief' | 'miko' | 'critic';

// Miko is user-selectable. Chief is deliberately NOT user-selectable: execution routing
// chooses a model from the nature of the engineering task. Critic is reserved for verification.
const ROLE_DEFAULTS: Record<ModelAgentRole, string> = {
  chief: 'gemini-3.6-flash',
  miko: 'gemini-3.6-flash',
  critic: 'gemini-3.1-pro-preview',
};

/** Models Chief may choose for execution, ordered from fast/lightweight to strongest. */
export const CHIEF_EXECUTION_TIERS = [
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash',
  'gemini-3.5-flash',
  'gemini-3.6-flash',
  'gemini-3.1-pro-preview',
  'qwen/qwen3-coder-480b-a35b',
  'nvidia/nemotron-3-super',
  'nvidia/nemotron-3-ultra',
] as const;

export type ChiefTaskComplexity = 'quick' | 'normal' | 'complex' | 'critical';

export class ModelManager {
  /** Miko is user-selectable. */
  public static getModel(role: ModelAgentRole): string {
    const fallback = ROLE_DEFAULTS[role] ?? 'gemini-3.6-flash';
    if (typeof window === 'undefined') return fallback;
    const stored = localStorage.getItem(STORAGE_PREFIX + role);
    if (role === 'miko' && stored && AVAILABLE_MODELS.some((m) => m.id === stored && m.kind === 'text')) return stored;
    return fallback;
  }

  /**
   * Only Miko's chat model may be changed by the user. Chief's model is always resolved by
   * chooseChiefExecutionModel(), independent of the chat selector.
   */
  public static setModel(role: ModelAgentRole, modelId: string): void {
    if (role !== 'miko' || typeof window === 'undefined') return;
    if (!AVAILABLE_MODELS.some((m) => m.id === modelId && m.kind === 'text')) return;
    localStorage.setItem(STORAGE_PREFIX + role, modelId);
  }

  public static getOption(modelId: string): ModelOption | undefined {
    return AVAILABLE_MODELS.find((m) => m.id === modelId);
  }

  public static getProvider(modelId: string): ModelProvider {
    return AVAILABLE_MODELS.find((m) => m.id === modelId)?.provider ?? 'gemini';
  }

  public static isImageModel(modelId: string): boolean {
    return this.getOption(modelId)?.kind === 'image';
  }

  /**
   * Chief's execution router. This is intentionally independent of the user's Miko/chat
   * selection. It uses task language and explicit scope signals to choose the weakest model
   * that is still appropriate, while refusing to route complex work to the very weakest tier.
   * A later version can replace this deterministic classifier with a tiny routing model without
   * changing the Chief execution contract.
   */
  public static chooseChiefExecutionModel(task: string, complexity?: ChiefTaskComplexity): string {
    const text = task.toLowerCase();
    const level = complexity ?? this.inferChiefComplexity(text);

    if (level === 'quick') {
      return this.firstAvailable([
        'gemini-3.5-flash',
        'gemini-3.1-flash',
        'gemini-3.6-flash',
      ]);
    }

    if (level === 'normal') {
      return this.firstAvailable([
        'gemini-3.6-flash',
        'gemini-3.5-flash',
        'qwen/qwen3-coder-480b-a35b',
      ]);
    }

    if (level === 'critical') {
      return this.firstAvailable([
        'gemini-3.1-pro-preview',
        'nvidia/nemotron-3-ultra',
        'qwen/qwen3-coder-480b-a35b',
        'gemini-3.6-flash',
      ]);
    }

    return this.firstAvailable([
      'gemini-3.1-pro-preview',
      'qwen/qwen3-coder-480b-a35b',
      'nvidia/nemotron-3-super',
      'gemini-3.6-flash',
    ]);
  }

  private static inferChiefComplexity(text: string): ChiefTaskComplexity {
    const critical = /(security|migration|production|data loss|auth|authentication|authorization|database schema|payment|billing|deploy|release|incident|regression)/i.test(text);
    if (critical) return 'critical';

    const complex = /(architecture|refactor|rewrite|multi[- ]file|across the project|entire app|full[- ]stack|complex|debug|investigate|race condition|performance|concurrency|state management|routing|integration|api design)/i.test(text);
    if (complex) return 'complex';

    const quick = /(rename|typo|copy|text|label|small style|minor css|color|spacing|padding|margin|quick|simple|fix this line)/i.test(text);
    if (quick && text.length < 700) return 'quick';

    return 'normal';
  }

  private static firstAvailable(models: string[]): string {
    for (const model of models) {
      if (AVAILABLE_MODELS.some((m) => m.id === model)) return model;
    }
    return ROLE_DEFAULTS.chief;
  }

  /** Kept for callers that want cheapest-first routing without exposing that policy to users. */
  public static getCheapestAvailableModel(tiers: string[] = [...CHIEF_EXECUTION_TIERS]): string {
    for (const model of tiers) {
      if (KeyManager.getPoolRemainingBudget(model, this.getProvider(model)) > 0) return model;
    }
    return tiers[0] ?? ROLE_DEFAULTS.chief;
  }
}
