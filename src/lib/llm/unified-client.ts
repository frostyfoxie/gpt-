import { GoogleGenAI, Type } from '@google/genai';
import type { ModelProvider } from '../../config/models';

/**
 * Phase 10 — provider-agnostic model client.
 *
 * Every engine/ui-adapter call site used to do `new GoogleGenAI({ apiKey })` and then
 * `ai.models.generateContent({ model, contents, config })` directly. That call shape is
 * narrow across this whole codebase — a plain string prompt almost everywhere, with exactly
 * two call sites (agent-loop.ts, react-loop.ts) additionally passing a single
 * `config.tools[0].functionDeclarations` array of native tool definitions. LLMClient
 * reproduces that exact `.models.generateContent(...)` surface so call sites only need to
 * swap their constructor (`new GoogleGenAI({apiKey})` -> `new LLMClient(apiKey, provider)`)
 * and pass whichever provider the selected model belongs to
 * (ModelManager.getProvider(model)) — nothing else about the call site changes.
 *
 * Gemini calls are simply delegated to the real @google/genai SDK client, unchanged.
 * OpenRouter calls go through generateWithOpenRouter below, which speaks OpenRouter's
 * OpenAI-compatible /chat/completions endpoint and translates:
 *   - `contents` (a plain string prompt in every call site that reaches OpenRouter) -> a
 *     single user message.
 *   - Gemini-shaped `functionDeclarations` (Type.OBJECT/STRING/...) -> OpenAI JSON-schema
 *     `tools`.
 *   - the OpenAI-style response (`choices[0].message`) back into the same
 *     `{ text, functionCalls }` shape GoogleGenAI's response exposes, so callers never need
 *     to branch on provider once they have an LLMClient.
 *
 * Gemini-only features some call sites use — native `googleSearch`/`urlContext` grounding
 * (web-research-tools.ts) and image-output config (miko-chat-adapter.ts's Nano-Banana-style
 * image generation) — have no OpenRouter equivalent wired up here. Callers that need those
 * stay on the 'gemini' provider explicitly rather than routing through whatever the role's
 * model happens to resolve to; see the comments at each such call site.
 */

export interface UnifiedFunctionCall {
  name: string;
  args: Record<string, any>;
}

export interface UnifiedGenerateResponse {
  text: string;
  functionCalls?: UnifiedFunctionCall[];
  /** Present only for Gemini responses that used grounding/image tools; OpenRouter responses never set this. */
  candidates?: any[];
}

export interface UnifiedGenerateParams {
  model: string;
  contents: string;
  config?: {
    tools?: Array<{ functionDeclarations?: any[]; googleSearch?: {}; urlContext?: {} }>;
    systemInstruction?: string;
    responseModalities?: string[];
    imageConfig?: Record<string, any>;
    [key: string]: any;
  };
}

/** Thrown for any non-2xx OpenRouter response. Mirrors the `.status`/`.code` shape
 *  src/lib/rate-limit.ts already knows how to detect (429 -> quota/backoff handling), so no
 *  changes were needed there to support OpenRouter errors. */
export class OpenRouterError extends Error {
  public readonly status: number;
  public readonly code: number;

  constructor(status: number, body: string) {
    super(`OpenRouter request failed (${status}): ${body}`);
    this.name = 'OpenRouterError';
    this.status = status;
    this.code = status;
  }
}

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** Gemini's `Type` enum values -> lowercase JSON-schema `type` strings OpenAI-compatible tool calling expects. */
function geminiTypeToJsonSchemaType(t: any): string {
  const key = String(t ?? '').toUpperCase();
  switch (key) {
    case 'OBJECT':
      return 'object';
    case 'STRING':
      return 'string';
    case 'NUMBER':
      return 'number';
    case 'INTEGER':
      return 'integer';
    case 'BOOLEAN':
      return 'boolean';
    case 'ARRAY':
      return 'array';
    default:
      return 'string';
  }
}

/** Recursively converts a Gemini-shaped parameter schema (Type.OBJECT/STRING/...) into a
 *  plain JSON Schema object, since OpenRouter's tool calling is OpenAI-compatible. */
function convertGeminiSchemaToJsonSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return { type: 'string' };
  const out: any = { type: geminiTypeToJsonSchemaType(schema.type) };
  if (schema.description) out.description = schema.description;
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [key, value] of Object.entries(schema.properties)) {
      out.properties[key] = convertGeminiSchemaToJsonSchema(value);
    }
  }
  if (Array.isArray(schema.required)) out.required = schema.required;
  if (schema.items) out.items = convertGeminiSchemaToJsonSchema(schema.items);
  return out;
}

function buildOpenRouterTools(config?: UnifiedGenerateParams['config']): any[] | undefined {
  const decl = config?.tools?.find((t) => Array.isArray(t.functionDeclarations))?.functionDeclarations;
  if (!decl || decl.length === 0) return undefined;
  return decl.map((fn: any) => ({
    type: 'function',
    function: {
      name: fn.name,
      description: fn.description ?? '',
      parameters: convertGeminiSchemaToJsonSchema(fn.parameters ?? { type: Type.OBJECT, properties: {} }),
    },
  }));
}

async function generateWithOpenRouter(apiKey: string, params: UnifiedGenerateParams): Promise<UnifiedGenerateResponse> {
  const messages: Array<{ role: string; content: string }> = [];
  if (params.config?.systemInstruction) {
    messages.push({ role: 'system', content: params.config.systemInstruction });
  }
  messages.push({ role: 'user', content: params.contents });

  const tools = buildOpenRouterTools(params.config);

  const body: Record<string, any> = {
    model: params.model,
    messages,
  };
  if (tools) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const res = await fetch(OPENROUTER_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      // OpenRouter uses these purely for its own analytics/leaderboards — harmless to send,
      // and recommended by their docs so requests aren't attributed as anonymous.
      'HTTP-Referer': 'https://theta.workbench',
      'X-Title': 'Theta Workbench',
    },
    body: JSON.stringify(body),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new OpenRouterError(res.status, raw);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OpenRouterError(res.status, `Non-JSON response: ${raw.slice(0, 200)}`);
  }

  const message = parsed?.choices?.[0]?.message ?? {};
  const text = typeof message.content === 'string' ? message.content : '';
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  const functionCalls: UnifiedFunctionCall[] = toolCalls
    .filter((tc: any) => tc?.type === 'function' && tc.function?.name)
    .map((tc: any) => {
      let args: Record<string, any> = {};
      try {
        args = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        args = {};
      }
      return { name: tc.function.name, args };
    });

  return { text, functionCalls: functionCalls.length > 0 ? functionCalls : undefined };
}

/**
 * Drop-in replacement for `new GoogleGenAI({ apiKey })` at every call site in this codebase.
 * `provider` decides whether `.models.generateContent(...)` is delegated to the real Gemini
 * SDK or routed to OpenRouter — see the module doc above.
 */
export class LLMClient {
  private readonly apiKey: string;
  private readonly provider: ModelProvider;
  private genai: GoogleGenAI | null = null;

  constructor(apiKey: string, provider: ModelProvider = 'gemini') {
    this.apiKey = apiKey;
    this.provider = provider;
  }

  public readonly models = {
    generateContent: (params: UnifiedGenerateParams): Promise<UnifiedGenerateResponse> => this.generateContent(params),
  };

  private async generateContent(params: UnifiedGenerateParams): Promise<UnifiedGenerateResponse> {
    if (this.provider === 'gemini') {
      if (!this.genai) this.genai = new GoogleGenAI({ apiKey: this.apiKey });
      return this.genai.models.generateContent(params as any) as unknown as Promise<UnifiedGenerateResponse>;
    }
    return generateWithOpenRouter(this.apiKey, params);
  }
}
