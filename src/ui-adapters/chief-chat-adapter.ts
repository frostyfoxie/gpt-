import { ChiefOrchestrator, StepBlueprint, QuickTask, QuickTaskResult } from '../engine/orchestrator';
import { ConversationSync } from '../lib/supabase/conversation-sync';
import { explainGeminiAuthError } from '../lib/gemini-error';
import { onActiveProjectChanged } from '../engine/active-project';
import { BlueprintSync, type PersistedBlueprintState } from '../lib/supabase/blueprint-sync';
import { getExecutionTruth } from '../engine/execution-truth';
import { logReActStep } from '../lib/supabase/logger';

/**
 * Drives the "Chief" tab: conversational planning with the user, turning that
 * discussion into a step blueprint, and running the blueprint across the 4
 * parallel dev agents (manual step-by-step approval, or full autopilot).
 */
export class ChiefChatAdapter {
  private orchestrator: ChiefOrchestrator | null = null;
  private blueprint: StepBlueprint[] = [];
  private conversation: string[] = [];
  private mode: 'manual' | 'auto' = 'manual';
  private awaitingBlueprintConfirmation = false;
  private blueprintDecisionPending = false;
  private isBusy = false;
  private cancelled = false;
  private hasInitialCheckpoint = false;
  private finalized = false;
  /** True once a step is actively executing (write/review/checks in flight) — a Pause request never interrupts this, only what happens after. */
  private isRunningStep = false;
  /** Set by the user clicking Pause while a step is running; consumed the moment that step finishes. */
  private pauseRequested = false;
  /** True once execution has actually stopped between steps — completed steps' changes stay intact. */
  private paused = false;
  private blueprintExecutionActive = false;
  /** Reserved checkpoint id for the pre-blueprint baseline. Negative ids cannot collide with generated blueprint steps. */
  private static readonly BASELINE_CHECKPOINT_ID = -1;

  constructor() {
    if (typeof window !== 'undefined') {
      (window as any).chiefAdapter = this;
      // Project selection happens after adapters are constructed. Rehydrate again whenever
      // the user opens/switches projects, so chat history is always project-scoped.
      onActiveProjectChanged(() => { void this.rehydrateProjectState(); });
      window.addEventListener('theta:subtask-status', () => this.renderBlueprintPanel());
      void this.rehydrateProjectState();
    }
  }

  /**
   * Restores the discussion history from Supabase (or its localStorage fallback) on load, so
   * returning to a project doesn't lose prior discussion and force Chief to re-explain
   * architectural decisions already settled. Async by nature (network round trip) — runs
   * after construction and repaints the Chief tab's chat thread once it resolves.
   */
  private async rehydrateConversation(): Promise<void> {
    try {
      this.conversation = [];
      const saved = await ConversationSync.load('chief');
      if (saved.length > 0) {
        this.conversation = saved;
        const lastChief = [...saved].reverse().find((line) => line.startsWith('Chief: '));
        this.awaitingBlueprintConfirmation = Boolean(lastChief && /confirm|agree|draft (the )?blueprint/i.test(lastChief));
        this.updateGenerateBlueprintButton();
        if (typeof (window as any).renderRestoredConversation === 'function') {
          (window as any).renderRestoredConversation('chief', this.conversation);
        }
      }
    } catch (err) {
      console.warn('[ChiefChatAdapter] Failed to rehydrate conversation:', err);
    }
  }

  /** Fire-and-forget persistence — never blocks the chat turn on a network round trip. */
  private persistConversation(): void {
    void ConversationSync.save('chief', this.conversation);
  }

  private snapshotBlueprintState(): PersistedBlueprintState {
    return {
      blueprint: JSON.parse(JSON.stringify(this.blueprint)),
      mode: this.mode,
      awaitingBlueprintConfirmation: this.awaitingBlueprintConfirmation,
      blueprintDecisionPending: this.blueprintDecisionPending,
      cancelled: this.cancelled,
      hasInitialCheckpoint: this.hasInitialCheckpoint,
      finalized: this.finalized,
      paused: this.paused,
      pauseRequested: this.pauseRequested,
    };
  }

  private persistBlueprintState(): void {
    if (!this.blueprint.length && !this.blueprintDecisionPending && !this.hasInitialCheckpoint) {
      void BlueprintSync.clear();
      return;
    }
    void BlueprintSync.save(this.snapshotBlueprintState());
  }

  private async rehydrateProjectState(): Promise<void> {
    await this.rehydrateConversation();
    try {
      const saved = await BlueprintSync.load();
      if (!saved) {
        this.blueprint = [];
        this.blueprintDecisionPending = false;
        this.hasInitialCheckpoint = false;
        this.renderBlueprintPanel();
        return;
      }
      this.blueprint = Array.isArray(saved.blueprint) ? saved.blueprint : [];
      this.mode = saved.mode === 'auto' ? 'auto' : 'manual';
      this.awaitingBlueprintConfirmation = Boolean(saved.awaitingBlueprintConfirmation);
      this.blueprintDecisionPending = Boolean(saved.blueprintDecisionPending);
      this.cancelled = Boolean(saved.cancelled);
      this.hasInitialCheckpoint = Boolean(saved.hasInitialCheckpoint);
      this.finalized = Boolean(saved.finalized);
      this.paused = Boolean(saved.paused);
      this.pauseRequested = false;
      this.isRunningStep = false;
      this.blueprintExecutionActive = false;
      this.blueprintExecutionActive = false;

      // A browser refresh cannot safely resume a step that was executing in another JS
      // instance. Completed work remains completed; an interrupted step becomes pending so
      // the user can retry it instead of Theta falsely claiming it finished.
      let recoveredInterruptedStep = false;
      for (const step of this.blueprint) {
        if (step.status === 'in_progress') { step.status = 'pending'; recoveredInterruptedStep = true; }
      }
      if (recoveredInterruptedStep) {
        this.paused = true;
        this.persistBlueprintState();
      }
      this.renderBlueprintPanel();
    } catch (err) {
      console.warn('[ChiefChatAdapter] Failed to restore blueprint state:', err);
    }
  }

  private getOrchestrator(): ChiefOrchestrator {
    if (!this.orchestrator) {
      this.orchestrator = new ChiefOrchestrator(this.mode === 'auto');
    }
    return this.orchestrator;
  }

  public getMode(): 'manual' | 'auto' {
    return this.mode;
  }

  public setMode(mode: 'manual' | 'auto') {
    this.mode = mode;
    if (this.orchestrator) this.orchestrator.setAutopilot(mode === 'auto');
    this.persistBlueprintState();
    this.renderBlueprintPanel();
  }


  /**
   * Every chat turn now goes through classification first: is this ordinary discussion,
   * or a concrete "create/edit/fix/debug this" request? Code requests are dispatched
   * straight to the dev agents and land as real writes in the editor/file tree/Supabase —
   * not just described in the chat bubble. Pure discussion still gets a normal
   * conversational reply, and the Chief asks only the minimum necessary clarifying
   * questions before proposing a plan.
   */
  public async handleUserQuery(userQuery: string): Promise<string> {
    this.conversation.push(`User: ${userQuery}`);
    this.persistConversation();
    try {
      // Once Chief has proposed a blueprint in chat, a simple affirmative response is the
      // explicit approval to turn that proposal into a sticky, executable draft.
      if (this.awaitingBlueprintConfirmation && /^(yes|yeah|yep|sure|ok|okay|agreed|agree|confirm|confirmed|draft it|go ahead|do it|looks good|approved)\b/i.test(userQuery.trim())) {
        this.awaitingBlueprintConfirmation = false;
        const blueprint = await this.generateBlueprint();
        const reply = blueprint.length > 0
          ? 'Done — I drafted the blueprint above. Nothing has started yet. Choose one of the three execution options in the blueprint panel when you are ready.'
          : 'I could not draft the blueprint yet. I will keep the discussion intact so we can try again.';
        this.conversation.push(`Chief: ${reply}`);
        this.persistConversation();
        return reply;
      }

      const orchestrator = this.getOrchestrator();
      const classification = await orchestrator.classifyAndPlan(userQuery, this.conversation.join('\n'));

      if (classification.mode === 'blueprint_proposal') {
        this.awaitingBlueprintConfirmation = true;
      }

      if (classification.mode === 'code_task') {
        if (typeof (window as any).showToast === 'function') {
          const plural = classification.tasks.length === 1 ? 'file' : 'files';
          (window as any).showToast(`Chief is editing ${classification.tasks.length} ${plural}...`, 'info');
        }

        const results = await orchestrator.executeQuickTasks(classification.tasks);
        const reply = this.formatQuickTaskReply(classification.tasks, results);
        this.conversation.push(`Chief: ${reply}`);
        this.persistConversation();
        return reply;
      }

      const reply = classification.reply;
      this.conversation.push(`Chief: ${reply}`);
      this.persistConversation();
      return reply;
    } catch (error: any) {
      this.maybePromptForKeys(error);
      const authExplanation = explainGeminiAuthError(error);
      return `Chief Error: ${authExplanation || error.message}`;
    } finally {
      this.updateGenerateBlueprintButton();
    }
  }

  /** Builds a human-readable chat reply summarizing a quick-task batch's outcome. */
  private formatQuickTaskReply(tasks: QuickTask[], results: QuickTaskResult[]): string {
    const lines = tasks.map((t, i) => {
      const r = results[i];
      const icon = r?.success ? '✅' : '⚠️';
      // Surface the REAL reason inline (the ReAct loop's actual last observation, or its
      // finish summary) instead of a generic wrapper — every past failure here read as the
      // exact same boilerplate ("ran into trouble... check the Logs tab") no matter what
      // actually went wrong, which made a syntax error, a rejected review, a failed real
      // test run, and simply running out of turns on a large file all look identical.
      const reason = r?.summary ? `\n   ${r.success ? '' : '→ '}${r.summary}` : '';
      const retriedNote = r?.retried ? (r.success ? ' (fixed on autopilot retry)' : ' (failed again after 1 autopilot retry)') : '';
      return `${icon} \`${t.targetFile}\` — ${t.instruction}${retriedNote}${reason}`;
    });
    const allOk = results.every((r) => r.success);
    const anyAutoRetried = results.some((r) => r.retried);
    const header = allOk
      ? "Done — I've made those changes directly in the editor:"
      : anyAutoRetried
      ? 'I tried this twice (autopilot auto-retry) and still hit trouble on one or more files:'
      : 'I made progress, but ran into trouble on one or more files:';
    const footer = allOk
      ? 'Everything passed syntax checks and code review, and I saved a checkpoint you can revert to if needed.'
      : "You can ask me to try again, give more detail, or point me at what's still wrong. If this is a larger architectural change, we can discuss it further and I’ll propose a blueprint when the requirements are clear enough.";
    return `${header}\n\n${lines.join('\n')}\n\n${footer}`;
  }

  private maybePromptForKeys(error: any) {
    if (
      typeof window !== 'undefined' &&
      typeof (window as any).openApiKeysModal === 'function' &&
      /Missing API key/i.test(error?.message || '')
    ) {
      (window as any).openApiKeysModal();
    }
  }

  public hasConversation(): boolean {
    return this.conversation.length > 0;
  }

  public getBlueprint(): StepBlueprint[] {
    return this.blueprint;
  }

  private updateGenerateBlueprintButton() { /* Blueprint generation is now Chief-driven from chat. */ }

  /**
   * Turns the agreed discussion into a sticky blueprint DRAFT. Drafting never executes work;
   * the user must explicitly choose Auto-pilot, step-by-step confirmation, or cancel.
   */
  public async generateBlueprint(): Promise<StepBlueprint[]> {
    if (this.isBusy) return this.blueprint;
    this.isBusy = true;
    this.updateGenerateBlueprintButton();

    try {
      const summary =
        this.conversation.length > 0
          ? this.conversation.join('\n')
          : 'No prior discussion captured. Infer a small, reasonable general-purpose starter project.';

      const orchestrator = this.getOrchestrator();
      const blueprint = await orchestrator.generateBlueprint(summary);
      this.blueprint = blueprint;
      this.cancelled = false;
      this.finalized = false;
      this.paused = false;
      this.pauseRequested = false;
      this.isRunningStep = false;
      orchestrator.resetCancellation();

      // No checkpoint and no execution at draft time. A checkpoint is created only when the
      // user explicitly authorizes execution, which avoids noisy checkpoint failures for drafts.
      this.blueprintDecisionPending = true;
      this.persistBlueprintState();
      this.renderBlueprintPanel();
      return blueprint;
    } catch (error: any) {
      this.maybePromptForKeys(error);
      const authExplanation = explainGeminiAuthError(error);
      if (typeof (window as any).showToast === 'function') {
        (window as any).showToast(`Blueprint generation failed: ${authExplanation || this.humanizeError(error)}`, 'error');
      }
      return [];
    } finally {
      this.isBusy = false;
      this.updateGenerateBlueprintButton();
    }
  }

  public isBlueprintDecisionPending(): boolean {
    return this.blueprintDecisionPending;
  }

  private async beginBlueprintExecution(mode: 'manual' | 'auto'): Promise<void> {
    if (this.blueprint.length === 0 || !this.blueprintDecisionPending || this.isBusy || this.blueprintExecutionActive) return;
    this.blueprintDecisionPending = false;
    this.mode = mode;
    // Do NOT pre-set this for 'auto' here — runAllSteps() below owns this flag and guards
    // its own re-entrancy with `if (this.blueprintExecutionActive || this.isRunningStep) return;`.
    // Setting it true here before calling runAllSteps() made that guard trip immediately,
    // so autopilot returned without ever running Step 1 (or any step). Leave it false and
    // let runAllSteps() set/clear it around the loop it actually runs.
    this.blueprintExecutionActive = false;
    this.persistBlueprintState();
    this.getOrchestrator().setAutopilot(mode === 'auto');
    this.getOrchestrator().resetCancellation();
    const checkpointOk = await this.getOrchestrator().createCheckpoint(ChiefChatAdapter.BASELINE_CHECKPOINT_ID);
    if (!checkpointOk) {
      this.blueprintDecisionPending = true;
      this.blueprintExecutionActive = false;
      this.renderBlueprintPanel();
      if (typeof (window as any).showToast === 'function') {
        (window as any).showToast('Execution was not started because the initial checkpoint could not be created.', 'error');
      }
      await this.persistBlueprintState();
      return;
    }
    this.hasInitialCheckpoint = true;
    this.cancelled = false;
    // Create a durable pre-blueprint commit as a second recovery layer. CommitManager has a
    // local fallback, so a temporary Supabase failure must never block execution.
    try {
      const commitManager = (await import('../engine/active-project')).getActiveCommitManager();
      if (commitManager) {
        await commitManager.createCommit('Blueprint baseline — before execution', 'auto');
      }
    } catch (error: any) {
      await import('../lib/supabase/logger').then(({ logReActStep }) => logReActStep({
        stepId: ChiefChatAdapter.BASELINE_CHECKPOINT_ID, agentId: 'chief',
        thought: `Baseline commit could not be created remotely; checkpoint remains the primary recovery point: ${error?.message || error}`,
        action: 'create_commit', status: 'failed'
      })).catch(() => undefined);
    }
    await this.persistBlueprintState();
    this.paused = false;
    this.persistBlueprintState();
    this.renderBlueprintPanel();
    if (mode === 'auto') await this.runAllSteps();
  }

  public async acceptBlueprintAutopilot(): Promise<void> {
    await this.beginBlueprintExecution('auto');
  }

  public async acceptBlueprintManual(): Promise<void> {
    await this.beginBlueprintExecution('manual');
  }

  public cancelBlueprintDraft(): void {
    this.blueprint = [];
    this.blueprintExecutionActive = false;
    this.blueprintDecisionPending = false;
    this.awaitingBlueprintConfirmation = false;
    void BlueprintSync.clear();
    this.renderBlueprintPanel();
  }

  /** Runs a single step by index (used internally by manual + autopilot flows). */
  private async runStep(stepIndex: number): Promise<void> {
    if (this.cancelled || this.isRunningStep) return;
    const step = this.blueprint[stepIndex];
    if (!step || step.status === 'completed') return;

    step.status = 'in_progress';
    this.isRunningStep = true;
    this.renderBlueprintPanel();
    await this.persistBlueprintState();

    const orchestrator = this.getOrchestrator();
    let success = false;
    try {
      success = await orchestrator.executeStep(step);
    } catch (error: any) {
      this.maybePromptForKeys(error);
      success = false;
    } finally {
      // The step has now genuinely finished (write + review + checks all settled) — this is
      // the only point a Pause request is allowed to take effect, so already-completed work
      // is never interrupted mid-write.
      this.isRunningStep = false;
    }

    if (this.cancelled) return;

    if (success) {
      // executeStep() is the sole authoritative completion gate. Duplicate consensus
      // verification was removed here so the engine has one source of truth for syntax,
      // integration, runtime and commit state.
      step.status = 'completed';
    } else {
      step.status = 'failed';
    }
    await this.persistBlueprintState();

    // Apply a pending pause request now that the step is fully done. A failed step already
    // halts the autopilot loop on its own (see runAllSteps), so there's nothing meaningful to
    // "pause" in that case — just clear the request.
    if (this.pauseRequested) {
      this.pauseRequested = false;
      const hasMorePendingWork = this.blueprint.some((s) => s.status !== 'completed' && s.status !== 'failed');
      if (step.status !== 'failed' && hasMorePendingWork) {
        this.paused = true;
        if (typeof (window as any).showToast === 'function') {
          (window as any).showToast('Paused — remaining steps have not run. Resume, edit the next step, or cancel & revert.', 'info');
        }
      }
    }

    this.persistBlueprintState();
    this.renderBlueprintPanel();
    if (!this.paused) {
      await this.maybeRunFinalQA();
    }
  }

  /**
   * Once every step in the blueprint is completed, run the whole-project final QA pass
   * exactly once (autonomous-coding-agent style: don't stop the moment the last step's own
   * checks pass — step back and validate the finished project against the original goal).
   */
  private async maybeRunFinalQA(): Promise<void> {
    if (this.finalized || this.cancelled || this.blueprint.length === 0) return;
    const allCompleted = this.blueprint.every((s) => s.status === 'completed');
    if (!allCompleted) return;

    this.finalized = true;
    if (typeof (window as any).showToast === 'function') {
      (window as any).showToast('All steps complete — running final whole-project QA pass...', 'info');
    }
    try {
      await this.getOrchestrator().finalizeProject(this.conversation.join('\n'));
    } catch (error: any) {
      this.maybePromptForKeys(error);
      console.warn('[ChiefChatAdapter] Final QA pass failed:', error);
    }
    await this.persistBlueprintState();
    if (typeof (window as any).showToast === 'function') {
      (window as any).showToast('Final QA pass complete.', 'success');
    }
    this.renderBlueprintPanel();
  }

  /** Runs all remaining steps sequentially — used by autopilot mode. */
  public async runAllSteps(): Promise<void> {
    if (this.blueprintExecutionActive || this.isRunningStep) return;
    this.blueprintExecutionActive = true;
    try {
      for (let i = 0; i < this.blueprint.length; i++) {
        if (this.cancelled || this.paused) break;
        if (this.blueprint[i].status === 'completed') continue;
        await this.runStep(i);
        if (this.cancelled || this.paused || this.blueprint[i].status === 'failed') break;
      }
    } finally {
      this.blueprintExecutionActive = false;
      await this.persistBlueprintState();
    }
  }

  /** Manual mode: runs only the next pending step, then waits for the user again. */
  public async runNextStep(): Promise<void> {
    if (this.paused || this.blueprintDecisionPending || !this.hasInitialCheckpoint || this.isRunningStep || this.blueprintExecutionActive) return;
    const nextIndex = this.blueprint.findIndex((s) => s.status === 'pending');
    if (nextIndex === -1) return;
    this.blueprintExecutionActive = true;
    try { await this.runStep(nextIndex); } finally { this.blueprintExecutionActive = false; this.persistBlueprintState(); }
  }

  public isPaused(): boolean {
    return this.paused;
  }

  /** True while a step is actively executing — used to distinguish "pausing…" from "paused". */
  public isRunning(): boolean {
    return this.isRunningStep;
  }

  public getNextPendingStepIndex(): number {
    return this.blueprint.findIndex((s) => s.status === 'pending');
  }

  /**
   * Requests a pause. If a step is currently executing, this only takes effect once that step
   * genuinely finishes (see runStep) — never mid-write. If nothing is currently executing
   * (e.g. manual mode sitting idle between steps), there's no in-flight work to wait on, so
   * the pause applies immediately.
   */
  public requestPause(): void {
    if (this.cancelled || this.paused || this.blueprint.length === 0) return;
    if (this.isRunningStep) {
      this.pauseRequested = true;
    } else {
      const hasMorePendingWork = this.blueprint.some((s) => s.status !== 'completed' && s.status !== 'failed');
      if (hasMorePendingWork) this.paused = true;
    }
    this.renderBlueprintPanel();
    void this.persistBlueprintState();
  }

  /** Resumes from a paused state as-planned: continues autopilot automatically, or just re-enables manual "Run Next Step". */
  public async resumeProject(): Promise<void> {
    if (!this.paused) return;
    this.paused = false;
    this.renderBlueprintPanel();
    await this.persistBlueprintState();
    if (this.mode === 'auto') {
      void this.runAllSteps();
    }
  }

  /** Current instruction text for a subtask, for prefilling the edit prompt. Null if not found. */
  public getSubtaskInstruction(stepId: number, subtaskId: string): string | null {
    const step = this.blueprint.find((s) => s.stepId === stepId);
    const subtask = step?.subtasks.find((s) => s.id === subtaskId);
    return subtask ? subtask.task : null;
  }

  /**
   * Redirects a single subtask's instructions before it runs. Only allowed on the NEXT
   * pending step (the one that would run next) — editing anything already completed, in
   * progress, or further out in the plan isn't what "redirect the next step" means, and
   * changing a step that already ran wouldn't do anything since its checkpoint/commit is
   * already made.
   */
  public editNextStepSubtask(subtaskId: string, newTask: string): boolean {
    const trimmed = newTask.trim();
    if (!trimmed) return false;
    const nextIndex = this.getNextPendingStepIndex();
    if (nextIndex === -1) return false;
    const step = this.blueprint[nextIndex];
    if (step.status !== 'pending') return false; // never edit a step that's already running or done
    const subtask = step.subtasks.find((s) => s.id === subtaskId);
    if (!subtask) return false;
    subtask.task = trimmed;
    this.persistBlueprintState();
    this.renderBlueprintPanel();
    return true;
  }

  /**
   * Replans the remaining (not-yet-completed) work using whatever the user has discussed
   * with Chief since pausing. This is the ONLY way to change the plan mid-execution — there
   * is deliberately no separate "pause and replan" entry point; pausing already puts the
   * user in chat with Chief, and this button turns that discussion into an updated plan
   * whenever they're ready, regardless of how long they've been paused or what they typed.
   */
  public async updateBlueprintFromDiscussion(): Promise<void> {
    if (this.blueprint.length === 0 || !this.paused || this.isBusy) return;
    this.isBusy = true;
    try {
      const completed = this.blueprint.filter((s) => s.status === 'completed');
      const replanned = await this.getOrchestrator().generateBlueprint(
        `${this.conversation.join('\n')}\n\nIMPORTANT: The blueprint is already in progress. Keep every completed step exactly as completed. Generate ONLY the remaining work needed after those completed steps, incorporating the user's latest discussion. Do not repeat completed work.`
      );
      replanned.forEach((step, index) => { step.stepId = completed.length + index + 1; step.status = 'pending'; });
      this.blueprint = [...completed, ...replanned];
      this.paused = false;
      this.pauseRequested = false;
      await this.persistBlueprintState();
      this.renderBlueprintPanel();
      if (typeof (window as any).showToast === 'function') (window as any).showToast('Remaining blueprint updated. Resuming execution.', 'success');
      if (this.mode === 'auto') void this.runAllSteps();
    } catch (error: any) {
      if (typeof (window as any).showToast === 'function') (window as any).showToast(`Replan failed: ${this.humanizeError(error)}`, 'error');
    } finally {
      this.isBusy = false;
    }
  }

  /** Cancels execution and rolls the workspace back to how it was before the blueprint started. */
  public async cancelProject(): Promise<void> {
    this.cancelled = true;
    this.paused = false;
    this.pauseRequested = false;
    this.isRunningStep = false;
    const orchestrator = this.getOrchestrator();
    if (this.hasInitialCheckpoint) {
      await orchestrator.cancelAndRollback(ChiefChatAdapter.BASELINE_CHECKPOINT_ID);
    }
    this.blueprint = [];
    this.hasInitialCheckpoint = false;
    this.blueprintDecisionPending = false;
    this.awaitingBlueprintConfirmation = false;
    this.finalized = false;
    this.blueprintExecutionActive = false;
    void BlueprintSync.clear();
    this.renderBlueprintPanel();
    if (typeof (window as any).showToast === 'function') {
      (window as any).showToast('Project reverted to its state before this blueprint started.', 'info');
    }
  }

  private shouldShowActionDock(hasPendingStep: boolean, nextIndex: number): boolean {
    return Boolean(
      this.blueprintDecisionPending ||
      this.paused ||
      (this.mode === 'manual' && hasPendingStep && !this.isRunningStep && nextIndex !== -1)
    );
  }

  private humanizeError(error: any): string {
    const raw = String(error?.message || error || 'Unknown error');
    if (/failed to fetch|networkerror|network request failed/i.test(raw)) return 'Theta could not reach the server. Check your connection and try again.';
    if (/401|403|unauthorized|forbidden/i.test(raw)) return 'Theta could not authenticate this request. Please sign in again.';
    if (/quota|resource_exhausted|429/i.test(raw)) return 'The model request limit was reached. Theta will retry when possible.';
    if (/project.*not.*found|not owned/i.test(raw)) return 'Theta could not verify this project belongs to your account.';
    if (/executor.*unavailable/i.test(raw)) return 'The cloud execution environment is unavailable right now; local checks can continue.';
    return raw.length > 220 ? `${raw.slice(0, 217)}…` : raw;
  }

  /** Renders the live blueprint / step-progress panel into #blueprintPanel. */
  private renderBlueprintPanel() {
    if (typeof window === 'undefined') return;
    const panel = document.getElementById('blueprintPanel');
    const stepsContainer = document.getElementById('blueprintSteps');
    if (!panel || !stepsContainer) return;

    if (this.blueprint.length === 0) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');

    const statusStyles: Record<string, string> = {
      pending: 'text-theta-muted border-theta-border',
      in_progress: 'text-amber-400 border-amber-500/40',
      completed: 'text-emerald-400 border-emerald-500/40',
      failed: 'text-red-400 border-red-500/40',
    };

    const statusIcon: Record<string, string> = {
      pending: '○',
      in_progress: '◐',
      completed: '●',
      failed: '✕',
    };

    const nextIndex = this.getNextPendingStepIndex();

    stepsContainer.innerHTML = this.blueprint
      .map(
        (step, index) => {
          // Editing is only offered on the NEXT pending step, and only while paused —
          // redirecting a step that's already running/done isn't meaningful, and outside a
          // pause there's no stable window to edit into before it fires.
          const isEditableNow = this.paused && index === nextIndex && step.status === 'pending';
          return `
      <div class="border rounded-lg p-2 space-y-1 ${statusStyles[step.status]}">
        <div class="flex items-center justify-between text-[11px] font-semibold">
          <span>${statusIcon[step.status]} Step ${step.stepId}: ${this.escapeHtml(step.title)}</span>
          <span class="uppercase text-[9px] tracking-wide">${step.status.replace('_', ' ')}</span>
        </div>
        <div class="h-1 rounded-full bg-theta-bg overflow-hidden"><div class="h-full rounded-full transition-all duration-500 ${step.status === 'completed' ? 'w-full bg-emerald-400' : step.status === 'in_progress' ? 'w-2/3 bg-amber-400 animate-pulse' : step.status === 'failed' ? 'w-full bg-red-400' : 'w-0'}"></div></div>
        <div class="text-[9px] text-theta-muted text-right">${step.subtasks.length} subtask${step.subtasks.length === 1 ? '' : 's'}</div>
        <div class="text-[10px] text-theta-muted space-y-0.5">
          ${step.subtasks
            .map(
              (t) => {
                const truth = getExecutionTruth((window as any).activeProject?.id)
                  .filter((e: any) => e.stepId === step.stepId && e.metadata?.subtaskId === t.id)
                  .sort((a: any, b: any) => String(a.finishedAt || a.startedAt || '').localeCompare(String(b.finishedAt || b.startedAt || '')));
                const latest = truth[truth.length - 1];
                const runtimeStatus = t.runtimeStatus || (latest?.status === 'failed' ? 'failed' : latest?.status === 'dispatched' ? 'working' : 'waiting');
                const statusMap: any = { waiting: ['WAITING','text-theta-muted'], working: ['WORKING','text-amber-300'], retrying: ['RETRYING','text-orange-300'], completed: ['DONE','text-emerald-300'], failed: ['FAILED','text-rose-300'] };
                const [runtimeLabel, runtimeClass] = statusMap[runtimeStatus] || statusMap.waiting;
                const summary = t.runtimeSummary || latest?.error || '';
                return `<div class="flex items-center justify-between gap-2 py-0.5">
                  <div class="min-w-0">
                    <div class="flex items-center gap-1.5"><span class="text-[9px] font-semibold ${runtimeClass}">${runtimeLabel}</span><span class="truncate">[${t.assignee}] ${this.escapeHtml(t.task)}</span></div>
                    <div class="text-[9px] text-theta-muted truncate ml-10">${this.escapeHtml(t.targetFile)}${summary ? ` — ${this.escapeHtml(summary)}` : ''}</div>
                  </div>
                  ${
                    isEditableNow
                      ? `<button onclick="editBlueprintSubtask(${step.stepId}, '${this.escapeJsString(t.id)}')" title="Edit instructions before this step runs" class="shrink-0 text-theta-muted hover:text-theta-accent">
                          <i data-lucide="pencil" class="w-3 h-3"></i>
                        </button>`
                      : ''
                  }
                </div>`;
              }
            )
            .join('')}
        </div>
        ${
          step.status === 'pending'
            ? ''
            : `<button onclick="viewStepDiff(${step.stepId})" class="text-[10px] font-medium text-theta-accent hover:underline flex items-center gap-1 pt-0.5">
                <i data-lucide="file-diff" class="w-3 h-3"></i> View Diff
              </button>`
        }
      </div>`;
        }
      )
      .join('');

    // "All steps complete" notice — the only completion-state UI; every other control below
    // lives exclusively in the action dock beneath the chat so there's one place, not two,
    // to look for "what can I do right now".
    const doneMsg = document.getElementById('blueprintDoneMsg');
    if (doneMsg) {
      doneMsg.classList.toggle('hidden', nextIndex !== -1);
    }

    // Pause control: offered any time there's still pending work and we're not already
    // paused. While a step is actually executing, clicking it only requests a pause that
    // takes effect once that step finishes — reflected here as a disabled "Pausing…" state.
    // This is the ONLY pause entry point — there is no separate "pause & replan" button;
    // replanning is simply one of the two choices offered once you're paused (see the
    // action dock below).
    const pauseBtn = document.getElementById('blueprintPauseBtn') as HTMLButtonElement | null;
    if (pauseBtn) {
      pauseBtn.classList.toggle('hidden', this.paused || nextIndex === -1);
      pauseBtn.disabled = this.pauseRequested;
      pauseBtn.innerHTML = this.pauseRequested
        ? '<i data-lucide="pause-circle" class="w-3 h-3"></i> Pausing after this step…'
        : '<i data-lucide="pause-circle" class="w-3 h-3"></i> Pause';
    }

    // Every actionable decision (accept the draft, approve the next step, or choose what to
    // do while paused) lives in exactly one place: the action dock below the chat. Only one
    // of its three sub-panels is ever visible at a time.
    const actionDock = document.getElementById('blueprintActionDock');
    if (actionDock) {
      const decision = document.getElementById('chatBlueprintDecisionControls');
      const paused = document.getElementById('chatBlueprintPausedControls');
      const next = document.getElementById('chatBlueprintNextControls');
      const hasPendingStep = nextIndex !== -1;
      decision?.classList.toggle('hidden', !this.blueprintDecisionPending);
      paused?.classList.toggle('hidden', !(this.paused && !this.blueprintDecisionPending));
      next?.classList.toggle('hidden', !(this.mode === 'manual' && !this.paused && !this.blueprintDecisionPending && hasPendingStep && !this.isRunningStep));
      actionDock.classList.toggle('hidden', !this.shouldShowActionDock(hasPendingStep, nextIndex));
    }

    if (typeof (window as any).lucide?.createIcons === 'function') {
      (window as any).lucide.createIcons();
    }
  }

  private escapeHtml(str: string): string {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /** Escapes a value for safe embedding inside a single-quoted string in an inline onclick="" handler. */
  private escapeJsString(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }
}
