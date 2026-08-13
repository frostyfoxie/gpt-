import { GoogleGenAI } from '@google/genai';
import { callWithBackoff } from '../lib/rate-limit';
import { KeyManager } from '../config/keys';
import { ModelManager } from '../config/models';
import { ResearchMemory } from '../lib/web-research-memory';
import { getActiveProjectId } from '../engine/active-project';
import { getCurrentUserId } from '../lib/supabase/auth';

export type WebResearchMode = 'current-tech' | 'ui-ux' | 'deep';

export interface WebResearchRequest {
  query: string;
  mode?: WebResearchMode;
  urls?: string[];
  projectId?: string;
  maxSources?: number;
}

export interface WebResearchSource {
  title: string;
  uri: string;
  domain: string;
  reason?: string;
}

export interface WebResearchResult {
  ok: boolean;
  query: string;
  mode: WebResearchMode;
  summary: string;
  sources: WebResearchSource[];
  designPatterns?: Array<{
    pattern: string;
    evidence: string;
    applicability: string;
    novelty: 'low' | 'medium' | 'high';
  }>;
  technicalUpdates?: Array<{
    packageOrApi: string;
    currentState: string;
    compatibilityRisk: 'low' | 'medium' | 'high';
    recommendation: string;
  }>;
  palette?: string[];
  observedAt: string;
  error?: string;
}

const DEFAULT_MODEL = 'gemini-3.6-flash';
const MAX_URLS = 12;
const MAX_SOURCES = 12;
const SOURCE_CACHE_MS = 6 * 60 * 60 * 1000;
const MAX_SUMMARY_CHARS = 6000;
const MAX_PATTERN_COUNT = 8;
const MAX_PATTERN_CHARS = 900;
const MAX_TECH_UPDATE_COUNT = 8;
const MAX_TECH_CHARS = 900;
const CACHE_KEY = 'theta_web_research_v2';

interface CachedEntry {
  savedAt: number;
  result: WebResearchResult;
}

function domainOf(uri: string): string {
  try {
    return new URL(uri).hostname.replace(/^www\./, '');
  } catch {
    return uri;
  }
}

function loadCache(): Record<string, CachedEntry> {
  if (typeof window === 'undefined') return {};
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveCache(cache: Record<string, CachedEntry>): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Cache is opportunistic; research must still work without localStorage.
  }
}

async function cacheKey(request: WebResearchRequest): Promise<string> {
  const userId = await getCurrentUserId();
  return JSON.stringify({
    userId: userId ?? 'anonymous',
    projectId: request.projectId ?? null,
    q: request.query.trim().toLowerCase(),
    mode: request.mode ?? 'deep',
    urls: (request.urls ?? []).slice(0, MAX_URLS),
  });
}

function normalizeSources(metadata: any, maxSources: number): WebResearchSource[] {
  const chunks = metadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const out: WebResearchSource[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const web = chunk?.web;
    const uri = typeof web?.uri === 'string' ? web.uri : '';
    if (!uri || seen.has(uri)) continue;
    seen.add(uri);
    out.push({
      uri,
      title: typeof web?.title === 'string' ? web.title : uri,
      domain: domainOf(uri),
    });
    if (out.length >= maxSources) break;
  }
  return out;
}

function parseStructuredResult(text: string): Partial<WebResearchResult> {
  const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return { summary: cleaned };
    try {
      return JSON.parse(match[0]);
    } catch {
      return { summary: cleaned };
    }
  }
}

function buildPrompt(request: WebResearchRequest, priorContext = ''): string {
  const mode = request.mode ?? 'deep';
  const priorContextBlock = priorContext
    ? `\nPrior high-value patterns already known to this user/project. Treat them as hypotheses, not facts, and only reuse them when the current evidence supports them:\n${priorContext}\n`
    : '';

  if (mode === 'current-tech') {
    return [
      'You are Theta Workbench’s live technical-reference researcher.',
      `Investigate: ${request.query}`,
      '',
      'Rules:',
      '- Prefer official vendor documentation, changelogs, release notes, package registries, standards, and primary repositories.',
      '- Treat third-party tutorials as secondary evidence only.',
      '- Explicitly identify deprecated, renamed, removed, or version-sensitive APIs/syntax.',
      '- Never invent a current API from memory when live evidence can be found.',
      '- Return implementation advice grounded in the newest trustworthy sources.',
      '',
      'Return JSON only with:',
      '{"summary":"...","technicalUpdates":[{"packageOrApi":"...","currentState":"...","compatibilityRisk":"low|medium|high","recommendation":"..."}]}',
    ].join('\n');
  }

  const inspirationSources = [
    'Awwwards / CSS Design Awards / similar design-award galleries',
    'official product sites and engineering/design blogs',
    'public design systems and component libraries',
    'Pinterest or other inspiration collections only when publicly accessible and policy-compliant',
  ];

  return [
    'You are Theta Workbench’s adaptive UI/UX research agent.',
    `Study this design brief: ${request.query}`,
    '',
    `Preferred inspiration pools: ${inspirationSources.join('; ')}`,
    '',
    'Research rules:',
    '- Study multiple independent sources; do not blindly imitate one site.',
    '- Extract transferable patterns: layout systems, typography hierarchy, motion principles, interaction models, accessibility choices, navigation patterns, content density, component composition, and color relationships.',
    '- Separate evidence from your own synthesis.',
    '- Do not reproduce copyrighted text, exact logos, branded assets, or a page pixel-for-pixel.',
    '- Prefer novel combinations and explain why a pattern fits this project.',
    '- If a requested site is blocked or unavailable, use search-result snippets, official/public alternatives, or other reputable sources instead of inventing observations.',
    '',
    'Return JSON only with:',
    '{"summary":"...","designPatterns":[{"pattern":"...","evidence":"...","applicability":"...","novelty":"low|medium|high"}],"palette":["#..."],"technicalUpdates":[]}',
  ].join('\n');
}

async function runGroundedResearch(
  request: WebResearchRequest,
  apiKey: string,
  model: string
): Promise<WebResearchResult> {
  const mode = request.mode ?? 'deep';
  const priorContext = await ResearchMemory.getContext(request.projectId, 8);
  const urls = (request.urls ?? [])
    .filter((u) => /^https?:\/\//i.test(u))
    .slice(0, MAX_URLS);

  const tools: any[] = [{ googleSearch: {} }];
  if (urls.length > 0) tools.push({ urlContext: {} });

  const explicitUrls = urls.length
    ? `\nInspect these specific public URLs in addition to search: \n${urls.map((u) => `- ${u}`).join('\n')}\n`
    : '';

  const client = new GoogleGenAI({ apiKey });
  const response: any = await callWithBackoff<any>(
    () =>
      client.models.generateContent({
        model,
        contents: `${buildPrompt(request, priorContext)}${explicitUrls}`,
        config: { tools },
      }),
    { maxRetries: 2 }
  );

  const metadata = (response as any)?.candidates?.[0]?.groundingMetadata;
  const parsed = parseStructuredResult(String(response.text || ''));
  const sources = normalizeSources(metadata, Math.min(request.maxSources ?? MAX_SOURCES, MAX_SOURCES));
  const summary = typeof parsed.summary === 'string' ? parsed.summary : response.text || 'Research completed.';
  const designPatterns = Array.isArray(parsed.designPatterns)
    ? parsed.designPatterns.slice(0, MAX_PATTERN_COUNT).map((p: any) => ({
        pattern: String(p?.pattern ?? '').slice(0, MAX_PATTERN_CHARS),
        evidence: String(p?.evidence ?? '').slice(0, MAX_PATTERN_CHARS),
        applicability: String(p?.applicability ?? '').slice(0, MAX_PATTERN_CHARS),
        novelty: p?.novelty === 'high' || p?.novelty === 'medium' ? p.novelty : 'low',
      }))
    : undefined;
  const technicalUpdates = Array.isArray(parsed.technicalUpdates)
    ? parsed.technicalUpdates.slice(0, MAX_TECH_UPDATE_COUNT).map((t: any) => ({
        packageOrApi: String(t?.packageOrApi ?? '').slice(0, MAX_TECH_CHARS),
        currentState: String(t?.currentState ?? '').slice(0, MAX_TECH_CHARS),
        compatibilityRisk: t?.compatibilityRisk === 'high' || t?.compatibilityRisk === 'medium' ? t.compatibilityRisk : 'low',
        recommendation: String(t?.recommendation ?? '').slice(0, MAX_TECH_CHARS),
      }))
    : undefined;

  return {
    ok: true,
    query: request.query,
    mode,
    summary: summary.slice(0, MAX_SUMMARY_CHARS),
    sources,
    designPatterns,
    technicalUpdates,
    palette: Array.isArray(parsed.palette) ? parsed.palette.filter((c): c is string => typeof c === 'string').slice(0, 12) : undefined,
    observedAt: new Date().toISOString(),
  };
}

export class WebResearchTools {
  public static async research(request: WebResearchRequest): Promise<WebResearchResult> {
    const normalized: WebResearchRequest = {
      ...request,
      projectId: request.projectId ?? getActiveProjectId() ?? undefined,
      mode: request.mode ?? 'deep',
      query: request.query.trim(),
    };

    if (!normalized.query) {
      return {
        ok: false,
        query: '',
        mode: normalized.mode!,
        summary: '',
        sources: [],
        observedAt: new Date().toISOString(),
        error: 'research_web requires a non-empty query.',
      };
    }

    const key = await cacheKey(normalized);
    const cache = loadCache();
    const cached = cache[key];
    if (cached && Date.now() - cached.savedAt < SOURCE_CACHE_MS) {
      return { ...cached.result, summary: `${cached.result.summary}\n\n[Cached live research from ${cached.result.observedAt}]` };
    }

    // Grounded research depends on Gemini's native googleSearch/urlContext tools, which have
    // no OpenRouter equivalent (see unified-client.ts's module doc). So this always resolves
    // to a Gemini model/key regardless of what Chief's role model currently is — if Chief is
    // pointed at an OpenRouter model, deep mode falls back to DEFAULT_MODEL instead of trying
    // (and failing) to ground an OpenRouter call.
    const chiefModel = ModelManager.getModel('chief');
    const model =
      normalized.mode === 'deep' && ModelManager.getProvider(chiefModel) === 'gemini'
        ? chiefModel
        : DEFAULT_MODEL;

    let apiKey: string;
    try {
      apiKey = KeyManager.getAvailableKey('chief', model, 'gemini');
    } catch (error) {
      return {
        ok: false,
        query: normalized.query,
        mode: normalized.mode!,
        summary: '',
        sources: [],
        observedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    }

    try {
      const result = await runGroundedResearch(normalized, apiKey, model);
      cache[key] = { savedAt: Date.now(), result };
      saveCache(cache);
      void ResearchMemory.remember({
        projectId: normalized.projectId,
        query: normalized.query,
        mode: normalized.mode!,
        summary: result.summary,
        sources: result.sources,
        patterns: result.designPatterns,
        palette: result.palette,
      });
      if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('theta:web-research-complete', {
          detail: {
            projectId: normalized.projectId ?? null,
            query: normalized.query,
            mode: normalized.mode,
            sources: result.sources,
          },
        }));
      return result;
    } catch (error) {
      return {
        ok: false,
        query: normalized.query,
        mode: normalized.mode!,
        summary: '',
        sources: [],
        observedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      KeyManager.releaseKey(apiKey);
    }
  }
}
