import { LLMClient } from '../lib/llm/unified-client';
import { callWithBackoff } from '../lib/rate-limit';
import { KeyManager } from '../config/keys';
import { ModelManager } from '../config/models';
import { FileSystemTools } from '../tools/file-system-tools';
import type { StepBlueprint } from './orchestrator';

export interface SynthesisIssue {
  targetFile: string;
  instruction: string;
  acceptanceCriteria?: string[];
}

export interface SynthesisResult {
  coherent: boolean;
  issues: SynthesisIssue[];
  notes: string;
}

/**
 * Truncation cap per file in the synthesis prompt — same rationale as
 * ReActExecutionLoop.MAX_REFERENCED_FILE_CHARS, just named separately here since this class
 * has no dependency on react-loop.ts: enough for a real cross-file read without blowing up
 * prompt size across every file in a step at once.
 */
const MAX_FILE_CHARS_IN_PROMPT = 6000;

/**
 * The gap the per-file CodeCritic review structurally cannot cover: in ReActExecutionLoop,
 * dev1-4 each review and verify their OWN file in isolation (performVerifiedWrite runs
 * CodeCritic.review scoped to a single targetFile). A step with several parallel subtasks can
 * have every file individually pass that gate while the files still don't actually work
 * TOGETHER — a component calling an API shape the API file doesn't provide, two files each
 * independently satisfying a shared contract on paper but drifting from each other in
 * practice, a file that's fine on its own but nothing else ever wires it in.
 *
 * This runs ONCE per multi-subtask step, after every individual subtask has already passed
 * its own write -> syntax -> review -> (real test/behavior check) pipeline, and looks at the
 * step's files together — the way a senior engineer reviews a multi-file pull request as a
 * whole rather than approving each file's diff in isolation. It is intentionally a SEPARATE
 * pass from CodeCritic rather than a parameter added to it: CodeCritic's contract is "judge
 * one file against its own task," and conflating that with "judge N files against each other"
 * would make both prompts worse at their actual job.
 */
export class CrossAgentSynthesizer {
  private static ai: LLMClient | null = null;
  /** The pooled key currently backing `ai` — released once the reviewStep() call it was acquired for finishes. */
  private static currentKey: string | null = null;

  /**
   * Phase 3: pulls from the shared key pool instead of a role-fixed key. Same role as the
   * per-file critic — a genuinely different, strong model doing the judging, not the same
   * model(s) that wrote the code checking their own combined work — via ModelManager's
   * 'critic' model default; the key itself now comes from whichever pooled key has room.
   */
  private static getClient(): LLMClient {
    if (!this.ai) {
      const model = ModelManager.getModel('critic');
      const provider = ModelManager.getProvider(model);
      const key = KeyManager.getAvailableKey('critic', model, provider);
      this.currentKey = key;
      this.ai = new LLMClient(key, provider);
    }
    return this.ai;
  }

  public static async reviewStep(step: StepBlueprint): Promise<SynthesisResult> {
    // De-dupe: a step can (rarely) have two subtasks targeting the same file.
    const distinctPaths = Array.from(new Set(step.subtasks.map((s) => s.targetFile)));
    const fileBlocks = await Promise.all(
      distinctPaths.map(async (path) => {
        const read = await FileSystemTools.readFile(path);
        let content = read.success ? read.output : '(could not read this file)';
        if (content.length > MAX_FILE_CHARS_IN_PROMPT) {
          content = content.slice(0, MAX_FILE_CHARS_IN_PROMPT) + '\n... [truncated for prompt size]';
        }
        return `--- ${path} ---\n${content}`;
      })
    );

    const subtaskBlock = step.subtasks
      .map(
        (s) =>
          `[${s.id}] assignee: ${s.assignee}, file: ${s.targetFile}\n  task: ${s.task}${
            s.acceptanceCriteria && s.acceptanceCriteria.length > 0
              ? `\n  acceptance criteria: ${s.acceptanceCriteria.join(' | ')}`
              : ''
          }`
      )
      .join('\n');

    const contractBlock = step.contract
      ? `\nShared interface contract every subtask below was told to build against:\n${step.contract}\n`
      : '';

    const prompt = `You are the Chief Software Architect doing a cross-file integration review — the way a senior engineer reviews a multi-file pull request as a WHOLE, not one file at a time.

${step.subtasks.length} developer agents worked IN PARALLEL, each on their own file, for this step:

Step: "${step.title}"
${contractBlock}
Subtasks:
${subtaskBlock}

Every file below has ALREADY individually passed its own syntax check and its own isolated code review — this pass is specifically about whether they actually work TOGETHER, which no single-file review can catch:
${fileBlocks.join('\n\n')}

Check specifically for:
- Interface mismatches — does one file call/import/reference something another file doesn't actually provide in that exact shape (wrong function signature, wrong prop names, wrong endpoint path or payload shape)?
- Contradictions — do two files disagree about the same piece of state, data shape, or behavior?
- Gaps between files — something one file assumes another handles, that neither actually does.
- Orphaned work — a file that's individually fine but never gets wired into anything else (e.g. a component nothing renders, an endpoint nothing calls), when the step's intent implies it should be connected.
- Duplication — the same logic/state implemented independently in two files where it should be shared.

Do NOT re-flag purely single-file issues (bugs contained entirely within one file with no cross-file angle) — those already went through per-file review. Focus only on issues that span or arise from the combination of these files.

Respond ONLY with strict JSON, nothing else outside it:
{"coherent": true, "notes": "<brief confirmation these files work together>"}
or
{"coherent": false, "notes": "<brief summary of the integration problem(s)>", "issues": [{"targetFile": "path (must be one of the files above)", "instruction": "specific fix instruction referencing the OTHER file(s) it needs to match", "acceptanceCriteria": ["...", "..."]}]}`;

    const attempt = async (repairNote?: string): Promise<SynthesisResult> => {
      const response = await callWithBackoff<any>(() =>
        this.getClient().models.generateContent({
          model: ModelManager.getModel('critic'),
          contents: repairNote ? `${prompt}\n\n${repairNote}` : prompt,
        })
      );
      const raw = response.text || '';
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : raw);
      if (typeof parsed.coherent !== 'boolean') {
        throw new Error('Response JSON was missing a boolean "coherent" field.');
      }
      const issues: SynthesisIssue[] = Array.isArray(parsed.issues)
        ? parsed.issues
            .filter((i: any) => i && i.targetFile && i.instruction)
            .map((i: any) => ({
              targetFile: String(i.targetFile),
              instruction: String(i.instruction),
              acceptanceCriteria: Array.isArray(i.acceptanceCriteria) ? i.acceptanceCriteria.map(String) : undefined,
            }))
        : [];
      return { coherent: parsed.coherent, issues, notes: String(parsed.notes || '') };
    };

    try {
      try {
        return await attempt();
      } catch (firstErr: any) {
        // One repair attempt, same pattern as CodeCritic — recovers most "wrapped in prose"
        // or truncated responses cheaply before this is treated as a real failure.
        try {
          return await attempt(
            'Your previous response could not be parsed as the required JSON. Respond with ONLY the JSON object — no prose, no markdown fences, no commentary before or after it.'
          );
        } catch (secondErr: any) {
          // Unlike the per-file critic (the sole quality gate on a write), this is an
          // ADDITIONAL pass on top of files that already independently passed review — so an
          // infra failure here THROWS rather than this class silently deciding to approve or
          // block. The caller (ChiefOrchestrator) decides explicitly how to treat a synthesis
          // outage and logs it, instead of that decision happening implicitly in here.
          throw new Error(`Cross-agent synthesis unavailable: ${secondErr?.message || secondErr}`);
        }
      }
    } finally {
      // Release the pooled key this pass claimed and drop the cached client so the NEXT
      // reviewStep() call re-acquires from the pool rather than pinning this static class to
      // whichever key it happened to get first.
      if (this.currentKey) {
        KeyManager.releaseKey(this.currentKey);
        this.currentKey = null;
      }
      this.ai = null;
    }
  }
}
