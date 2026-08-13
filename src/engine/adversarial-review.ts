import { LLMClient } from '../lib/llm/unified-client';
import { callWithBackoff } from '../lib/rate-limit';
import { KeyManager } from '../config/keys';
import { ModelManager, AVAILABLE_MODELS } from '../config/models';

export interface AdversarialReviewResult {
  verdict: 'approve' | 'revise' | 'uncertain';
  confidence: number;
  strongestConcern: string;
  falsificationChecks: string[];
  reviewerModel: string;
  independentReviewer: boolean;
  failureClass?: 'none' | 'infra' | 'invalid-output';
}

function pickIndependentModel(writerModel: string): { model: string; independent: boolean } {
  const textModels = AVAILABLE_MODELS.filter((m) => m.kind === 'text').map((m) => m.id);
  const critic = ModelManager.getModel('critic');
  if (critic !== writerModel && textModels.includes(critic)) return { model: critic, independent: true };
  const alternate = textModels.find((id) => id !== writerModel && id !== ModelManager.getModel('chief'));
  if (alternate) return { model: alternate, independent: true };
  return { model: writerModel, independent: false };
}

/**
 * A deliberately adversarial second opinion. The reviewer is told to try to DISPROVE the
 * proposed change rather than summarize it. A missing/ambiguous review never counts as an
 * approval. This is the anti-self-confirmation layer for autonomous work.
 */
export async function adversarialReview(args: {
  writerModel: string;
  task: string;
  targetFile: string;
  content: string;
  acceptanceCriteria?: string[];
  scopeReason: string;
}): Promise<AdversarialReviewResult> {
  const reviewer = pickIndependentModel(args.writerModel);
  const model = reviewer.model;
  if (!reviewer.independent) {
    return {
      verdict: 'uncertain',
      confidence: 0,
      strongestConcern: 'No genuinely independent reviewer model is available; self-review was not counted as independent evidence.',
      falsificationChecks: ['Configure at least one reviewer model different from the writer model.'],
      reviewerModel: model,
      independentReviewer: false,
      failureClass: 'infra',
    };
  }
  const reviewProvider = ModelManager.getProvider(model);
  const key = KeyManager.getAvailableKey('critic', model, reviewProvider);
  const ai = new LLMClient(key, reviewProvider);
  const criteria = args.acceptanceCriteria?.length ? args.acceptanceCriteria.join('\n') : '(none specified)';

  const prompt = `You are an adversarial senior engineer reviewing code written by another model.\n\nYour job is NOT to praise it or restate the task. Try to DISPROVE that it is correct. Look for hidden assumptions, scope mistakes, regressions, misleading claims, overengineering, missing edge cases, and places where the implementation solves a larger problem than the user asked for.\n\nTask: ${args.task}\nTarget: ${args.targetFile}\nAcceptance criteria:\n${criteria}\nTask-scope rationale: ${args.scopeReason}\n\nCode:\n---\n${args.content}\n---\n\nBefore deciding, mentally attempt at least these falsification questions:\n1. What is the smallest user request, and did the code stay focused on it?\n2. What dependency or assumption could make this fail in the real project?\n3. What would a skeptical engineer test first?\n4. What evidence would prove this review wrong?\n\nReturn ONLY JSON:\n{"verdict":"approve|revise|uncertain","confidence":0-1,"strongestConcern":"...","falsificationChecks":["..."]}`;

  try {
    const response = await callWithBackoff<any>(() => ai.models.generateContent({ model, contents: prompt }));
    const raw = response.text || '';
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    const verdict = parsed.verdict === 'approve' || parsed.verdict === 'revise' || parsed.verdict === 'uncertain' ? parsed.verdict : 'uncertain';
    if (verdict === 'uncertain') {
      return {
        verdict,
        confidence: 0,
        strongestConcern: String(parsed.strongestConcern || 'Independent review was inconclusive.'),
        falsificationChecks: Array.isArray(parsed.falsificationChecks) ? parsed.falsificationChecks.map(String).slice(0, 6) : [],
        reviewerModel: model,
        independentReviewer: reviewer.independent,
        failureClass: 'invalid-output',
      };
    }
    return {
      verdict,
      confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
      strongestConcern: String(parsed.strongestConcern || 'Independent review returned no usable conclusion.'),
      falsificationChecks: Array.isArray(parsed.falsificationChecks) ? parsed.falsificationChecks.map(String).slice(0, 6) : [],
      reviewerModel: model,
      independentReviewer: reviewer.independent,
      failureClass: 'none',
    };
  } catch (err: any) {
    return {
      verdict: 'uncertain',
      confidence: 0,
      strongestConcern: `Independent review unavailable: ${err?.message || String(err)}`,
      falsificationChecks: ['Retry the independent review when the review service is available.'],
      reviewerModel: model,
      independentReviewer: reviewer.independent,
      failureClass: 'infra',
    };
  } finally {
    KeyManager.releaseKey(key);
  }
}
