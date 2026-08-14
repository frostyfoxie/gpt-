import { LLMClient } from '../lib/llm/unified-client';
import { callWithBackoff } from '../lib/rate-limit';
import { KeyManager } from '../config/keys';
import { ModelManager } from '../config/models';
import { CheckpointEngine } from '../lib/git/checkpoint';
import { AgentToolLoop } from './agent-loop';
import { getActiveCommitManager } from './active-project';

/**
 * Legacy UI-facing type retained temporarily so older UI code can compile while the new
 * execution UI is rolled out. It is NOT an execution plan and it contains no Dev-agent lane.
 */
export interface StepBlueprint {
  stepId: number;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  subtasks: {
    id: string;
    assignee: 'chief';
    task: string;
    targetFile: string;
    acceptanceCriteria?: string[];
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
  summary: string;
  retried?: boolean;
}

export type ClassificationResult =
  | { mode: 'discussion'; reply: string }
  | { mode: 'code_task'; tasks: QuickTask[] };

/**
 * ChiefOrchestrator is now a thin compatibility facade around ONE autonomous Chief.
 * There is no blueprint generation, no parallel Dev dispatch, and no cross-agent synthesis.
 * The real intelligence lives in AgentToolLoop, which receives a user objective and owns the
 * inspect -> act -> observe -> verify loop.
 */
export class ChiefOrchestrator {
  private ai: LLMClient | null = null;
  private currentKey: string | null = null;
  private isCancelled = false;

  private getClient() {
    if (!this.ai) {
      const model = ModelManager.getModel('miko');
      const provider = ModelManager.getProvider(model);
      this.currentKey = KeyManager.getAvailableKey('miko', model, provider);
      this.ai = new LLMClient(this.currentKey, provider);
    }
    return this.ai;
  }

  public setAutopilot(_enabled: boolean): void {
    // Kept as a harmless compatibility no-op. Chief is always autonomous now.
  }

  public resetCancellation(): void {
    this.isCancelled = false;
  }

  public cancel(): void {
    this.isCancelled = true;
  }

  public async discussWithUser(userPrompt: string): Promise<string> {
    const response = await callWithBackoff<any>(() => this.getClient().models.generateContent({
      model: ModelManager.getModel('miko'),
      contents: `You are the conversational side of Theta. The user said:\n\n${userPrompt}\n\nRespond naturally and concisely. Do not create a blueprint. If the user is asking to change/build/fix the project, explain the intended objective clearly enough for Chief to execute it, but do not claim that you changed code.`,
    }));
    if (this.currentKey) {
      KeyManager.releaseKey(this.currentKey);
      this.currentKey = null;
      this.ai = null;
    }
    return response.text || 'I understand the request.';
  }

  /**
   * Classifies a chat turn. A concrete engineering request becomes ONE Chief objective; it is
   * never decomposed into parallel Dev tasks or a user-approved blueprint.
   */
  public async classifyAndPlan(userPrompt: string, conversation: string): Promise<ClassificationResult> {
    const response = await callWithBackoff<any>(() => this.getClient().models.generateContent({
      model: ModelManager.getModel('miko'),
      contents: `Classify this Theta chat turn.\n\nConversation:\n${conversation}\n\nLatest user message:\n${userPrompt}\n\nReturn JSON only:\n{"mode":"discussion","reply":"..."}\nor\n{"mode":"code_task","tasks":[{"targetFile":"*","instruction":"the complete objective Chief should execute","acceptanceCriteria":[]}]}.\n\nUse code_task for requests to create, edit, fix, debug, refactor, test, run, configure, or otherwise materially change the project. For code_task, targetFile may be "*" because Chief itself discovers the relevant files. Do not create a blueprint or split work among agents.`,
    }));

    try {
      const raw = response.text || '';
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match ? match[0] : raw) as ClassificationResult;
      if (parsed.mode === 'code_task' && Array.isArray(parsed.tasks)) return parsed;
      if (parsed.mode === 'discussion') return parsed;
    } catch {
      // Fall through to the safe heuristic below.
    } finally {
      if (this.currentKey) {
        KeyManager.releaseKey(this.currentKey);
        this.currentKey = null;
        this.ai = null;
      }
    }

    const isCode = /\b(build|create|make|add|implement|fix|debug|refactor|change|edit|remove|delete|update|test|run|configure|deploy|integrate)\b/i.test(userPrompt);
    return isCode
      ? { mode: 'code_task', tasks: [{ targetFile: '*', instruction: userPrompt, acceptanceCriteria: [] }] }
      : { mode: 'discussion', reply: response.text || 'I understand.' };
  }

  /**
   * Kept only as a migration compatibility method. New Chief never calls it. Returning an
   * empty array makes it impossible for the old blueprint UI to accidentally start Dev work.
   */
  public async generateBlueprint(_projectSummary: string): Promise<StepBlueprint[]> {
    return [];
  }

  public async createCheckpoint(stepId: number): Promise<boolean> {
    return CheckpointEngine.createCheckpoint(stepId);
  }

  /** Execute one objective through the same single Chief loop used everywhere else. */
  public async executeQuickTasks(tasks: QuickTask[]): Promise<QuickTaskResult[]> {
    if (this.isCancelled) return tasks.map((task) => ({ file: task.targetFile, success: false, summary: 'Chief execution was cancelled.' }));
    if (!tasks.length) return [];

    const objective = tasks.map((task) => {
      const criteria = task.acceptanceCriteria?.length ? `\nAcceptance criteria:\n- ${task.acceptanceCriteria.join('\n- ')}` : '';
      return `${task.instruction}${criteria}`;
    }).join('\n\n');

    const checkpointId = Date.now();
    await CheckpointEngine.createCheckpoint(checkpointId).catch(() => false);
    try {
      const commitManager = getActiveCommitManager();
      if (commitManager) await commitManager.createCommit('Chief baseline — before autonomous execution', 'auto');
    } catch {
      // Checkpoint remains the primary recovery mechanism.
    }

    const runner = new AgentToolLoop('chief', checkpointId, 24);
    const result = await runner.run(objective);
    const success = result.finished && !/failed|error|blocked|could not|unable/i.test(result.summary);

    return tasks.map((task) => ({
      file: task.targetFile,
      success,
      summary: `${result.summary}\nExecution model: ${result.model}`,
    }));
  }

  /** Legacy entry point: now runs the whole step as one Chief objective, never in parallel. */
  public async executeStep(step: StepBlueprint): Promise<boolean> {
    if (this.isCancelled) return false;
    step.status = 'in_progress';
    const objective = `${step.title}\n${step.subtasks.map((s) => s.task).join('\n')}`;
    const runner = new AgentToolLoop('chief', step.stepId, 24);
    const result = await runner.run(objective);
    step.status = result.finished ? 'completed' : 'failed';
    return result.finished;
  }
}
