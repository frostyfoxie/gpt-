import { LLMClient } from '../lib/llm/unified-client';
import { callWithBackoff, parseRetryDelayFromText, computeBackoffDelayMs } from '../lib/rate-limit';
import { KeyManager } from '../config/keys';
import { ModelManager } from '../config/models';
import { supabase } from '../lib/supabase/vfs-sync';
import { logReActStep } from '../lib/supabase/logger';
import { ReActExecutionLoop } from './react-loop';
import { CommitManager } from './commits';
import { getActiveCommitManager } from './active-project';
import { CheckpointEngine } from '../lib/git/checkpoint';
import { FileSystemTools } from '../tools/file-system-tools';
import { CodeRunnerTools } from '../tools/code-runner-tools';
import { AgentToolLoop } from './agent-loop';
import { CrossAgentSynthesizer } from './synthesis';
import { isExecutorConfigured } from '../lib/executor/executor-client';
import { deriveTaskScope, formatTaskScope } from './task-scope';

const DEV_AGENTS: Array<'dev1' | 'dev2' | 'dev3' | 'dev4'> = ['dev1', 'dev2', 'dev3', 'dev4'];

export interface StepBlueprint {
  stepId: number;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  /**
   * Short shared interface agreement for this step's parallel subtasks — function
   * signatures, prop shapes, API endpoints/payloads, etc. Optional: only meaningful
   * when 2+ subtasks in the step actually need to agree on a shape ahead of time
   * (e.g. a component file and the file that consumes it, or a frontend file and the
   * API route it calls). Injected verbatim into every dev agent's prompt for the step
   * so parallel agents build to the same agreed shape instead of finding out they
   * disagree at the post-step integration check.
   */
  contract?: string;
  /**
   * True only for a step generated internally by runCrossAgentSynthesis to fix issues a
   * synthesis pass found in an earlier step. Prevents synthesis from recursing into its own
   * fix steps — a fix step's subtasks already went through the same individual
   * write/syntax/review pipeline as any other subtask, and the pass budget in
   * runCrossAgentSynthesis already bounds how many times a single ORIGINAL step gets
   * re-reviewed. Without this flag, a step needing 2 fix passes could in principle recurse
   * indefinitely (fix step -> its own synthesis -> its own fix step -> ...).
   */
  isSynthesisFix?: boolean;
  subtasks: {
    id: string;
    assignee: 'dev1' | 'dev2' | 'dev3' | 'dev4';
    task: string;
    targetFile: string;
    acceptanceCriteria?: string[];
    /** Live UI-only execution state; persisted only as harmless metadata when present. */
    runtimeStatus?: 'waiting' | 'working' | 'completed' | 'failed' | 'retrying';
    runtimeSummary?: string;
  }[];
}

export interface QuickTask {
  targetFile: string;
  instruction: string;
  acceptanceCriteria?: string[];
}

export interface QuickTaskResult {
  file: string;
  success: boolean;
  /** The real reason for success/failure — the ReAct loop's last observation (or finish summary), not a generic wrapper message. Surfaced directly in the Chief chat reply. */
  summary: string;
  /** True if this result is from an automatic retry (autopilot mode only) after the first attempt failed. */
  retried?: boolean;
}

export type ClassificationResult =
  | { mode: 'discussion'; reply: string }
  | { mode: 'blueprint_proposal'; reply: string }
  | { mode: 'code_task'; tasks: QuickTask[] };

export class ChiefOrchestrator {
  private ai: LLMClient | null = null;
  private isAutopilot: boolean = false;
  private isCancelled: boolean = false;

  constructor(isAutopilot: boolean = false) {
    this.isAutopilot = isAutopilot;
  }

  /**
   * Phase 3: pulls from the shared key pool instead of a fixed 'chief' key. A ChiefOrchestrator
   * instance is short-lived (created per chat turn — see chief-chat-adapter.ts) but can make
   * several calls across one turn (discuss/classify/blueprint/executeStep/etc.), all on the
   * same 'chief' model, so caching one acquired key for the instance's lifetime is fine —
   * unlike ReActExecutionLoop, there's no mid-instance model change to react to here.
   */
  private getClient(): LLMClient {
    if (!this.ai) {
      const model = ModelManager.getModel('chief');
      const provider = ModelManager.getProvider(model);
      const chiefKey = KeyManager.getAvailableKey('chief', model, provider);
      this.ai = new LLMClient(chiefKey, provider);
    }
    return this.ai;
  }

  /**
   * Chief interacts with user in conversational format, asking max 2-3 concise questions.
   */
  public async discussWithUser(userPrompt: string): Promise<string> {
    const prompt = `You are the Chief AI Software Architect leading an autonomous suite of 4 developer agents.
User prompt: "${userPrompt}"

Instructions:
1. Speak professionally, concisely, and helpfully.
2. Ask at most 2-3 necessary clarifying questions. Do NOT over-interrogate or complicate things.
3. If sufficient details exist, respond with your intended plan overview.`;

    const response = await callWithBackoff<any>(() =>
      this.getClient().models.generateContent({
        model: ModelManager.getModel('chief'),
        contents: prompt,
      })
    );

    return response.text || 'I have analyzed your request. Ready to build the project blueprint.';
  }

  /**
   * Generates structured step blueprint JSON from user project requirements.
   */
  public async generateBlueprint(projectSummary: string): Promise<StepBlueprint[]> {
    const prompt = `You are the Chief AI Software Architect planning a real project build for a live coding workspace, the way an autonomous coding agent (Cline, AutoGen, Claude Code) would: break the work into a complete, dependency-ordered sequence from scaffolding through to a finished, working, tested project — not just one or two steps.

Project: "${projectSummary}"

Reason about the user's actual goal before expanding the plan. The project may contain many subsystems that are not relevant to this request. For example, a UI polish request should primarily inspect the rendered surface, styling, components and direct data/interaction dependencies — not read every backend file. Expand scope only when a concrete dependency, contract, failing check or user requirement proves it necessary.

Task scope baseline:
${formatTaskScope(deriveTaskScope(projectSummary, 'project'))}

Guidelines:
- Cover the lifecycle the request actually requires. Do NOT manufacture backend/database/infrastructure steps for a UI-only request.
- Use as many steps as the project genuinely needs (typically 2-8) — don't compress genuinely dependent work into one step, but don't add steps merely for ceremony.
- Each step should have 1-4 subtasks that can run in PARALLEL (different target files, no subtask should depend on another subtask completing within the same step — sequence dependent work into separate steps instead).
- Give every subtask 2-4 concrete, testable "acceptanceCriteria" — specific enough that a reviewer could check them against the finished file.
- Assign subtasks round-robin across dev1, dev2, dev3, dev4.
- targetFile must be a concrete file path (e.g. "index.html", "src/app.js", "src/styles.css").
- Whenever a step has 2+ parallel subtasks whose files need to agree on a shape to work together (a component and the file that renders it, a frontend call and the API route it hits, a shared type/model used by multiple files, etc.), also include a short "contract" string on that step: concrete function signatures, prop/type shapes, or endpoint request/response payloads — just enough that every subtask can be written against the same agreed interface instead of guessing and reconciling later. Keep it short (a few lines/snippets, not prose). Omit "contract" entirely for steps where the subtasks are genuinely independent (e.g. unrelated static files) and there's nothing to agree on.

Return ONLY a strict JSON array matching this exact interface, no commentary outside it:
[
  {
    "stepId": 1,
    "title": "Setup HTML layout and base stylesheet",
    "status": "pending",
    "subtasks": [
      {
        "id": "1A",
        "assignee": "dev1",
        "task": "Write index.html base layout",
        "targetFile": "index.html",
        "acceptanceCriteria": ["Valid HTML5 doctype and structure", "Links styles.css and app.js", "Semantic landmarks (header/main/footer)"]
      },
      {
        "id": "1B",
        "assignee": "dev2",
        "task": "Write styles.css base theme",
        "targetFile": "styles.css",
        "acceptanceCriteria": ["Defines base color palette and typography", "Responsive layout for mobile and desktop"]
      }
    ]
  },
  {
    "stepId": 2,
    "title": "Wire task list UI to the tasks API",
    "status": "pending",
    "contract": "interface Task { id: string; title: string; done: boolean; }\nGET /api/tasks -> Task[]\nPOST /api/tasks { title: string } -> Task",
    "subtasks": [
      {
        "id": "2A",
        "assignee": "dev1",
        "task": "Build TaskList component that fetches and renders tasks",
        "targetFile": "src/components/TaskList.js",
        "acceptanceCriteria": ["Fetches GET /api/tasks on mount", "Renders each Task's title and done state"]
      },
      {
        "id": "2B",
        "assignee": "dev2",
        "task": "Implement the /api/tasks route handlers",
        "targetFile": "src/api/tasks.js",
        "acceptanceCriteria": ["GET returns Task[] matching the contract", "POST accepts { title } and returns the created Task"]
      }
    ]
  }
]`;

    const response = await callWithBackoff<any>(() =>
      this.getClient().models.generateContent({
        model: ModelManager.getModel('chief'),
        contents: prompt,
      })
    );

    try {
      const rawText = response.text || '';
      const match = rawText.match(/\[[\s\S]*\]/);
      const cleanJson = match ? match[0] : rawText;
      return JSON.parse(cleanJson) as StepBlueprint[];
    } catch {
      // Fallback structured blueprint if JSON parsing fails
      return [
        {
          stepId: 1,
          title: 'Initial Core Setup',
          status: 'pending',
          subtasks: [
            { id: '1A', assignee: 'dev1', task: 'Create base index.html', targetFile: 'index.html' },
            { id: '1B', assignee: 'dev2', task: 'Create base styles.css', targetFile: 'styles.css' },
          ],
        },
      ];
    }
  }

  /**
   * Creates a shadow checkpoint before starting a blueprint step.
   */
  public async createCheckpoint(stepId: number): Promise<boolean> {
    const ok = await CheckpointEngine.createCheckpoint(stepId);
    if (!ok) {
      console.warn(`[ChiefOrchestrator] Checkpoint failed for Step ${stepId}. Execution will not continue without a rollback point.`);
      return false;
    }
    return true;
  }

  /**
   * Executes a step across parallel Dev agents.
   */
  public async executeStep(step: StepBlueprint): Promise<boolean> {
    if (this.isCancelled) return false;

    // 1. Create Pre-step Checkpoint. Never execute a step without a rollback point.
    const checkpointOk = await this.createCheckpoint(step.stepId);
    if (!checkpointOk) return false;

    // 2. Dispatch Subtasks to Dev Agents in Parallel — every subtask in the step gets the
    // same shared contract (if the blueprint generated one), so agents working on different
    // files agree on the interface between them before they start, instead of only finding
    // out they disagree at the post-step integration check.
    const dispatchSubtask = async (subtask: StepBlueprint['subtasks'][number]) => {
      subtask.runtimeStatus = 'working';
      subtask.runtimeSummary = 'Agent dispatched — working on the assigned file.';
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('theta:subtask-status', { detail: {
          stepId: step.stepId, subtaskId: subtask.id, agentId: subtask.assignee,
          status: 'working', summary: subtask.runtimeSummary,
        }}));
      }
      const runner = new ReActExecutionLoop(subtask.assignee, 3);
      // Blueprint subtasks must keep the full quality gate (critic + adversarial review) —
      // skipCritic is a quick-task-only optimization (see executeTask's doc and
      // executeQuickTasks below). Do not pass true here.
      const result = await runner.executeTask(
        step.stepId, subtask.id, subtask.task, subtask.targetFile,
        subtask.acceptanceCriteria, step.contract
      );
      subtask.runtimeStatus = result.success ? 'completed' : 'failed';
      subtask.runtimeSummary = result.summary || (result.success ? 'Agent completed its task.' : 'Agent failed its task.');
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('theta:subtask-status', { detail: {
          stepId: step.stepId, subtaskId: subtask.id, agentId: subtask.assignee,
          status: subtask.runtimeStatus, summary: subtask.runtimeSummary,
        }}));
      }
      return result;
    };

    const subtaskPromises = step.subtasks.map(dispatchSubtask);
    let results = await Promise.all(subtaskPromises);
    // One focused retry for failed subtasks. ReAct already escalates model strength after an
    // internal failure; this outer retry gives a subtask one fresh context without turning a
    // flaky task into an unbounded quota sink.
    if (results.some((res) => !res.success) && !this.isCancelled) {
      const failedSubtasks = step.subtasks.filter((_, index) => !results[index]?.success);
      const retryResults = await Promise.all(failedSubtasks.map(async (subtask) => {
        subtask.runtimeStatus = 'retrying';
        subtask.runtimeSummary = 'Retrying after the first attempt failed.';
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('theta:subtask-status', { detail: {
            stepId: step.stepId, subtaskId: subtask.id, agentId: subtask.assignee,
            status: 'retrying', summary: subtask.runtimeSummary,
          }}));
        }
        // Must not be lower than the first attempt's turn budget (3, above) — giving the
        // retry FEWER turns than the attempt that already failed just reproduces the same
        // "Reached the N-turn limit without a verified finish" failure, only faster. Match
        // the first attempt's budget so a fresh context actually gets a fair shot.
        const runner = new ReActExecutionLoop(subtask.assignee, 3);
        // Same as the first attempt above — blueprint retries must not skip the quality gate.
        const result = await runner.executeTask(
          step.stepId, subtask.id, `${subtask.task}\nRetry this subtask from the current workspace state after the previous attempt failed.`,
          subtask.targetFile, subtask.acceptanceCriteria, step.contract
        );
        subtask.runtimeStatus = result.success ? 'completed' : 'failed';
        subtask.runtimeSummary = result.summary || (result.success ? 'Retry succeeded.' : 'Retry failed.');
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('theta:subtask-status', { detail: {
            stepId: step.stepId, subtaskId: subtask.id, agentId: subtask.assignee,
            status: subtask.runtimeStatus, summary: subtask.runtimeSummary,
          }}));
        }
        return result;
      }));
      const byId = new Map(failedSubtasks.map((s, i) => [s.id, retryResults[i]]));
      results = results.map((result, index) => result.success ? result : (byId.get(step.subtasks[index].id) || result));
    }
    let stepSuccess = results.every((res) => res.success);

    // Expensive real-project verification is a STEP gate, not a per-write gate. This keeps
    // parallel dev agents responsive while still ensuring the entire step is grounded in a
    // real compiler/test/browser run before it can complete.
    if (stepSuccess) {
      const strict = await CodeRunnerTools.runStrictCheck(FileSystemTools.listAllFilesWithContent(), { stepId: step.stepId, agentId: 'chief' });
      if (!strict.ranInSandbox && strict.error) {
        await logReActStep({ stepId: step.stepId, agentId: 'chief', thought: `Real executor unavailable during Step ${step.stepId}: ${strict.error}. Continuing with local/syntax/integration gates; a real executor will be retried at final QA.`, action: 'run_tests', status: 'skipped' });
      } else if (strict.ranInSandbox && !strict.success) {
        stepSuccess = false;
        await logReActStep({ stepId: step.stepId, agentId: 'chief', thought: `Step-level verification failed after parallel dev work: ${strict.error}`, action: 'run_tests', status: 'failed' });
      } else if (strict.ranInSandbox) {
        const browser = await CodeRunnerTools.runBehaviorCheck(FileSystemTools.listAllFilesWithContent(), step.subtasks.flatMap((s) => s.acceptanceCriteria || []), { stepId: step.stepId, agentId: 'chief' });
        if (browser.ranInSandbox && !browser.success) {
          stepSuccess = false;
          await logReActStep({ stepId: step.stepId, agentId: 'chief', thought: `Step-level browser verification failed: ${browser.error}`, action: 'run_behavior_check', status: 'failed' });
        }
      }
    }

    // 3. Cross-agent synthesis: every subtask above already individually passed its own
    // write -> syntax -> review pipeline, but that's each dev agent judged in isolation. A
    // step with 2+ parallel subtasks needs one more pass that looks at ALL of this step's
    // files TOGETHER — see synthesis.ts for exactly what that catches that per-file review
    // structurally can't. Skipped for single-subtask steps (nothing to cross-check) and for
    // steps that are themselves a synthesis fix (see StepBlueprint.isSynthesisFix).
    if (stepSuccess && step.subtasks.length > 1 && !step.isSynthesisFix) {
      stepSuccess = await this.runCrossAgentSynthesis(step);
    }

    if (stepSuccess) {
      await logReActStep({
        stepId: step.stepId,
        agentId: 'chief',
        thought: `Step ${step.stepId} completed successfully across all assigned dev agents.`,
        action: 'complete_step',
        status: 'success',
      });

      // Automatic commit after every successful step so there's always a restore point,
      // in addition to whatever manual commits the user makes.
      try {
        const commitManager = getActiveCommitManager();
        if (!commitManager) throw new Error('No active project commit manager.');
        await commitManager.createCommit(`Auto-commit: Step ${step.stepId} — ${step.title}`, 'auto');
      } catch (err) {
        await logReActStep({ stepId: step.stepId, agentId: 'chief', thought: `Step completed but auto-commit failed: ${err instanceof Error ? err.message : String(err)}`, action: 'create_commit', status: 'failed' });
        console.warn('[ChiefOrchestrator] Auto-commit failed:', err);
      }
    }

    return stepSuccess;
  }

  /** Bounded number of review -> fix rounds for one step's cross-agent synthesis (see runCrossAgentSynthesis). Genuine cross-file issues should shrink or resolve within a pass or two once each fix is told exactly what the other file expects; if they haven't converged by then, that's surfaced as a real step failure rather than looping indefinitely. */
  private static readonly MAX_SYNTHESIS_PASSES = 1;

  /**
   * Runs CrossAgentSynthesizer against a just-completed multi-subtask step and, if it finds
   * real integration issues, dispatches a fix step for exactly those issues (round-robin
   * across dev agents, same shape as the QA-fix step finalizeProject already uses) and
   * re-reviews. Returns false only if genuine cross-file issues remain unresolved after
   * MAX_SYNTHESIS_PASSES, or if a fix step itself fails to write — NOT if the synthesis
   * model itself is unavailable (see the catch below).
   */
  private async runCrossAgentSynthesis(step: StepBlueprint): Promise<boolean> {
    for (let pass = 1; pass <= ChiefOrchestrator.MAX_SYNTHESIS_PASSES; pass++) {
      if (this.isCancelled) return false;

      let result;
      try {
        result = await CrossAgentSynthesizer.reviewStep(step);
      } catch (err: any) {
        // Infra outage in the synthesis model itself, not a judgment about the code — every
        // file in this step already passed its own independent syntax + review gate, so
        // proceed rather than blocking the step indefinitely on a second-opinion pass that
        // simply couldn't run. This is explicit and logged, unlike the old per-file critic
        // bug that silently discarded a real (negative) review verdict on parse failure.
        await logReActStep({
          stepId: step.stepId,
          agentId: 'chief',
          thought: `Cross-agent synthesis unavailable on pass ${pass} for Step ${step.stepId}: ${err?.message || err}. Proceeding without it — every file already passed its own independent review.`,
          action: 'check_syntax',
          status: 'failed',
        });
        return true;
      }

      if (result.coherent || result.issues.length === 0) {
        await logReActStep({
          stepId: step.stepId,
          agentId: 'chief',
          thought: `Cross-agent synthesis pass ${pass} for Step ${step.stepId}: parallel outputs verified to work together. ${result.notes}`,
          action: 'check_syntax',
          status: 'success',
        });
        return true;
      }

      await logReActStep({
        stepId: step.stepId,
        agentId: 'chief',
        thought: `Cross-agent synthesis pass ${pass} for Step ${step.stepId} found ${result.issues.length} integration issue(s) across the parallel outputs: ${result.notes}. Dispatching fixes.`,
        action: 'check_syntax',
        status: 'failed',
      });

      const fixStep: StepBlueprint = {
        // Distinct from step.stepId on purpose: CheckpointEngine.createCheckpoint upserts by
        // step_id, so reusing the parent step's id here would overwrite ITS checkpoint with
        // a snapshot taken after the parent's own writes already happened — silently
        // breaking "cancel and roll back to before Step N" for the parent step. Same
        // derivation style as the QA-fix steps in finalizeProject (9000 + iteration), scoped
        // per-parent-step here so multiple steps' synthesis fixes can't collide with each
        // other either.
        stepId: step.stepId * 1000 + pass,
        title: `Cross-agent synthesis fixes for Step ${step.stepId} (pass ${pass})`,
        status: 'pending',
        contract: step.contract,
        isSynthesisFix: true,
        subtasks: result.issues.map((issue, i) => ({
          id: `SYN${step.stepId}-${pass}-${i + 1}`,
          assignee: DEV_AGENTS[i % DEV_AGENTS.length],
          task: issue.instruction,
          targetFile: issue.targetFile,
          acceptanceCriteria: issue.acceptanceCriteria,
        })),
      };

      // Reuses executeStep so each fix goes through the same checkpoint + write/syntax/
      // review pipeline as any other subtask (isSynthesisFix just stops it from recursing
      // into ANOTHER synthesis pass on top of this one).
      const fixesOk = await this.executeStep(fixStep);
      if (!fixesOk) {
        await logReActStep({
          stepId: step.stepId,
          agentId: 'chief',
          thought: `Cross-agent synthesis fix pass ${pass} for Step ${step.stepId} failed to write one or more fixes.`,
          action: 'complete_step',
          status: 'failed',
        });
        return false;
      }

      // Loop again: re-review the step's files now that fixes were applied, in case a fix
      // to one file introduced a new mismatch with another, or issues remain.
    }

    await logReActStep({
      stepId: step.stepId,
      agentId: 'chief',
      thought: `Cross-agent synthesis for Step ${step.stepId} still found integration issues after ${ChiefOrchestrator.MAX_SYNTHESIS_PASSES} fix pass(es) — treating the step as failed rather than shipping files that don't actually work together.`,
      action: 'complete_step',
      status: 'failed',
    });
    return false;
  }

  /**
   * Reads the user's latest chat message (plus conversation so far and the real, current
   * project file listing) and decides whether it's ordinary discussion/planning or a
   * concrete, actionable code request. This is what connects Chief's chat tab directly to
   * the editor: a message like "fix the bug where the modal doesn't close" no longer just
   * gets talked about — it gets classified as a code_task and routed to executeQuickTasks,
   * which actually writes it in the live workspace.
   */
  public async classifyAndPlan(userQuery: string, conversationContext: string): Promise<ClassificationResult> {
    const projectFiles = FileSystemTools.listAllFiles();

    const prompt = `You are the Chief AI Software Architect for a live coding workspace with a real code editor, file tree, and Supabase-backed storage. You lead 4 developer agents who can write directly to files in this workspace.

Conversation so far (most recent message is what you're responding to now):
${conversationContext}

Current project files:
${projectFiles.length > 0 ? projectFiles.join('\n') : '(empty project)'}

Decide how to handle the user's LATEST message:
- "discussion": ordinary discussion, questions, clarification, or a request that is not ready for implementation. Ask only the minimum useful questions; the user is not expected to be a seasoned coder.
- "code_task": the user explicitly wants a small, targeted change that can safely be completed in 1-3 files without a shared multi-step architecture. Respond with a tasks array.
- "blueprint_proposal": the user has described a genuinely multi-step, architectural, cross-file, or substantial build request AND there is now enough information to propose a sensible implementation plan. Do NOT execute anything and do NOT create the sticky blueprint yet. Instead, write a concise human-readable proposed plan directly as Chief's chat reply, with numbered steps and a final sentence asking the user to confirm whether you should draft it. Avoid jargon and unnecessary questions.

IMPORTANT: Do not ask the user to click a Generate Blueprint button. Chief decides when the conversation has enough information. If important information is missing, use discussion instead and ask at most 1-2 high-value questions.

Respond ONLY with strict JSON matching exactly one of these shapes, nothing else outside it:
{"mode": "discussion", "reply": "..."}
{"mode": "blueprint_proposal", "reply": "..."}
{"mode": "code_task", "tasks": [{"targetFile": "path/to/file.ext", "instruction": "specific instruction", "acceptanceCriteria": ["...", "..."]}]}`;

    const response = await callWithBackoff<any>(() =>
      this.getClient().models.generateContent({
        model: ModelManager.getModel('chief'),
        contents: prompt,
      })
    );

    const raw = response.text || '';
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : raw);
      if (parsed.mode === 'blueprint_proposal' && typeof parsed.reply === 'string' && parsed.reply.trim()) {
        return { mode: 'blueprint_proposal', reply: parsed.reply };
      }
      if (parsed.mode === 'code_task' && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
        const tasks: QuickTask[] = parsed.tasks
          .filter((t: any) => t && t.targetFile && t.instruction)
          .map((t: any) => ({
            targetFile: String(t.targetFile),
            instruction: String(t.instruction),
            acceptanceCriteria: Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria.map(String) : undefined,
          }));
        if (tasks.length > 0) return { mode: 'code_task', tasks };
      }
      return { mode: 'discussion', reply: parsed.reply || raw || "I've noted that — tell me more about what you'd like me to build or change." };
    } catch {
      // If the model didn't return parseable JSON, fall back to treating it as a plain
      // conversational reply rather than silently dropping the response.
      return { mode: 'discussion', reply: raw || "I've noted that — tell me more about what you'd like me to build or change." };
    }
  }

  /**
   * Executes one or more ad-hoc file edits requested directly in chat — dispatched to the
   * dev agents in parallel (round-robin), each going through the full write -> syntax check
   * -> review loop, exactly like a blueprint step, but without requiring the user to first
   * generate/approve a full blueprint. A checkpoint is taken first and an auto-commit is
   * made on success, so every conversational edit is still fully revertible.
   *
   * Quick tasks get a slightly larger turn budget than a blueprint subtask
   * (QUICK_TASK_MAX_TURNS vs. ReActExecutionLoop's own 5-turn default): unlike a blueprint
   * step, a quick task has no pre-agreed contract and often targets a file that already
   * exists (sometimes a large one), so a bit more room to look around and, if needed, retry
   * a failed edit_file patch as a full rewrite is worth the extra model calls here.
   *
   * Bumped 8 -> 14: a single quick task on a large, existing file (the common case — an
   * animation/perf tweak on one big landing page, a precise timing fix, etc.) routinely
   * needs read -> patch attempt -> failed-patch fallback -> full rewrite -> review-feedback
   * fix -> re-verify, and every failed write/verify burns a whole turn with no partial
   * credit. 8 was tight enough that a single review rejection or one failed patch could
   * exhaust the whole budget before a second real attempt.
   *
   * Lowered 14 -> 6: this project has no paid fallback, so request count is the actual
   * scarce resource, not developer patience. The old 14-turn reasoning above was largely
   * driven by the critic review call costing a full extra retry-worthy turn on every write
   * failure — quick tasks now run with `skipCritic: true` (see the executeTask call below
   * and ReActExecutionLoop.performVerifiedWrite), so a normal single-file quick task
   * converges in explore(optional) -> write -> finish, well under 6. 6 still leaves room for
   * one failed-write retry-with-fix inside the same task before falling back to the
   * (now-gated, see below) autopilot cross-task retry.
   */
  private static readonly QUICK_TASK_MAX_TURNS = 6;

  /**
   * Fallback floor for the autopilot auto-retry wait when the first attempt's failure
   * wasn't a quota error with an explicit Google-supplied retryDelay (see the retry block
   * below) — used as the minimum for computeBackoffDelayMs's jittered exponential backoff.
   * When Google DOES tell us exactly how long the wall lasts (a QuotaExceededError's message
   * embeds the original retryDelay), the retry waits that exact amount instead of this flat
   * floor — Google's own number is more honest than a guess.
   */
  private static readonly AUTOPILOT_RETRY_MIN_DELAY_MS = 5000;

  public async executeQuickTasks(tasks: QuickTask[]): Promise<QuickTaskResult[]> {
    // Timestamp-based id keeps quick-task step ids from ever colliding with the small
    // sequential integers a generated blueprint uses.
    const quickStepId = Date.now();
    await this.createCheckpoint(quickStepId);

    // Quick tasks are user-initiated, real-time precision edits (unlike a blueprint's bulk
    // cheap fan-out across many small subtasks). Rotating the round-robin start point to
    // dev4 (rather than dev1) still matters for the single-task case — it spreads load
    // across all four lanes instead of always landing on the same one — but which MODEL
    // each lane actually calls is no longer "whichever lane you land on decides": as of
    // Phase 6-A, every lane routes through ReActExecutionLoop's isQuickTask flag below,
    // which auto-downgrades to the cheapest model with budget remaining (see
    // ModelManager.getCheapestAvailableModel) instead of dev4 mirroring Chief's possibly
    // expensive/reserved model selection. See resolveModelForAgent in react-loop.ts for the
    // exact routing this now goes through.
    const quickTaskAgentOrder: Array<'dev1' | 'dev2' | 'dev3' | 'dev4'> = [
      'dev4',
      ...DEV_AGENTS.filter((id) => id !== 'dev4'),
    ];

    const results = await Promise.all(
      tasks.map(async (task, i) => {
        const runner = new ReActExecutionLoop(
          quickTaskAgentOrder[i % quickTaskAgentOrder.length],
          ChiefOrchestrator.QUICK_TASK_MAX_TURNS,
          /* isQuickTask */ true
        );
        const outcome = await runner.executeTask(
          quickStepId,
          `Q${i + 1}`,
          task.instruction,
          task.targetFile,
          task.acceptanceCriteria,
          undefined,
          /* skipCritic */ true
        );
        if (outcome.success) {
          return { file: task.targetFile, success: true, summary: outcome.summary };
        }

        // Autopilot mode is supposed to mean "handle it without asking me" — previously a
        // failed quick task always ended with a canned "you can ask me to try again" chat
        // reply, in BOTH manual and autopilot mode, because this loop never looked at
        // isAutopilot at all. In autopilot, retry once automatically: same agent, same
        // file, but with the first attempt's real failure reason appended so the retry
        // isn't just a blind repeat of whatever just failed.
        //
        // No paid fallback here, so a retry firing immediately after a failure is exactly
        // how a single 429 turns into a second full-budget attempt against a quota that's
        // already exhausted — the second attempt was never going to succeed either. As of
        // Phase 2: check the request-budget governor and skip the retry outright if it's
        // already exhausted (below), and otherwise wait for the real Google-supplied
        // retryDelay when the failure was a quota error (falling back to jittered
        // exponential backoff otherwise), surfaced as a visible toast rather than a silent
        // immediate re-fire.
        if (!this.isAutopilot || this.isCancelled) {
          return { file: task.targetFile, success: false, summary: outcome.summary };
        }

        // Phase 3: don't fire the retry at all if the pool has no request budget left for the
        // model the retry would use — a retry from an already-exhausted pool was never going
        // to succeed, it would just spend more of the day's remaining calls confirming that.
        // Budget is a pool-wide question now, not a per-lane one: a retry is only truly
        // pointless if EVERY key in the pool is out of quota for that model.
        const retryAgent = quickTaskAgentOrder[i % quickTaskAgentOrder.length];
        const retryModel = ReActExecutionLoop.resolveModelForAgent(retryAgent, false, /* isQuickTask */ true);
        if (KeyManager.getPoolRemainingBudget(retryModel, ModelManager.getProvider(retryModel)) <= 0) {
          if (typeof window !== 'undefined' && typeof (window as any).showToast === 'function') {
            (window as any).showToast(
              `Skipping autopilot retry on "${task.targetFile}" — today's request budget for ${retryModel} is exhausted across every key in your pool.`,
              'error'
            );
          }
          await logReActStep({
            stepId: quickStepId,
            subtaskId: `Q${i + 1}-retry`,
            agentId: retryAgent,
            thought: `Autopilot retry skipped: request budget for ${retryModel} is exhausted across every pooled key.`,
            action: 'complete_step',
            status: 'failed',
          });
          return {
            file: task.targetFile,
            success: false,
            summary:
              `${outcome.summary}\n\nAutopilot retry skipped: today's request budget for ${retryModel} is exhausted ` +
              `across every key in your pool — another attempt would just hit the same quota wall. Try again once it resets, or add another key in settings.`,
          };
        }

        // Wait however long the first failure actually calls for: if it was a quota error,
        // Google's own retryDelay (echoed into QuotaExceededError's message by callWithBackoff)
        // tells us exactly how long the wall lasts, so honor that precisely rather than
        // guessing. Otherwise fall back to the same jittered exponential backoff
        // callWithBackoff itself uses internally, floored at AUTOPILOT_RETRY_MIN_DELAY_MS so a
        // non-quota failure (a rejected write, a failed test) still gets a brief pause before
        // autopilot spends another call on the same file.
        const explicitDelay = parseRetryDelayFromText(outcome.summary);
        const delayMs = explicitDelay ?? Math.max(ChiefOrchestrator.AUTOPILOT_RETRY_MIN_DELAY_MS, computeBackoffDelayMs(1));

        if (typeof window !== 'undefined' && typeof (window as any).showToast === 'function') {
          (window as any).showToast(
            `First attempt on "${task.targetFile}" failed — waiting ${Math.ceil(delayMs / 1000)}s before retrying (autopilot)...`,
            'info'
          );
        }
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (this.isCancelled) {
          return { file: task.targetFile, success: false, summary: outcome.summary };
        }

        const retryRunner = new ReActExecutionLoop(
          retryAgent,
          ChiefOrchestrator.QUICK_TASK_MAX_TURNS,
          /* isQuickTask */ true
        );
        if (typeof window !== 'undefined' && typeof (window as any).showToast === 'function') {
          // Real-time signal that something is happening between the initial "Chief is
          // editing..." toast and the (possibly much later) chat reply — otherwise the only
          // visible thing during a multi-turn retry is the chat bubble's typing dots, which
          // gives no indication whether Chief is still working or has silently stalled.
          (window as any).showToast(`Retrying "${task.targetFile}" now (autopilot)...`, 'info');
        }
        const retryInstruction =
          `${task.instruction}\n\nAutopilot auto-retry: a first attempt at this already failed with — ` +
          `${outcome.summary}\nFix that specific problem this time; don't repeat the same mistake.`;
        const retryOutcome = await retryRunner.executeTask(
          quickStepId,
          `Q${i + 1}-retry`,
          retryInstruction,
          task.targetFile,
          task.acceptanceCriteria,
          undefined,
          /* skipCritic */ true
        );
        return {
          file: task.targetFile,
          success: retryOutcome.success,
          summary: retryOutcome.summary,
          retried: true,
        };
      })
    );

    const allOk = results.every((r) => r.success);
    await logReActStep({
      stepId: quickStepId,
      agentId: 'chief',
      thought: `Quick task batch ${allOk ? 'completed successfully' : 'completed with failures'} across ${tasks.length} file(s).`,
      action: 'complete_step',
      status: allOk ? 'success' : 'failed',
    });

    if (allOk) {
      try {
        const commitManager = getActiveCommitManager();
        if (!commitManager) throw new Error('No active project commit manager.');
        await commitManager.createCommit(`Auto-commit: ${tasks.map((t) => t.targetFile).join(', ')}`, 'auto');
      } catch (err) {
        console.warn('[ChiefOrchestrator] Auto-commit failed for quick task batch:', err);
      }
    }

    return results;
  }

  /**
   * Whole-project final QA pass, run once a blueprint's steps have all completed. Mirrors
   * how autonomous coding agents (Cline, AutoGen, Claude Code) finish a build: step back,
   * look at the ENTIRE project against the original goal (not just the last step), run
   * automated syntax + integration checks across every file, and if anything is missing,
   * broken, or incomplete, auto-generate and execute a corrective step — repeating up to
   * maxIterations times so the project actually converges instead of stopping the moment
   * the last individual step's checks passed.
   */
  public async finalizeProject(projectGoal: string, maxIterations: number = 2): Promise<void> {
    // Step 0: if the A real execution environment is available, run a real, iterative tool-call debugging pass
    // FIRST (list files -> run real tests -> read/fix failing files -> re-run -> ...) so the
    // text-only QA pass below is reasoning about a project that's already known to actually
    // compile/run, not just one that looks plausible on paper.
    if (isExecutorConfigured() && !this.isCancelled) {
      await logReActStep({
        stepId: 0,
        agentId: 'chief',
        thought: 'A real execution environment is available — running an iterative strict-debugging pass (real compile/test runs) before the final QA review.',
        action: 'check_syntax',
        status: 'executing',
      });
      const debugLoop = new AgentToolLoop('chief', 0, 8);
      const result = await debugLoop.run(
        `Make sure the entire project for "${projectGoal}" actually compiles and passes its tests. ` +
        `Use run_tests to check the real, current state first. If it fails, read the failing file(s), ` +
        `fix them with write_file, and run_tests again. Only call finish once run_tests has PASSED, ` +
        `or if there's genuinely nothing testable/compilable in this project.`
      );
      await logReActStep({
        stepId: 0,
        agentId: 'chief',
        thought: `Strict debugging pass ${result.finished ? 'converged' : 'hit its turn limit'}: ${result.summary}`,
        action: 'complete_step',
        status: result.finished ? 'success' : 'failed',
      });
    }

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      if (this.isCancelled) return;

      const files = FileSystemTools.listAllFilesWithContent();
      const integration = CodeRunnerTools.runIntegrationChecks(files);

      const syntaxIssues: string[] = [];
      for (const f of files) {
        const result = await CodeRunnerTools.checkSyntax(f.path, f.content);
        if (!result.success) syntaxIssues.push(`${f.path}: ${result.error}`);
      }

      const fileListing = files.map((f) => f.path).join('\n');
      const prompt = `You are the Chief AI Software Architect performing a FINAL whole-project QA pass before delivery — the way a senior engineer does a last review pass before merging to main.

Original project goal / conversation:
${projectGoal}

Files currently in the project:
${fileListing || '(empty project)'}

Automated checks already run:
${integration.success ? '- Integration/reference checks: PASSED' : `- Integration/reference issues found:\n${integration.error}`}
${syntaxIssues.length === 0 ? '- Syntax checks: PASSED for every file' : `- Syntax issues found:\n${syntaxIssues.join('\n')}`}

Considering the goal and the current files, identify anything still missing, broken, incomplete, or inconsistent (unfinished features, placeholder/TODO code left in, files referenced but never created, obvious bugs). Ignore purely stylistic nitpicks — this is a functional review.

Respond ONLY with strict JSON, nothing else outside it:
{"complete": true}
or
{"complete": false, "issues": [{"targetFile": "path", "instruction": "specific fix instruction", "acceptanceCriteria": ["...", "..."]}]}`;

      const response = await callWithBackoff<any>(() =>
        this.getClient().models.generateContent({
          model: ModelManager.getModel('chief'),
          contents: prompt,
        })
      );

      let parsed: any;
      try {
        const raw = response.text || '';
        const match = raw.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(match ? match[0] : raw);
      } catch {
        parsed = { complete: true };
      }

      if (parsed.complete || !Array.isArray(parsed.issues) || parsed.issues.length === 0) {
        await logReActStep({
          stepId: 0,
          agentId: 'chief',
          thought: `Final project review passed on pass ${iteration}/${maxIterations}. No further issues detected.`,
          action: 'complete_step',
          status: 'success',
        });
        return;
      }

      await logReActStep({
        stepId: 0,
        agentId: 'chief',
        thought: `Final review pass ${iteration}/${maxIterations} found ${parsed.issues.length} issue(s). Dispatching a QA fix step.`,
        action: 'check_syntax',
        status: 'failed',
      });

      const qaStep: StepBlueprint = {
        stepId: 9000 + iteration,
        title: `Final QA Fixes (pass ${iteration})`,
        status: 'pending',
        subtasks: parsed.issues.map((issue: any, i: number) => ({
          id: `QA${iteration}-${i + 1}`,
          assignee: DEV_AGENTS[i % DEV_AGENTS.length],
          task: String(issue.instruction || `Fix issues in ${issue.targetFile}`),
          targetFile: String(issue.targetFile),
          acceptanceCriteria: Array.isArray(issue.acceptanceCriteria) ? issue.acceptanceCriteria.map(String) : undefined,
        })),
      };

      await this.executeStep(qaStep);
    }

    await logReActStep({
      stepId: 0,
      agentId: 'chief',
      thought: `Final review reached the maximum of ${maxIterations} QA passes. Any remaining issues may need a manual follow-up request.`,
      action: 'complete_step',
      status: 'failed',
    });
  }

  public setAutopilot(isAutopilot: boolean): void {
    this.isAutopilot = isAutopilot;
  }

  public getAutopilot(): boolean {
    return this.isAutopilot;
  }

  public resetCancellation(): void {
    this.isCancelled = false;
  }

  /**
   * Cancels execution and performs full rollback to pre-step snapshot.
   */
  public async cancelAndRollback(stepId: number): Promise<void> {
    this.isCancelled = true;

    try {
      // Delegates to CheckpointEngine, which reconstructs the tree by replaying diffs
      // forward from the nearest snapshot anchor (see fetchTreeAtSeq), then handles the
      // window.rootProject / renderFileTree / open-tabs / autosave wiring itself.
      await CheckpointEngine.restoreCheckpoint(stepId);
    } catch (err) {
      console.warn('[ChiefOrchestrator] Rollback failed (Supabase unavailable?):', err);
    }
  }
}
