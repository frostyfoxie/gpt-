import { Type } from '@google/genai';
import { LLMClient } from '../lib/llm/unified-client';
import { callWithBackoff } from '../lib/rate-limit';
import { RequestBudget } from '../lib/request-budget';
import { KeyManager } from '../config/keys';
import { ModelManager } from '../config/models';
import { logReActStep } from '../lib/supabase/logger';
import { acquireFileLock, releaseFileLock, isFileLocked } from './state-lock';
import { ToolDispatcher } from '../tools/index';
import { FileSystemTools } from '../tools/file-system-tools';
import { CodeCritic } from './critic';
import { CodeRunnerTools } from '../tools/code-runner-tools';
import { applySearchReplacePatch, SEARCH_REPLACE_FORMAT_INSTRUCTIONS } from '../lib/diff';
import { recordExecutionTruth } from './execution-truth';
import { getActiveProjectId } from './active-project';
import { deriveTaskScope, formatTaskScope } from './task-scope';
import { adversarialReview } from './adversarial-review';

export type DevAgentTool =
  | 'list_files'
  | 'read_file'
  | 'grep'
  | 'glob'
  | 'write_file'
  | 'edit_file'
  | 'check_syntax'
  | 'review'
  | 'run_tests'
  | 'run_behavior_check'
  | 'run_command'
  | 'research_web'
  | 'finish';

interface LoopTurnRecord {
  turn: number;
  thought: string;
  tool: DevAgentTool;
  input: string;
  observation: string;
}

/**
 * Phase 9: a real multi-turn tool loop, not a single-file generate-and-retry cycle.
 *
 * Previously this class generated one file's complete content per attempt (up to a fixed
 * attempt cap), running a hardcoded post-write pipeline (syntax check -> critic review ->
 * strict check -> behavior check) after every generation. That worked, but it meant a dev
 * agent could only ever touch the one `targetFile` it was assigned at blueprint time, and
 * had no way to look around the project before committing to an answer — the same
 * "one giant prompt -> parse JSON/CONTENT" shape the rest of Theta uses, just with retries
 * bolted on.
 *
 * This is now the same THOUGHT -> TOOL -> OBSERVATION loop AgentToolLoop (agent-loop.ts)
 * pioneered for Chief's whole-project QA pass, applied to actual subtask execution: the
 * model gets a small toolset (list_files, read_file, grep, glob, write_file, edit_file,
 * check_syntax, review, run_tests, run_behavior_check, finish) and decides turn by turn what
 * to do, including creating files nobody predicted at planning time, editing a file other
 * than its
 * `targetFile` when the task genuinely requires it, or just reading around before writing
 * anything.
 *
 * write_file/edit_file still automatically run the full syntax -> review -> strict-check ->
 * behavior-check pipeline as part of that single tool call (not as four separate
 * model-invoked turns) — that's what keeps a simple, single-file task converging in roughly
 * the same number of model calls as before. check_syntax/review/run_tests/run_behavior_check
 * are ALSO exposed as standalone tools so the model can invoke any of them independently
 * (re-check the whole project without writing again, review a file it didn't just write,
 * etc.) rather than being locked into a rigid four-stage pipeline it can't otherwise reach.
 */
export class ReActExecutionLoop {
  private agentId: 'dev1' | 'dev2' | 'dev3' | 'dev4';
  private ai: LLMClient | null = null;
  /** The pooled key currently backing `ai` (see getClient) — needed so recordCall/releaseKey act on the real key, not a role name. */
  private currentKey: string | null = null;
  /** The model `ai`/`currentKey` were resolved for — getClient re-acquires when this changes (e.g. dev1-3 escalating mid-task). */
  private currentModel: string | null = null;
  private uniqueReadPaths = new Set<string>();
  private scopeExpansionWarnings = 0;
  private adversarialUncertainCount = 0;
  private adversarialDisabled = false;

  /**
   * Cap on total tool-loop turns for one subtask (one model call per turn) — the direct
   * successor to the old `maxAttempts = 5`. A single successful write_file/edit_file call
   * already runs the whole verification chain internally (see class doc above), so this
   * stays numerically equivalent to the old per-attempt cap for the common single-file
   * case, while still leaving turns available for list_files/read_file exploration on
   * subtasks that genuinely need to look around first.
   */
  private maxTurns: number;

  /**
   * Phase 6-A — true only for ad-hoc chat edits dispatched via
   * ChiefOrchestrator.executeQuickTasks (quick, user-initiated, single/few-file, low-risk
   * edits — never blueprint subtasks, which pass this as false/omitted). When true,
   * getModelForThisAgent routes through ModelManager.getCheapestAvailableModel instead of
   * the fixed dev1-3 hardcoded model or dev4's Chief-mirroring default, so these edits
   * auto-downgrade to whatever's actually cheapest with budget left right now. See
   * resolveModelForAgent below for the exact routing.
   */
  private isQuickTask: boolean;

  /**
   * Lowered 8 -> 5 (previously bumped 5 -> 8, see prior note below): this project runs
   * entirely on free-tier keys with no paid fallback, and every model call costs real,
   * scarce daily budget. The critic review call is now opt-in per task (see `skipCritic`
   * on executeTask) rather than automatic on every write, which is what actually made the
   * 8-turn budget necessary in the first place — a failed review used to cost a whole extra
   * turn on top of the failed write. With critic off by default for quick tasks, 5 turns
   * covers explore -> write -> (fix if syntax/tests fail) -> finish with room to spare; the
   * previous 5->8 bump's reasoning (a failed review eating 40%+ of budget) no longer applies
   * to that common path. Blueprint subtasks, which still run with critic ON by default, are
   * the case to watch if 5 ever proves too tight — see ChiefOrchestrator.executeStep.
   */
  constructor(
    agentId: 'dev1' | 'dev2' | 'dev3' | 'dev4',
    maxTurns: number = 5,
    isQuickTask: boolean = false
  ) {
    this.agentId = agentId;
    this.maxTurns = maxTurns;
    this.isQuickTask = isQuickTask;
  }

  /**
   * Phase 3: acquires a client backed by whichever pooled key currently has quota for
   * `model` (see KeyManager.getAvailableKey) rather than a role-fixed key. Re-acquires
   * whenever `model` changes from the last call (e.g. a dev1-3 escalation mid-task) since a
   * client is only valid for the key/model it was built with. Can throw PoolExhaustedError —
   * callers should let that propagate to the turn loop, which handles it as a paused task.
   */
  private getClient(model: string): LLMClient {
    if (!this.ai || this.currentModel !== model) {
      // Release whichever key this task was previously holding (e.g. the cheap-tier key
      // before a dev1-3 mid-task escalation) BEFORE claiming a new one. Without this, the
      // old key was left marked in-use forever — the only place it was ever released was
      // the final `finally` in executeTask, which only releases `this.currentKey` (the
      // LAST key), so the pre-escalation key leaked for the rest of the process lifetime.
      // With a small pool, a couple of escalations were enough to make every remaining
      // task see "All available Gemini keys are currently in use" even though real quota
      // was still available.
      if (this.currentKey) {
        KeyManager.releaseKey(this.currentKey);
      }
      const provider = ModelManager.getProvider(model);
      const apiKey = KeyManager.getAvailableKey(this.agentId, model, provider);
      this.currentKey = apiKey;
      this.currentModel = model;
      this.ai = new LLMClient(apiKey, provider);
    }
    return this.ai;
  }

  /**
   * dev1/dev2/dev3 are pinned to a fixed fast/cheap model for a FIRST attempt — that's the
   * right default for cost/latency on the common case. But "pinned to the cheap model no
   * matter what" meant a task that was genuinely hard for that model (and got a failed
   * syntax check, a rejected review, or a failed real test/behavior run) just kept retrying
   * with the same weak model on every subsequent turn — the same mistake, over and over,
   * instead of the pipeline actually escalating effort the way a human team would hand a
   * stuck task to someone stronger. `escalate: true` switches dev1-3 to the stronger model
   * for the rest of THIS task once any turn has come back with a real failure (syntax
   * error, rejected review, failed compile/test, failed behavior check) — dev4 is
   * unaffected since it already tracks Chief's chosen model.
   */
  private getModelForThisAgent(escalate: boolean): string {
    return ReActExecutionLoop.resolveModelForAgent(this.agentId, escalate, this.isQuickTask);
  }

  /**
   * Static, agent-agnostic version of the same resolution logic above — needed so
   * ChiefOrchestrator's autopilot retry (orchestrator.ts) can resolve the model it's about to
   * retry with (to check pool budget for it) before firing the retry at all, without
   * duplicating this mapping in a second place.
   *
   * Phase 6-A: `isQuickTask` (default false, so blueprint subtasks via executeStep are
   * unaffected) routes EVERY dev lane — including dev4, which otherwise mirrors whatever
   * model Chief has selected — through ModelManager.getCheapestAvailableModel for a
   * non-escalated call. A quick, low-risk single-file edit doesn't need Chief's chosen model
   * (which the user may well have pointed at something slow/expensive, or even at the
   * critic-reserved model itself); it needs whichever cheap tier still has today's budget
   * left. Escalation after a real failure still applies on top of that — see
   * DEV_1_TO_3_ESCALATED_MODEL — so a quick task that's proven genuinely hard for the cheap
   * tier still gets a real step up, it just never steps up into the model reserved for the
   * critic's final review pass.
   */
  public static resolveModelForAgent(
    agentId: 'dev1' | 'dev2' | 'dev3' | 'dev4',
    escalate: boolean,
    isQuickTask: boolean = false
  ): string {
    if (isQuickTask) {
      return escalate
        ? ReActExecutionLoop.DEV_1_TO_3_ESCALATED_MODEL
        : ModelManager.getCheapestAvailableModel();
    }
    if (agentId === 'dev4') {
      return ModelManager.getModel('chief');
    }
    return escalate
      ? ReActExecutionLoop.DEV_1_TO_3_ESCALATED_MODEL
      : ReActExecutionLoop.DEV_1_TO_3_HARDCODED_MODEL;
  }

  /**
   * Phase 2/3 governor check, run once per turn before spending a call. Phase 3 changed WHAT
   * "budget" means here: it used to be per-lane (this.agentId had one fixed key, so its
   * budget and its lane's budget were the same thing, and a low lane would hand the task to
   * another lane's key). Now every lane shares the same pool, so lane-switching to "find
   * budget" is moot — KeyManager.getAvailableKey already picks whichever pooled key has room
   * for this model, automatically, on every call. This check now just does the two things
   * that still make sense at the pool level:
   *
   * 1. Pool is fully exhausted for this model (no key anywhere has room) — stop before
   *    spending a call we already know will fail, with a clear paused summary.
   * 2. Pool is low but not empty — warn so it's visible, then proceed.
   *
   * The actual per-call key acquisition (and its own PoolExhaustedError, for the rarer race
   * where the pool empties between this check and the call) happens in getClient().
   */
  private async ensureBudgetForTurn(
    stepId: number,
    subtaskId: string,
    escalate: boolean
  ): Promise<{ ok: boolean; summary?: string }> {
    const model = this.getModelForThisAgent(escalate);
    const remaining = KeyManager.getPoolRemainingBudget(model, ModelManager.getProvider(model));

    if (remaining <= 0) {
      if (typeof window !== 'undefined' && typeof (window as any).showToast === 'function') {
        (window as any).showToast(
          `Today's request budget is exhausted across every configured key for ${model} — pausing this task instead of burning more calls.`,
          'error'
        );
      }
      return {
        ok: false,
        summary:
          `Paused: today's request budget for ${model} is exhausted across every key in your pool — stopping before ` +
          `spending more calls that would just hit the same quota wall. The quota resets on a rolling 24h window; ` +
          `try again later, or add more API keys in settings.`,
      };
    }

    return { ok: true };
  }

  /** Truncation marker/limit applied to each referenced file's content in the prompt. */
  private static readonly MAX_REFERENCED_FILE_CHARS = 6000;

  /**
   * Files with MORE than this many lines are strongly steered toward a targeted
   * search/replace patch (`edit_file`) instead of a full rewrite (`write_file`) — full
   * rewrites of large files are slow, expensive, and risk silently regressing code far
   * from what was actually asked. This is now prompt guidance the model applies per-file
   * (it may touch several files in one task), rather than a single flag computed once for
   * a fixed target file.
   */
  private static readonly EDIT_FILE_LINE_THRESHOLD = 150;

  /** How many times to poll a locked file before giving up on one write_file/edit_file call. */
  private static readonly LOCK_WAIT_MAX_MS = 30_000;
  private static readonly LOCK_WAIT_INITIAL_MS = 250;

  /**
   * Dev agents 1-3 start on this model regardless of what's selected in the model picker
   * — they're the cheap/fast parallel workers on a first attempt, so pinning them keeps
   * cost and latency predictable for the common case. They escalate off this to
   * DEV_1_TO_3_ESCALATED_MODEL within a task after a real failure (see
   * getModelForThisAgent) rather than staying pinned indefinitely. Dev agent 4 is the
   * exception from turn 1: it mirrors Chief's active model (see getModelForThisAgent
   * below) so there's always at least one dev-agent lane running whatever "brain" Chief is
   * using.
   *
   * Bumped from 'gemini-3.5-flash-lite' to 'gemini-3.5-flash': flash-lite is the weakest
   * text model in the whole app (see models.ts — "worse at deep reasoning") and, because
   * round-robin assignment starts at dev1, it was silently the model behind EVERY
   * single-file quick task, not just bulk blueprint fan-out. That's a bad default for
   * anything requiring real precision (animation timing, layout-preserving edits, etc.).
   * Plain flash is still far cheaper/faster than pro but has materially better reasoning.
   */
  /** Public (not just private) so the Phase 4 quota dashboard can read the real constant
   *  instead of duplicating this string and risking drift if it's ever bumped again. */
  public static readonly DEV_1_TO_3_HARDCODED_MODEL = 'gemini-3.5-flash';

  /**
   * Escalation target once a dev1-3 task hits a real failure (see getModelForThisAgent). A
   * task that already failed a review or a real test run has demonstrated it's not a "cheap
   * model just needs another pass" situation, so this steps up to the strongest model that
   * ISN'T reserved for the critic — genuinely more reasoning power than the hardcoded/cheap
   * tiers, without dipping into the critic's dedicated budget to get it.
   *
   * Phase 6-A: previously this was 'gemini-3.1-pro-preview' — the same model the critic
   * defaults to (models.ts ROLE_DEFAULTS) — on the theory that a failed task deserved the
   * single strongest model available. That put ordinary dev-agent escalations (including
   * quick, low-risk chat edits that merely stumbled once) in direct quota competition with
   * the critic's final review pass, which is exactly the scarce resource "reserve
   * gemini-3.1-pro-preview for final review passes only" means to protect. Escalating to
   * 'gemini-3.6-flash' — the strongest model in QUICK_TASK_MODEL_TIERS / the app's own
   * general-purpose default — still gives the task real extra reasoning power over the
   * hardcoded/cheap tiers, it just never touches the reserved model.
   */
  /** Public for the same reason as DEV_1_TO_3_HARDCODED_MODEL above — the quota dashboard
   *  shows this as the escalation target once a dev1-3 lane trips it. */
  public static readonly DEV_1_TO_3_ESCALATED_MODEL = 'gemini-3.6-flash';

  /** The governor exposes observed cooldown/exhaustion only; it never invents a finite daily quota. */
  /**
   * Main entry point. Runs the tool loop until the model calls `finish` with a verified
   * write, or `maxTurns` is reached. Signature is unchanged from the pre-Phase-9 version
   * except the return type: a plain `Promise<boolean>` gave both callers (and, through them,
   * the Chief chat reply) nothing to say about a failure beyond "something went wrong,
   * check the Logs tab" — every failed quick task looked identical in chat regardless of
   * whether it was a syntax error, a rejected review, a failed real test run, or simply
   * running out of turns on a large file. Returning the real last-observation summary lets
   * callers surface the actual reason inline instead of that generic wrapper text.
   */
  public async executeTask(
    stepId: number,
    subtaskId: string,
    taskDescription: string,
    targetFile: string,
    acceptanceCriteria?: string[],
    contract?: string,
    /**
     * When true, `performVerifiedWrite` skips the `CodeCritic.review` LLM call on every
     * write_file/edit_file — syntax check (free, no model call) and, if the CodeSandbox executor
     * is configured, the real compile/test + behavior check still run, but the extra
     * review-model call that used to fire on EVERY write (doubling the cost of a task that
     * otherwise converges in 1-2 calls) is skipped. Defaults to false so blueprint subtasks
     * (executeStep, orchestrator.ts) keep the full quality gate unchanged; quick tasks
     * (executeQuickTasks) pass true explicitly — see the cost note there for why.
     */
    skipCritic: boolean = false
  ): Promise<{ success: boolean; summary: string }> {
    await logReActStep({
      stepId,
      subtaskId,
      agentId: this.agentId,
      thought: `Beginning task: ${taskDescription}`,
      action: 'write_file',
      actionInput: { filePath: targetFile },
      status: 'executing',
    });

    // Gather real starting context up front, exactly as before: the file tree, the target
    // file's current content (empty if it doesn't exist yet), and whatever it already
    // imports/references. This is free (no model call) and means a simple task can usually
    // go straight to write_file on turn 1 instead of spending a turn on list_files/read_file
    // it would otherwise need to re-discover this same information itself.
    const projectFiles = FileSystemTools.listAllFiles();
    const existingRead = await ToolDispatcher.dispatch({
      toolName: 'read_file',
      filePath: targetFile,
      agentId: this.agentId,
      stepId,
    });
    const existingContent = existingRead.success ? existingRead.output : '';
    const existingLineCount = existingContent ? existingContent.split('\n').length : 0;
    const taskScope = deriveTaskScope(taskDescription, targetFile);
    this.uniqueReadPaths.add(targetFile);

    const referencedPaths = FileSystemTools.resolveReferencedFiles(targetFile, existingContent, projectFiles);
    const referencedFiles = await Promise.all(
      referencedPaths.map(async (path) => {
        this.uniqueReadPaths.add(path);
        const read = await ToolDispatcher.dispatch({
          toolName: 'read_file',
          filePath: path,
          agentId: this.agentId,
          stepId,
        });
        let refContent = read.success ? read.output : '';
        if (refContent.length > ReActExecutionLoop.MAX_REFERENCED_FILE_CHARS) {
          refContent =
            refContent.slice(0, ReActExecutionLoop.MAX_REFERENCED_FILE_CHARS) +
            '\n... [truncated for prompt size]';
        }
        return { path, content: refContent };
      })
    );

    // Model is now resolved per-turn (see the loop below), not once here, since dev1-3 may
    // escalate mid-task after a real failure — see getModelForThisAgent.

    const criteriaBlock =
      acceptanceCriteria && acceptanceCriteria.length > 0
        ? `\nAcceptance criteria (all must be satisfied before you finish):\n${acceptanceCriteria
            .map((c, i) => `${i + 1}. ${c}`)
            .join('\n')}\n`
        : '';

    const contractBlock = contract
      ? `\nShared interface contract for this step — every parallel agent working on this step is building against this exact shape, so match it precisely rather than inventing your own:\n${contract}\n`
      : '';

    const referencedBlock =
      referencedFiles.length > 0
        ? `\nFull content of files ${targetFile} currently imports/references (real APIs/types, not guesses):\n${referencedFiles
            .map((f) => `--- ${f.path} ---\n${f.content || '(empty)'}`)
            .join('\n\n')}\n`
        : '';

    const staticContext = `You are ${this.agentId} in an autonomous coding team working on a real, live project, running the way Claude Code or Cline would: a tight tool-call loop, verify with real execution, and stop only once things actually work.

${formatTaskScope(taskScope)}

Primary file you're responsible for: ${targetFile}
Task: ${taskDescription}
${criteriaBlock}${contractBlock}
You are not limited to ${targetFile} — if the task genuinely requires creating a new file or editing another existing one (a shared util, a type it needs, etc.), do it. Every write is protected by a per-file lock so parallel agents on other subtasks can't clobber the same file.

All project file paths (for orientation — use read_file for any whose content you actually need):
${projectFiles.length > 0 ? projectFiles.map((f) => `- ${f}`).join('\n') : '(empty project — this will be the first file)'}
${referencedBlock}
Current content of ${targetFile}${existingContent ? ` (${existingLineCount} lines)` : ' (file does not exist yet — create it)'}:
${existingContent ? '```\n' + existingContent + '\n```' : '(none)'}\n\nExecution rule for this blueprint subtask: reason about the user request BEFORE exploring. Make the smallest correct write/edit as early as possible. Do not read the whole repository just to feel informed. Start with the target file and direct references; use grep/glob only to answer a concrete dependency question. Treat unrelated backend/database/infrastructure files as out of scope unless evidence pulls them in. When the task touches an API, package, framework syntax, or nontrivial UI/UX decision that may have changed since model training, use research_web first and ground the implementation in current sources. For UI/UX work, research the visual/interaction surface itself rather than spending turns reading unrelated backend code. Do not call run_tests or browser checks unless the task specifically needs them; the Chief performs one real project verification after all parallel developers finish.`;

    const toolSpec = `Available tools — call exactly ONE per turn:
- list_files: no input needed. Returns every file path currently in the project (fresh — may include files written earlier in this same loop).
- read_file: INPUT is the file path. Returns its current content, or an error if it doesn't exist.
- grep: INPUT is a regex pattern. Searches the CONTENTS of every file in the project and returns matching "path:line: snippet" entries (capped at 50). Use this for anything the "currently references" context above didn't catch — e.g. finding every file that renders a given prop or calls a given function, even when none of those files import each other. Prefer this over read_file-ing files one by one when you're not sure which files are relevant.
- glob: INPUT is a glob pattern over file PATHS (\`*\` within one path segment, \`**\` across segments, \`?\` for one character — e.g. "src/components/**/*.tsx"). Returns matching paths, not content.
- write_file: INPUT is the file path. Put the COMPLETE new file content in the CONTENT block (no markdown fences). Overwrites the file, or creates it if new. Automatically runs, in order: a syntax check, a code-review pass, and (if the CodeSandbox executor is configured) a real compile/test run and a headless-browser behavioral check — the observation tells you exactly which of these passed/failed. Prefer this only for new files or files at/under ${ReActExecutionLoop.EDIT_FILE_LINE_THRESHOLD} lines; for longer existing files, use edit_file instead.
- edit_file: INPUT is the file path (must already exist). Put one or more search/replace blocks in the PATCH block:
${SEARCH_REPLACE_FORMAT_INSTRUCTIONS}
  Runs the exact same automatic verification chain as write_file once the patch is applied. If a patch fails to apply cleanly, you'll be told to use write_file for that file instead.
- check_syntax: INPUT is the file path. Runs a real syntax check on its current content, independent of writing. Useful to double-check a file you didn't just write.
- review: INPUT is the file path. Runs a fresh code-review pass against this task's acceptance criteria on that file's current content, independent of writing.
- run_tests: no input needed. Runs the WHOLE project through the real executor when available. For blueprint subtasks, runtime verification is intentionally deferred to the step-level gate; do not spend a turn on this unless the task explicitly requires it.
- run_behavior_check: no input needed. Runs a real browser check when available. For blueprint subtasks, this is intentionally deferred to the step-level gate.
- run_command: INPUT is one shell command (e.g. \`npm install <pkg>\`, \`npm run lint\`, \`ls -la src\`, a one-off debug script). Runs it for real in the same sandboxed environment as run_tests/run_behavior_check when the executor is configured; unavailable otherwise (the observation tells you which). Use this for anything write_file/edit_file/run_tests/run_behavior_check can't answer — e.g. installing a package this task actually needs, or inspecting real command output while debugging a failure. Don't use it as a substitute for write_file/edit_file.
- research_web: INPUT is a focused research question. Prefix with \`tech:\` for current package/API docs and release notes, \`ui:\` for UI/UX inspiration and design-system study, or \`deep:\` for both. It performs live grounded web research and returns source URIs/provenance; do not guess current APIs from memory when this tool can verify them.
- finish: INPUT is a short summary of the outcome. Only accepted once your most recent write_file/edit_file call fully passed its automatic verification chain (syntax + review + tests, and behavior check when applicable) — if it didn't, you'll be told to fix it and finish will be rejected.

Note on the "currently references" context above: it was built by statically parsing this file's own import/require statements before this loop started, so it's a free, best-effort starting point — not exhaustive. It won't catch files that reference THIS file rather than the other way around, or connections made through naming conventions or dynamically-built paths. Use grep/glob whenever you need to find something it didn't surface.`;

    const responseFormat = `Use the provided native function tools for tool calls. Only if native tool calling is unavailable, fall back to the legacy text format below. Do not put tool arguments in prose when a native tool call is available.

Legacy fallback format:
THOUGHT: <1-2 sentences>
TOOL: <list_files|read_file|grep|glob|write_file|edit_file|check_syntax|review|research_web|run_tests|run_behavior_check|run_command|finish>
INPUT: <file path, regex/glob pattern, shell command, a short summary for finish, or blank for list_files/run_tests/run_behavior_check>
CONTENT:
<only for write_file — the complete new file content, no code fences. Omit this line entirely for other tools.>
PATCH:
<only for edit_file — one or more search/replace blocks. Omit this line entirely for other tools.>`;

    const turns: LoopTurnRecord[] = [];
    let transcript = '';
    /** Most recent turn's observation — surfaced as the summary on failure so callers (the Chief chat reply, in particular) can say WHAT went wrong, not just THAT something did. */
    let lastObservation = '';
    /** True only when the most recent write_file/edit_file call passed its ENTIRE automatic verification chain. Reset to false at the start of every new write attempt. */
    let lastWriteVerified = false;
    /** Per-path: true once an edit_file patch has failed to apply against that path — steers (and, if ignored, blocks) further edit_file attempts on it in favor of write_file. */
    const noEditPaths = new Set<string>();
    /** Set once any turn comes back with a real failure — escalates dev1-3 off the cheap hardcoded model for the rest of this task (see getModelForThisAgent). Sticky: never reset back to false within one task. */
    let hasFailed = false;

    try {
      for (let turnNum = 1; turnNum <= this.maxTurns; turnNum++) {
        // Phase 2: check the request-budget governor BEFORE spending a call, not after
        // hitting a 429 — see ensureBudgetForTurn for what happens on a low/exhausted
        // budget (switch lanes, warn, or fail fast).
        const budgetCheck = await this.ensureBudgetForTurn(stepId, subtaskId, hasFailed);
        if (!budgetCheck.ok) {
          await logReActStep({
            stepId,
            subtaskId,
            agentId: this.agentId,
            thought: budgetCheck.summary || 'Paused: today\'s request budget is exhausted.',
            action: 'complete_step',
            status: 'failed',
          });
          return { success: false, summary: budgetCheck.summary! };
        }

        const model = this.getModelForThisAgent(hasFailed);
        const prompt = `${staticContext}\n\n${toolSpec}\n\nTurn ${turnNum} of ${this.maxTurns} max.\n\nTranscript so far:\n${
          transcript || '(nothing yet)'
        }\n\n${responseFormat}`;

        let response;
        const truthBase = { projectId: getActiveProjectId() || undefined, stepId, agentId: this.agentId, kind: 'agent' as const, action: 'model_generate_content' };
        recordExecutionTruth({ ...truthBase, status: 'dispatched', startedAt: new Date().toISOString(), metadata: { model, turn: turnNum, subtaskId } });
        try {
          response = await callWithBackoff<any>(
            () => this.getClient(model).models.generateContent({
              model,
              contents: prompt,
              config: {
                tools: [{ functionDeclarations: [
                  { name: 'list_files', description: 'List project files.', parameters: { type: Type.OBJECT, properties: {} } },
                  { name: 'read_file', description: 'Read a project file.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } }, required: ['input'] } },
                  { name: 'grep', description: 'Search project file contents.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } }, required: ['input'] } },
                  { name: 'glob', description: 'Find project paths by glob.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } }, required: ['input'] } },
                  { name: 'write_file', description: 'Write a complete project file.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING }, content: { type: Type.STRING } }, required: ['input', 'content'] } },
                  { name: 'edit_file', description: 'Apply a search/replace patch to an existing project file.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING }, patch: { type: Type.STRING } }, required: ['input', 'patch'] } },
                  { name: 'check_syntax', description: 'Check syntax for a project file.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } }, required: ['input'] } },
                  { name: 'review', description: 'Run a code review for a project file.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } }, required: ['input'] } },
                  { name: 'research_web', description: 'Research current technical or UI/UX references.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } }, required: ['input'] } },
                  { name: 'run_tests', description: 'Run the project verification suite.', parameters: { type: Type.OBJECT, properties: {} } },
                  { name: 'run_behavior_check', description: 'Run browser behavior verification.', parameters: { type: Type.OBJECT, properties: {} } },
                  { name: 'run_command', description: 'Run one real shell command in the sandboxed executor (install a package, inspect output, run a debug script).', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } }, required: ['input'] } },
                  { name: 'finish', description: 'Finish the task after verification succeeds.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } } } },
                ] }]
              }
            }),
            { onQuotaCooldown: (delayMs) => { if (this.currentKey) RequestBudget.recordProviderCooldown(this.currentKey, model, delayMs, 429); } }
          );
          recordExecutionTruth({ ...truthBase, status: 'completed', finishedAt: new Date().toISOString(), metadata: { model, turn: turnNum, subtaskId } });
        } catch (err: any) {
          recordExecutionTruth({ ...truthBase, status: 'failed', finishedAt: new Date().toISOString(), error: err?.message || String(err), metadata: { model, turn: turnNum, subtaskId } });
          if (err?.name === 'PoolExhaustedError') {
            // Rare race: ensureBudgetForTurn saw room a moment ago, but the pool emptied
            // (another concurrent task consumed the last slot) before this call acquired a
            // key. Treat it the same as ensureBudgetForTurn's own exhaustion case.
            const summary = `Paused: ${err.message}`;
            await logReActStep({
              stepId,
              subtaskId,
              agentId: this.agentId,
              thought: summary,
              action: 'complete_step',
              status: 'failed',
            });
            return { success: false, summary };
          }
          throw err;
        }
        // Recorded right after a call actually completes (success or a non-quota error still
        // means a request landed) so the budget governor's count reflects real usage.
        // callWithBackoff's own internal 429 retries aren't separately recorded here — see
        // RequestBudget.recordCall's doc — this call represents the one top-level attempt
        // this turn made. Recorded against the actual pooled key that served it, not the
        // agent's name — see currentKey on getClient.
        if (this.currentKey) {
          RequestBudget.recordCall(this.currentKey, model);
        }
        const nativeCall = Array.isArray((response as any).functionCalls) ? (response as any).functionCalls[0] : null;
        const raw = response.text || '';
        const nativeArgs = nativeCall?.args && typeof nativeCall.args === 'object' ? nativeCall.args : {};
        const thought = nativeCall ? (raw || `Native tool call: ${nativeCall.name}`) : (this.extractSection(raw, 'THOUGHT') || '(no thought given)');
        const tool = (nativeCall?.name || this.extractSection(raw, 'TOOL')?.toLowerCase().trim() || 'finish') as DevAgentTool;
        const input = (String(nativeArgs.input ?? this.extractSection(raw, 'INPUT') ?? '')).trim();
        const rawContent = String(nativeArgs.content ?? this.extractSection(raw, 'CONTENT') ?? '');
        const rawPatch = String(nativeArgs.patch ?? this.extractSection(raw, 'PATCH') ?? '');

        let observation: string;
        let logStatus: 'success' | 'failed' | 'skipped' = 'success';
        let logAction: string = tool;

        switch (tool) {
          case 'list_files': {
            const files = FileSystemTools.listAllFiles();
            observation = files.length > 0 ? files.join('\n') : '(project is empty)';
            logAction = 'list_files';
            break;
          }

          case 'read_file': {
            if (!input) {
              observation = 'Error: read_file requires a file path in INPUT.';
              logStatus = 'failed';
              break;
            }
            this.uniqueReadPaths.add(input);
            const overBudget = this.uniqueReadPaths.size > taskScope.readBudget;
            const looksIrrelevant = taskScope.focus === 'ui' && /^(api|supabase|scripts|server)\//i.test(input);
            if (looksIrrelevant || overBudget) this.scopeExpansionWarnings += 1;
            const res = await ToolDispatcher.dispatch({
              toolName: 'read_file',
              filePath: input,
              agentId: this.agentId,
              stepId,
            });
            const scopeWarning = (looksIrrelevant || overBudget)
              ? `\n[SCOPE WARNING] Read ${this.uniqueReadPaths.size}/${taskScope.readBudget} unique files. ${looksIrrelevant ? `"${input}" is outside the default ${taskScope.focus} surface. Expand only with evidence.` : 'Budget exceeded; justify further reads with a concrete dependency or verification failure.'}`
              : '';
            observation = res.success ? `${res.output || '(empty file)'}${scopeWarning}` : `Error: ${res.error}${scopeWarning}`;
            logStatus = res.success ? 'success' : 'failed';
            logAction = 'read_file';
            break;
          }

          case 'grep': {
            if (!input) {
              observation = 'Error: grep requires a regex pattern in INPUT.';
              logStatus = 'failed';
              break;
            }
            const res = await ToolDispatcher.dispatch({
              toolName: 'grep',
              pattern: input,
              agentId: this.agentId,
              stepId,
            });
            observation = res.success ? res.output || '(no matches found)' : `Error: ${res.error}`;
            logStatus = res.success ? 'success' : 'failed';
            logAction = 'grep';
            break;
          }

          case 'glob': {
            if (!input) {
              observation = 'Error: glob requires a glob pattern in INPUT (e.g. "src/**/*.tsx").';
              logStatus = 'failed';
              break;
            }
            const res = await ToolDispatcher.dispatch({
              toolName: 'glob',
              pattern: input,
              agentId: this.agentId,
              stepId,
            });
            observation = res.success ? res.output || '(no files matched)' : `Error: ${res.error}`;
            logStatus = res.success ? 'success' : 'failed';
            logAction = 'glob';
            break;
          }

          case 'check_syntax': {
            if (!input) {
              observation = 'Error: check_syntax requires a file path in INPUT.';
              logStatus = 'failed';
              break;
            }
            const res = await ToolDispatcher.dispatch({
              toolName: 'check_syntax',
              filePath: input,
              agentId: this.agentId,
              stepId,
            });
            observation = res.success ? `Syntax OK for ${input}.` : `Syntax error in ${input}: ${res.error}`;
            logStatus = res.success ? 'success' : 'failed';
            logAction = 'check_syntax';
            break;
          }

          case 'review': {
            if (!input) {
              observation = 'Error: review requires a file path in INPUT.';
              logStatus = 'failed';
              break;
            }
            const fileRead = await ToolDispatcher.dispatch({
              toolName: 'read_file',
              filePath: input,
              agentId: this.agentId,
              stepId,
            });
            if (!fileRead.success) {
              observation = `Error: could not read ${input} to review it: ${fileRead.error}`;
              logStatus = 'failed';
              break;
            }
            const review = await CodeCritic.review(
              input,
              taskDescription,
              acceptanceCriteria,
              fileRead.output,
              FileSystemTools.listAllFiles()
            );
            observation = review.approved
              ? `Review APPROVED for ${input}: ${review.feedback}`
              : `Review REQUESTED CHANGES for ${input}: ${review.feedback}`;
            logStatus = review.approved ? 'success' : 'failed';
            logAction = 'review';
            break;
          }

          case 'research_web': {
            if (!input) {
              observation = 'Error: research_web requires a focused research question in INPUT.';
              logStatus = 'failed';
              break;
            }
            const res = await ToolDispatcher.dispatch({
              toolName: 'research_web',
              pattern: input,
              agentId: this.agentId,
              stepId,
            });
            observation = res.success
              ? res.output || '(research returned no usable observations)'
              : `Web research failed: ${res.error}`;
            logStatus = res.success ? 'success' : 'failed';
            logAction = 'research_web';
            break;
          }

          case 'run_tests': {
            const check = await CodeRunnerTools.runStrictCheck(FileSystemTools.listAllFilesWithContent(), {
              stepId,
              agentId: this.agentId,
            });
            if (!check.ranInSandbox) {
              observation = `(Real executor unavailable, so no real test process ran. ${check.output})`;
              logStatus = 'skipped';
            } else {
              observation = check.success ? `PASSED.\n${check.output}` : `FAILED.\n${check.error}`;
              logStatus = check.success ? 'success' : 'failed';
            }
            logAction = 'run_tests';
            break;
          }

          case 'run_behavior_check': {
            const behaviorCheck = await CodeRunnerTools.runBehaviorCheck(
              FileSystemTools.listAllFilesWithContent(),
              acceptanceCriteria || [],
              { stepId, agentId: this.agentId }
            );
            if (!behaviorCheck.ranInSandbox) {
              observation = `(SKIPPED — no real headless browser run was available. ${behaviorCheck.output})`;
              logStatus = 'skipped';
            } else {
              observation = behaviorCheck.success ? `PASSED.\n${behaviorCheck.output}` : `FAILED.\n${behaviorCheck.error}`;
              logStatus = behaviorCheck.success ? 'success' : 'failed';
            }
            logAction = 'run_behavior_check';
            break;
          }

          case 'run_command': {
            if (!input) {
              observation = 'Error: run_command requires a shell command in INPUT.';
              logStatus = 'failed';
              break;
            }
            const cmdResult = await CodeRunnerTools.runCommandInSandbox(
              FileSystemTools.listAllFilesWithContent(),
              input
            );
            if (!cmdResult.ranInSandbox) {
              observation = `(SKIPPED — no real executor was available to run this command. ${cmdResult.output || cmdResult.error || ''})`;
              logStatus = 'skipped';
            } else {
              observation = cmdResult.success
                ? `Command succeeded.\n${cmdResult.output}`
                : `Command failed.\n${cmdResult.error}`;
              logStatus = cmdResult.success ? 'success' : 'failed';
            }
            logAction = 'run_command';
            break;
          }

          case 'write_file': {
            lastWriteVerified = false;
            if (!input) {
              observation = 'Error: write_file requires a file path in INPUT.';
              logStatus = 'failed';
              break;
            }
            const fileContent = this.stripCodeFences(rawContent);
            if (!fileContent.trim()) {
              observation = 'Error: CONTENT was empty — retry with the complete file body.';
              logStatus = 'failed';
              break;
            }
            const outcome = await this.performVerifiedWrite(input, fileContent, {
              stepId,
              subtaskId,
              taskDescription,
              acceptanceCriteria,
              skipCritic,
              writerModel: model,
              scopeReason: taskScope.reason,
              deferRuntimeChecks: !this.isQuickTask,
            });
            observation = outcome.observation;
            logStatus = outcome.success ? 'success' : 'failed';
            logAction = 'write_file';
            lastWriteVerified = outcome.success;
            break;
          }

          case 'edit_file': {
            lastWriteVerified = false;
            if (!input) {
              observation = 'Error: edit_file requires a file path in INPUT.';
              logStatus = 'failed';
              break;
            }
            if (noEditPaths.has(input)) {
              observation = `A previous patch failed to apply to ${input} — use write_file with the complete file content instead.`;
              logStatus = 'failed';
              break;
            }
            if (!rawPatch.trim()) {
              observation =
                'Error: edit_file needs one or more "<<<<<<< SEARCH / ======= / >>>>>>> REPLACE" blocks in PATCH, or use write_file for a full rewrite.';
              logStatus = 'failed';
              break;
            }

            const currentRead = await ToolDispatcher.dispatch({
              toolName: 'read_file',
              filePath: input,
              agentId: this.agentId,
              stepId,
            });
            if (!currentRead.success) {
              observation = `Error: ${input} doesn't exist yet — edit_file only works on existing files. Use write_file to create it.`;
              logStatus = 'failed';
              break;
            }

            const applyResult = applySearchReplacePatch(currentRead.output, rawPatch);
            if (!applyResult.success) {
              noEditPaths.add(input);
              observation = `${applyResult.error} Use write_file with the complete file content for ${input} on your next attempt.`;
              logStatus = 'failed';
              await logReActStep({
                stepId,
                subtaskId,
                agentId: this.agentId,
                thought: `Patch failed to apply to ${input}. Falling back to a full rewrite.`,
                action: 'edit_file',
                actionInput: { filePath: input },
                observation: applyResult.error,
                status: 'failed',
              });
              break;
            }

            const patchedContent = applyResult.content || '';
            if (!patchedContent.trim()) {
              observation = 'The patch applied but produced empty file content — retry with a valid patch, or use write_file for a full rewrite.';
              logStatus = 'failed';
              break;
            }

            const outcome = await this.performVerifiedWrite(input, patchedContent, {
              stepId,
              subtaskId,
              taskDescription,
              acceptanceCriteria,
              skipCritic,
              writerModel: model,
              scopeReason: taskScope.reason,
              deferRuntimeChecks: !this.isQuickTask,
            });
            observation = outcome.observation;
            logStatus = outcome.success ? 'success' : 'failed';
            logAction = 'edit_file';
            lastWriteVerified = outcome.success;
            break;
          }

          case 'finish':
          default: {
            if (!lastWriteVerified) {
              observation =
                'Cannot finish yet — call write_file or edit_file on the file(s) this task needs, and make sure the automatic verification (syntax + review + real tests, when configured) fully passes before finishing.';
              logStatus = 'failed';
              logAction = 'complete_step';
              lastObservation = observation;
              turns.push({ turn: turnNum, thought, tool: 'finish', input, observation });
              await logReActStep({
                stepId,
                subtaskId,
                agentId: this.agentId,
                thought,
                action: 'complete_step',
                observation,
                status: 'failed',
              });
              transcript += `\nTHOUGHT: ${thought}\nTOOL: finish\nOBSERVATION: ${observation}\n`;
              continue;
            }

            const summary = `${input || rawContent || 'Task completed successfully.'} [scope: ${this.uniqueReadPaths.size}/${taskScope.readBudget} unique reads${this.scopeExpansionWarnings ? `; ${this.scopeExpansionWarnings} scope warning(s)` : ''}]`;
            await logReActStep({
              stepId,
              subtaskId,
              agentId: this.agentId,
              thought: `Task loop finished after ${turnNum} turn(s): ${summary}`,
              action: 'complete_step',
              status: 'success',
            });
            return { success: true, summary };
          }
        }

        if (logStatus === 'failed') hasFailed = true;

        lastObservation = observation;
        turns.push({ turn: turnNum, thought, tool, input, observation });
        await logReActStep({
          stepId,
          subtaskId,
          agentId: this.agentId,
          thought,
          action: logAction as any,
          actionInput: input ? { filePath: input } : undefined,
          observation: this.truncateForLog(observation),
          status: logStatus,
        });
        transcript += `\nTHOUGHT: ${thought}\nTOOL: ${tool}${input ? `\nINPUT: ${input}` : ''}\nOBSERVATION: ${observation}\n`;
      }
    } catch (error: any) {
      const rawMessage = error?.message || String(error);
      const infrastructure = /File-lock service unavailable|Supabase|executor|CodeSandbox|API key|session is invalid|quota|RESOURCE_EXHAUSTED/i.test(rawMessage);
      const summary = `${infrastructure ? 'Infrastructure error' : 'Task error'}: ${rawMessage}`;
      await logReActStep({
        stepId,
        subtaskId,
        agentId: this.agentId,
        thought: `Unhandled tool-loop error: ${error.message}`,
        action: 'write_file',
        status: 'failed',
      });
      return { success: false, summary };
    } finally {
      // Release whichever pooled key this task claimed so it's immediately eligible again
      // for other concurrent tasks' LRU picks (see KeyManager's inUse doc) — this task holds
      // it for its whole (possibly multi-turn) duration, not per-call.
      if (this.currentKey) {
        KeyManager.releaseKey(this.currentKey);
      }
    }

    const summary = lastObservation
      ? `Ran out of turns (${this.maxTurns} max) before finishing. Last thing that happened: ${lastObservation}`
      : `Ran out of turns (${this.maxTurns} max) without making any progress.`;
    await logReActStep({
      stepId,
      subtaskId,
      agentId: this.agentId,
      thought: `Reached the ${this.maxTurns}-turn limit without a verified finish.`,
      action: 'complete_step',
      status: 'failed',
    });
    return { success: false, summary };
  }

  /**
   * Shared write path for both write_file and edit_file once each has resolved the final
   * content to persist. Acquires the per-file lock (waiting/retrying briefly if another
   * agent currently holds it), checks syntax BEFORE committing, writes, then runs the same
   * review -> strict-check -> behavior-check chain the old fixed pipeline ran — just now
   * triggered from inside a single tool call instead of a hardcoded sequence of attempts.
   */
  private async performVerifiedWrite(
    filePath: string,
    content: string,
    ctx: {
      stepId: number;
      subtaskId: string;
      taskDescription: string;
      acceptanceCriteria?: string[];
      /** Blueprint steps defer expensive real-project verification until the step-level gate. */
      deferRuntimeChecks?: boolean;
      /** See executeTask's skipCritic doc — when true, the CodeCritic.review call below is skipped entirely. */
      skipCritic?: boolean;
      writerModel: string;
      scopeReason: string;
    }
  ): Promise<{ success: boolean; observation: string }> {
    const lockAcquired = await this.acquireLockWithWait(filePath);
    if (!lockAcquired) {
      return {
        success: false,
        observation: `File ${filePath} is currently locked by another agent — try again next turn.`,
      };
    }

    try {
      const syntaxResult = await ToolDispatcher.dispatch({
        toolName: 'check_syntax',
        filePath,
        content,
        agentId: this.agentId,
        stepId: ctx.stepId,
      });
      if (!syntaxResult.success) {
        return { success: false, observation: `Syntax error in ${filePath}: ${syntaxResult.error}` };
      }

      const writeResult = await ToolDispatcher.dispatch({
        toolName: 'write_file',
        filePath,
        content,
        agentId: this.agentId,
        stepId: ctx.stepId,
      });
      if (!writeResult.success) {
        return { success: false, observation: `Write failed for ${filePath}: ${writeResult.error}` };
      }

      // Free-tier cost note: this is a full extra LLM call on top of the write itself — for
      // quick tasks (skipCritic: true, set by ChiefOrchestrator.executeQuickTasks) that
      // doubles the cost of every write for a review pass whose marginal value is lower on
      // small, user-directed edits. Syntax check above and, when the CodeSandbox executor is
      // configured, the real compile/test + behavior check below still run either way —
      // those are ground truth and free-or-cheap; this is the one step that's genuinely
      // skippable to cut cost. Blueprint subtasks (executeStep) never set skipCritic, so
      // they keep the full gate.
      const review = ctx.skipCritic
        ? { approved: true, feedback: '(critic review skipped for this task — syntax + tests only)' }
        : await CodeCritic.review(
            filePath,
            ctx.taskDescription,
            ctx.acceptanceCriteria,
            content,
            FileSystemTools.listAllFiles()
          );
      if (!review.approved) {
        return {
          success: false,
          observation: `Wrote ${filePath}, but review requested changes — fix all of this before your next write: ${review.feedback}`,
        };
      }

      if (!ctx.skipCritic && !this.adversarialDisabled) {
        const adversarial = await adversarialReview({
          writerModel: ctx.writerModel,
          task: ctx.taskDescription,
          targetFile: filePath,
          content,
          acceptanceCriteria: ctx.acceptanceCriteria,
          scopeReason: ctx.scopeReason,
        });
        if (adversarial.verdict === 'revise') {
          return {
            success: false,
            observation: `Independent adversarial review found a real concern (${adversarial.reviewerModel}): ${adversarial.strongestConcern}. Falsification checks: ${adversarial.falsificationChecks.join(' | ')}`,
          };
        }
        if (adversarial.verdict === 'uncertain') {
          this.adversarialUncertainCount += 1;
          if (this.adversarialUncertainCount >= 2) {
            this.adversarialDisabled = true;
          }
          const independence = adversarial.independentReviewer ? 'independent reviewer' : 'NO independent reviewer available';
          // Infra/review outages are not code-quality rejections. Continue on CodeCritic/runtime evidence, but make degraded review visible.
          console.warn(`[adversarial-review] degraded: ${independence}; uncertainCount=${this.adversarialUncertainCount}; disabled=${this.adversarialDisabled}`);
        } else {
          this.adversarialUncertainCount = 0;
        }
      }

      let runtimeNote = '';
      if (!ctx.deferRuntimeChecks) {
        const strictCheck = await CodeRunnerTools.runStrictCheck(FileSystemTools.listAllFilesWithContent(), {
          stepId: ctx.stepId,
          agentId: this.agentId,
        });
        if (strictCheck.ranInSandbox && !strictCheck.success) {
          return {
            success: false,
            observation: `Wrote ${filePath} and it passed review, but the real compile/test run failed — this is what a real run actually produced, fix it precisely: ${strictCheck.error}`,
          };
        }
        if (strictCheck.ranInSandbox) runtimeNote = ' Verified with a real compile/test run.';
        if (strictCheck.ranInSandbox) {
          const behaviorCheck = await CodeRunnerTools.runBehaviorCheck(
            FileSystemTools.listAllFilesWithContent(),
            ctx.acceptanceCriteria || [],
            { stepId: ctx.stepId, agentId: this.agentId }
          );
          if (behaviorCheck.ranInSandbox && !behaviorCheck.success) {
            return { success: false, observation: `Wrote ${filePath} but browser verification failed: ${behaviorCheck.error}` };
          }
          if (behaviorCheck.ranInSandbox) runtimeNote += ' Verified headless in a real browser.';
        }
      } else {
        runtimeNote = ' Runtime/project-wide verification deferred until the blueprint step gate.';
      }

      return {
        success: true,
        observation: `Wrote ${filePath} (${content.length} chars). Syntax OK. Review approved: ${review.feedback}.${runtimeNote}`,
      };
    } finally {
      await releaseFileLock(this.agentId, filePath);
    }
  }

  /**
   * Waits briefly for a lock held by another agent to be released (locks have a 30s TTL —
   * see state-lock.ts) instead of failing immediately, since contention between parallel
   * dev agents on a shared file (e.g. both touching a common types file) is expected and
   * usually resolves within a turn or two.
   */
  private async acquireLockWithWait(filePath: string): Promise<boolean> {
    const deadline = Date.now() + ReActExecutionLoop.LOCK_WAIT_MAX_MS;
    let delay = ReActExecutionLoop.LOCK_WAIT_INITIAL_MS;
    while (Date.now() < deadline) {
      if (await acquireFileLock(this.agentId, filePath)) return true;
      if (!(await isFileLocked(filePath, this.agentId))) {
        if (await acquireFileLock(this.agentId, filePath)) return true;
      }
      const remaining = Math.max(0, deadline - Date.now());
      if (!remaining) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)));
      delay = Math.min(Math.round(delay * 1.6), 2_500);
    }
    return false;
  }

  private extractSection(text: string, header: string): string | null {
    const match = text.match(new RegExp(`${header}:\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Z_]*:|$)`));
    return match ? match[1].trim() : null;
  }

  /** Strips ```lang ... ``` fences the model sometimes wraps CONTENT in despite instructions. */
  private stripCodeFences(text: string): string {
    const fenced = text.match(/^```[a-zA-Z0-9]*\n?([\s\S]*?)\n?```$/);
    return fenced ? fenced[1] : text;
  }

  /** Keeps a single turn's observation from blowing up the agent_react_logs row size. */
  private truncateForLog(text: string, maxChars = 4000): string {
    if (text.length <= maxChars) return text;
    return text.slice(0, maxChars) + '\n... [truncated for log]';
  }
}
