import { AgentToolLoop } from '../engine/agent-loop';
import { ConversationSync } from '../lib/supabase/conversation-sync';
import { explainGeminiAuthError } from '../lib/gemini-error';
import { onActiveProjectChanged, getActiveProjectId } from '../engine/active-project';
import { CheckpointEngine } from '../lib/git/checkpoint';
import { formatAgentContextForPrompt, getRecentAgentContext, publishAgentContext, subscribeAgentContext } from '../engine/agent-context';

/**
 * Chief is execution-only. This adapter exists for the existing workspace shell and renders
 * Chief's live execution into the current chat panel. There is no Blueprint approval flow and
 * no Dev 1-4 dispatch.
 */
export class ChiefChatAdapter {
  private conversation: string[] = [];
  private busy = false;
  private cancelled = false;
  private currentRun: AgentToolLoop | null = null;
  private unsubscribeContext?: () => void;

  constructor() {
    if (typeof window !== 'undefined') {
      (window as any).chiefAdapter = this;
      onActiveProjectChanged(() => { void this.rehydrateConversation(); });
      this.unsubscribeContext = subscribeAgentContext((event) => {
        if (event.source === 'miko') {
          window.dispatchEvent(new CustomEvent('theta:chief-context-available', { detail: event }));
        }
      });
      void this.rehydrateConversation();
    }
  }

  private async rehydrateConversation(): Promise<void> {
    try {
      this.conversation = await ConversationSync.load('chief');
      if (this.conversation.length && typeof (window as any).renderRestoredConversation === 'function') {
        (window as any).renderRestoredConversation('chief', this.conversation);
      }
    } catch (error) {
      console.warn('[ChiefChatAdapter] Failed to restore conversation:', error);
    }
  }

  private persistConversation(): void {
    void ConversationSync.save('chief', this.conversation);
  }

  /** Chief has no user-selectable chat model and no manual/auto execution mode. */
  public getMode(): 'auto' {
    return 'auto';
  }

  public setMode(_mode: 'manual' | 'auto'): void {
    // Compatibility no-op. Chief is always autonomous.
  }

  public hasConversation(): boolean {
    return this.conversation.length > 0;
  }

  /** Compatibility surface for old Blueprint UI code. It always returns an empty list. */
  public getBlueprint(): [] {
    return [];
  }

  public isBlueprintDecisionPending(): boolean {
    return false;
  }

  public async generateBlueprint(): Promise<[]> {
    return [];
  }

  /** Compatibility aliases: there is no separate Blueprint execution path anymore. */
  public async startAutopilot(): Promise<void> { return; }
  public async startStepByStep(): Promise<void> { return; }
  public async approveCurrentStep(): Promise<void> { return; }
  public async pause(): Promise<void> { this.cancelled = true; }
  public async resume(): Promise<void> { this.cancelled = false; }
  public async cancel(): Promise<void> { this.cancelled = true; }

  public async handleUserQuery(userQuery: string): Promise<string> {
    this.conversation.push(`User: ${userQuery}`);
    this.persistConversation();

    if (this.busy) {
      const reply = 'Chief is already working on the current task. I will keep the workspace consistent and finish that execution first.';
      this.conversation.push(`Chief: ${reply}`);
      this.persistConversation();
      return reply;
    }

    // Explicitly capture a recovery point before autonomous mutation. The persistent commit
    // system remains the long-lived recovery mechanism; the checkpoint protects this run.
    const checkpointId = Date.now();
    await CheckpointEngine.createCheckpoint(checkpointId).catch(() => false);

    this.busy = true;
    this.cancelled = false;
    try {
      const sharedContext = formatAgentContextForPrompt(
        getRecentAgentContext(getActiveProjectId() ?? undefined, 16, 'chief')
      );
      const objective = `${userQuery}\n\nRelevant observations already shared by Miko or previous execution: \n${sharedContext}`;

      this.currentRun = new AgentToolLoop('chief', checkpointId, 24);
      window.dispatchEvent(new CustomEvent('theta:chief-task-start', { detail: { objective: userQuery, checkpointId } }));

      const result = await this.currentRun.run(objective);
      const reply = result.finished
        ? `Completed.\n\n${result.summary}\n\nExecution model: ${result.model}`
        : `Chief stopped before it could verify the task completely.\n\n${result.summary}\n\nExecution model: ${result.model}`;

      this.conversation.push(`Chief: ${reply}`);
      this.persistConversation();
      publishAgentContext({
        projectId: getActiveProjectId() ?? undefined,
        source: 'chief',
        kind: 'execution',
        text: result.summary,
        metadata: { model: result.model, finished: result.finished, turns: result.turns.length },
      });
      window.dispatchEvent(new CustomEvent('theta:chief-task-complete', { detail: { ...result, checkpointId } }));
      return reply;
    } catch (error: any) {
      this.maybePromptForKeys(error);
      const authExplanation = explainGeminiAuthError(error);
      const reply = `Chief Error: ${authExplanation || error?.message || 'The execution could not be completed.'}`;
      this.conversation.push(`Chief: ${reply}`);
      this.persistConversation();
      publishAgentContext({ projectId: getActiveProjectId() ?? undefined, source: 'chief', kind: 'finding', text: reply });
      return reply;
    } finally {
      this.currentRun = null;
      this.busy = false;
      window.dispatchEvent(new CustomEvent('theta:chief-task-idle'));
    }
  }

  private maybePromptForKeys(error: any) {
    if (typeof window !== 'undefined' && typeof (window as any).openApiKeysModal === 'function' && /Missing API key/i.test(error?.message || '')) {
      (window as any).openApiKeysModal();
    }
  }
}
