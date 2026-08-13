import { LLMClient } from '../lib/llm/unified-client';
import { callWithBackoff } from '../lib/rate-limit';
import { KeyManager } from '../config/keys';
import { ModelManager } from '../config/models';

export interface ReviewResult {
  approved: boolean;
  feedback: string;
}

/**
 * A strict, senior-engineer-style code review pass. Runs AFTER syntax checks pass and
 * BEFORE a dev agent's write is considered "done". This is what gives the pipeline real
 * debug/review teeth instead of "syntax parsed, ship it" — the same shape of
 * plan -> act -> verify -> reflect loop used by autonomous coding agents like Cline/AutoGen.
 *
 * Runs under its own 'critic' role (see ModelManager/KeyManager) rather than reusing
 * 'chief' — it defaults to a stronger, different model than whatever generated the code,
 * so the review is a genuinely different perspective instead of the same model checking
 * its own blind spots. There is no manual picker for it (or for Chief/Miko) — its model is
 * decided entirely by ModelManager's ROLE_DEFAULTS.
 */
export class CodeCritic {
  /** Prefer a model distinct from the writer when the available registry permits it. */
  private static pickIndependentModel(writerModel?: string): string {
    const critic = ModelManager.getModel('critic');
    if (!writerModel || critic !== writerModel) return critic;
    const candidates = ['gemini-3.1-pro-preview', 'gemini-3.6-flash', 'gemini-3.5-flash'];
    return candidates.find((id) => id !== writerModel) || critic;
  }


  /**
   * Phase 3: pulls from the shared key pool instead of a role-fixed key. Deliberately still a
   * distinct role ('critic') from 'chief' for logging/model-resolution purposes — it always
   * resolves to its own model via ModelManager.getModel('critic') below — but the actual key
   * comes from whichever pooled key has room, same as every other role now.
   */
  /**
   * Reviews a single file's proposed content against its task + acceptance criteria,
   * with awareness of the rest of the project for cross-file consistency.
   *
   * FAIL-CLOSED, not fail-open: a critic call that errors or returns unparseable JSON used
   * to be silently treated as `approved: true` ("proceeding on syntax check alone"), which
   * meant the ONE real quality gate in the write pipeline could be defeated by nothing more
   * than a flaky response — and syntax-valid-but-low-effort/incomplete code would ship
   * without ever actually being reviewed. It now retries once with an explicit repair
   * prompt, and if that also fails, returns `approved: false` with a message that makes the
   * dev agent's next turn retry the write rather than silently passing it through.
   */
  public static async review(
    targetFile: string,
    task: string,
    acceptanceCriteria: string[] | undefined,
    content: string,
    projectFiles: string[],
    writerModel?: string
  ): Promise<ReviewResult> {
    const criteriaBlock =
      acceptanceCriteria && acceptanceCriteria.length > 0
        ? acceptanceCriteria.map((c, i) => `${i + 1}. ${c}`).join('\n')
        : '(none specified — judge on correctness, completeness, and consistency with the rest of the project)';

    const prompt = `You are an independent skeptical code reviewer, NOT the author of this change. Your primary job is to find reasons this implementation should be rejected, not to confirm the author's reasoning.

You are reviewing a proposed change, the way a senior engineer reviews a pull request before merge.

Task assigned to the developer: "${task}"
Target file: ${targetFile}

Acceptance criteria:
${criteriaBlock}

Other files currently in the project (for cross-file consistency — do NOT flag references to files in this list as missing):
${projectFiles.length > 0 ? projectFiles.join('\n') : '(none — this is the first file)'}

Submitted file content:
\`\`\`
${content}
\`\`\`

Review strictly for:
- Correctness — does it actually do what the task asked?
- Completeness — no stubbed-out, placeholder, or TODO logic unless the task explicitly asked for a stub.
- Effort/depth — does this represent genuine, thorough work, or the bare minimum that technically satisfies the acceptance criteria while leaving obvious follow-on gaps (missing edge cases, no error handling where the task implies it, a half-implemented interaction)? A submission that games the literal wording of the criteria without matching their intent should be rejected.
- Obvious bugs — undefined references, mismatched brackets/tags the syntax checker might miss, logic errors.
- Consistency — references to ids, classes, functions, or files that should line up with the rest of the project.

Be firm but pragmatic: do not fail a submission over subjective style preferences alone. Do fail it for low-effort or corner-cutting work, even if it's technically syntactically valid.

Respond ONLY with strict JSON, nothing else outside it:
{"approved": true, "feedback": "<brief confirmation>"}
or
{"approved": false, "feedback": "<concise, specific, actionable list of what to fix>"}`;

    // Every concurrent review owns its own pooled key/client. Static shared state here
    // caused one review's finally block to release another review's key.
    const reviewModel = CodeCritic.pickIndependentModel(writerModel);
    const reviewProvider = ModelManager.getProvider(reviewModel);
    const currentKey = KeyManager.getAvailableKey('critic', reviewModel, reviewProvider);
    const ai = new LLMClient(currentKey, reviewProvider);

    const attempt = async (repairNote?: string): Promise<ReviewResult> => {
      const response = await callWithBackoff<any>(() =>
        ai.models.generateContent({
          model: reviewModel,
          contents: repairNote ? `${prompt}\n\n${repairNote}` : prompt,
        })
      );
      const raw = response.text || '';
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : raw);
      if (typeof parsed.approved !== 'boolean') {
        throw new Error('Response JSON was missing a boolean "approved" field.');
      }
      return {
        approved: parsed.approved,
        feedback: String(parsed.feedback || ''),
      };
    };

    try {
      try {
        return await attempt();
      } catch (firstErr: any) {
        // One repair attempt: the failure is very often a wrapped-in-prose or truncated
        // response rather than a genuine outage, so a single retry with an explicit
        // "JSON only" reminder recovers most of these cheaply before we fail closed.
        try {
          return await attempt(
            'Your previous response could not be parsed as the required JSON. Respond with ONLY the JSON object — no prose, no markdown fences, no commentary before or after it.'
          );
        } catch (secondErr: any) {
          return {
            approved: false,
            feedback:
              `Review could not be completed after two attempts (critic error: ${secondErr?.message || secondErr}). ` +
              `This is a critic-infrastructure failure, not a judgment on the code — retry the write so a real review can run before this is considered done.`,
          };
        }
      }
    } finally {
      // Release exactly the key acquired by THIS review.
      KeyManager.releaseKey(currentKey);
    }
  }
}
