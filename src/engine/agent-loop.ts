import { Type } from '@google/genai';
import { LLMClient } from '../lib/llm/unified-client';
import { callWithBackoff } from '../lib/rate-limit';
import { KeyManager } from '../config/keys';
import { ModelManager } from '../config/models';
import { logReActStep } from '../lib/supabase/logger';
import { ToolDispatcher } from '../tools/index';
import { FileSystemTools } from '../tools/file-system-tools';
import { CodeRunnerTools } from '../tools/code-runner-tools';

export type AgentLoopTool =
  | 'list_files'
  | 'read_file'
  | 'write_file'
  | 'grep'
  | 'glob'
  | 'research_web'
  | 'run_command'
  | 'run_tests'
  | 'behavior_check'
  | 'finish';

export interface AgentLoopTurn {
  turn: number;
  thought: string;
  tool: AgentLoopTool;
  input?: string;
  observation: string;
  model: string;
}

export interface AgentLoopResult {
  finished: boolean;
  summary: string;
  turns: AgentLoopTurn[];
  model: string;
}

/**
 * Chief's core execution primitive.
 *
 * There is deliberately no blueprint, sub-agent assignment, parallel Dev lane, or fixed
 * target-file contract here. Chief receives an objective and repeatedly chooses the next
 * action from the live workspace. Every action is executed for real and its observation is
 * fed back into the next model turn.
 */
export class AgentToolLoop {
  private ai: LLMClient | null = null;
  private currentKey: string | null = null;
  private model: string;
  private agentId: string;
  private stepId: number;
  private maxTurns: number;

  constructor(agentId: string = 'chief', stepId: number = 0, maxTurns: number = 24) {
    this.agentId = agentId;
    this.stepId = stepId;
    this.maxTurns = maxTurns;
    this.model = ModelManager.chooseChiefExecutionModel('');
  }

  private getClient(goal: string): LLMClient {
    if (!this.ai) {
      this.model = ModelManager.chooseChiefExecutionModel(goal);
      const provider = ModelManager.getProvider(this.model);
      this.currentKey = KeyManager.getAvailableKey('chief', this.model, provider);
      this.ai = new LLMClient(this.currentKey, provider);
    }
    return this.ai;
  }

  private static readonly TOOL_SPEC = `Available tools. Choose exactly ONE action per turn.

- list_files: inspect the complete current project tree.
- read_file: read one file exactly as it currently exists.
- grep: search file contents using a regex; optionally restrict by path glob.
- glob: find files by a glob pattern.
- write_file: create or replace one file with the supplied complete content. Use this only after inspecting the relevant code.
- research_web: perform live web research. Prefix input with tech:, ui:, or deep:. Use this for current documentation, URL references, APIs, framework behavior, and design inspiration.
- run_command: execute one real shell command in the sandbox against the current project. Use it for package manager commands, builds, targeted tests, generators, git inspection, etc.
- run_tests: run the project's automatic compiler/test pass in the real executor when available.
- behavior_check: run the real headless browser/runtime verification when the project is browsable. Provide acceptance criteria or a concise description of the behavior to verify.
- finish: end execution only when the user's objective is actually satisfied or when a genuine external blocker makes further progress impossible. Summarize evidence.

Do not invent tool results. Inspect first, act deliberately, and use execution/behavior evidence before claiming success.`;

  private buildPrompt(goal: string, transcript: string, turnNum: number): string {
    return `You are Chief, Theta's autonomous software engineer. Work like an advanced coding agent: inspect the real repository, decide what needs to happen, make changes, execute them, observe the results, diagnose failures, and iterate until the user's objective is genuinely satisfied.

USER OBJECTIVE:
${goal}

EXECUTION MODEL:
${this.model}

${AgentToolLoop.TOOL_SPEC}

Turn ${turnNum}/${this.maxTurns}.

Important operating rules:
1. There is no pre-written blueprint you must follow. Your plan is internal and may change as evidence changes.
2. You are the sole project mutation authority. Do not delegate coding to Dev 1/2/3/4 and do not refer to those agents.
3. Never claim a change was made without actually writing it.
4. Never claim tests passed without seeing the real result.
5. Read the relevant existing files before replacing them; preserve working behavior unless the user asked to change it.
6. Prefer small, coherent edits and re-read files after important writes.
7. For UI work, use the preview/browser behavior check when possible rather than relying only on compilation.
8. If an approach fails, reason from the actual error and try a different approach instead of repeating the same action.
9. Use web research when current documentation, a supplied URL, or visual/technical inspiration materially affects the task.
10. Finish only when you have evidence that the objective is complete.

TRANSCRIPT OF REAL OBSERVATIONS:
${transcript || '(none yet — begin by inspecting the project)'}

Use native function calling when available. If native calling is unavailable, use this legacy format:
THOUGHT: <brief reasoning>
TOOL: <tool name>
INPUT: <tool input>
CONTENT:
<complete file content only for write_file>`;
  }

  private extract(text: string, header: string): string {
    const match = text.match(new RegExp(`${header}:\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Z_]*:|$)`));
    return match ? match[1].trim() : '';
  }

  private declarations() {
    return [{ functionDeclarations: [
      { name: 'list_files', description: 'List all current project files.', parameters: { type: Type.OBJECT, properties: {} } },
      { name: 'read_file', description: 'Read one current project file.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } }, required: ['input'] } },
      { name: 'grep', description: 'Search project file contents with a regex.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING }, pathGlob: { type: Type.STRING }, maxResults: { type: Type.NUMBER } }, required: ['input'] } },
      { name: 'glob', description: 'Find files matching a glob.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } }, required: ['input'] } },
      { name: 'write_file', description: 'Create or replace one project file.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING }, content: { type: Type.STRING } }, required: ['input', 'content'] } },
      { name: 'research_web', description: 'Research current technical or UI references.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } }, required: ['input'] } },
      { name: 'run_command', description: 'Execute one real shell command in the sandbox.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } }, required: ['input'] } },
      { name: 'run_tests', description: 'Run automatic project verification in the real executor.', parameters: { type: Type.OBJECT, properties: {} } },
      { name: 'behavior_check', description: 'Run real browser/runtime verification.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } }, required: ['input'] } },
      { name: 'finish', description: 'Finish once the objective is genuinely complete.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } }, required: ['input'] } },
    ] }];
  }

  public async run(goal: string): Promise<AgentLoopResult> {
    try {
      return await this.runInner(goal);
    } finally {
      if (this.currentKey) KeyManager.releaseKey(this.currentKey);
    }
  }

  private async runInner(goal: string): Promise<AgentLoopResult> {
    const turns: AgentLoopTurn[] = [];
    let transcript = '';

    for (let turnNum = 1; turnNum <= this.maxTurns; turnNum++) {
      const prompt = this.buildPrompt(goal, transcript, turnNum);
      const response = await callWithBackoff<any>(() => this.getClient(goal).models.generateContent({
        model: this.model,
        contents: prompt,
        config: { tools: this.declarations() },
      }));

      const nativeCall = Array.isArray((response as any).functionCalls) ? (response as any).functionCalls[0] : null;
      const raw = response.text || '';
      const nativeArgs = nativeCall?.args && typeof nativeCall.args === 'object' ? nativeCall.args : {};
      const thought = nativeCall ? (raw || `Chief selected ${nativeCall.name}.`) : (this.extract(raw, 'THOUGHT') || '(no explicit thought)');
      const tool = (nativeCall?.name || this.extract(raw, 'TOOL').toLowerCase().trim() || 'finish') as AgentLoopTool;
      const input = String(nativeArgs.input ?? this.extract(raw, 'INPUT') ?? '');
      const content = String(nativeArgs.content ?? this.extract(raw, 'CONTENT') ?? '');
      const pathGlob = String(nativeArgs.pathGlob ?? '');
      const maxResults = Number(nativeArgs.maxResults ?? 50);

      let observation = '';

      switch (tool) {
        case 'list_files': {
          const files = FileSystemTools.listAllFiles();
          observation = files.length ? files.join('\n') : '(project is empty)';
          break;
        }
        case 'read_file': {
          const result = await ToolDispatcher.dispatch({ toolName: 'read_file', filePath: input, agentId: this.agentId, stepId: this.stepId });
          observation = result.success ? result.output : `ERROR: ${result.error}`;
          break;
        }
        case 'grep': {
          const result = await ToolDispatcher.dispatch({ toolName: 'grep', pattern: input, pathGlob, maxResults, agentId: this.agentId, stepId: this.stepId });
          observation = result.success ? result.output : `ERROR: ${result.error}`;
          break;
        }
        case 'glob': {
          const result = await ToolDispatcher.dispatch({ toolName: 'glob', pattern: input, agentId: this.agentId, stepId: this.stepId });
          observation = result.success ? result.output : `ERROR: ${result.error}`;
          break;
        }
        case 'write_file': {
          if (!input || content.length === 0) {
            observation = 'ERROR: write_file requires a path and complete file content.';
            break;
          }
          const result = await ToolDispatcher.dispatch({ toolName: 'write_file', filePath: input, content, agentId: this.agentId, stepId: this.stepId });
          observation = result.success ? `Wrote ${input} (${content.length} characters).` : `ERROR: ${result.error}`;
          break;
        }
        case 'research_web': {
          const result = await ToolDispatcher.dispatch({ toolName: 'research_web', pattern: input, agentId: this.agentId, stepId: this.stepId });
          observation = result.success ? (result.output || '(research returned no usable observations)') : `ERROR: ${result.error}`;
          break;
        }
        case 'run_command': {
          const result = await CodeRunnerTools.runCommandInSandbox(FileSystemTools.listAllFilesWithContent(), input);
          observation = result.success ? `COMMAND SUCCEEDED\n${result.output}` : `COMMAND FAILED\n${result.error || result.output}`;
          break;
        }
        case 'run_tests': {
          const result = await CodeRunnerTools.runStrictCheck(FileSystemTools.listAllFilesWithContent(), { stepId: this.stepId, agentId: this.agentId });
          observation = result.success ? `VERIFICATION PASSED\n${result.output}` : `VERIFICATION FAILED\n${result.error || result.output}`;
          break;
        }
        case 'behavior_check': {
          const criteria = input.split(/\n+/).map((s) => s.trim()).filter(Boolean);
          const result = await CodeRunnerTools.runBehaviorCheck(FileSystemTools.listAllFilesWithContent(), criteria.length ? criteria : [goal], { stepId: this.stepId, agentId: this.agentId });
          observation = result.success ? `BEHAVIOR CHECK PASSED\n${result.output}` : `BEHAVIOR CHECK FAILED\n${result.error || result.output}`;
          break;
        }
        case 'finish':
        default: {
          const summary = input || content || 'Chief finished without a summary.';
          turns.push({ turn: turnNum, thought, tool: 'finish', input, observation: summary, model: this.model });
          await logReActStep({ stepId: this.stepId, agentId: this.agentId, thought: `Chief finished after ${turnNum} turn(s): ${summary}`, action: 'complete_task', status: 'success' });
          return { finished: true, summary, turns, model: this.model };
        }
      }

      turns.push({ turn: turnNum, thought, tool, input, observation, model: this.model });
      transcript += `\nTURN ${turnNum}\nTHOUGHT: ${thought}\nTOOL: ${tool}\nINPUT: ${input}\nOBSERVATION:\n${observation}\n`;
      await logReActStep({ stepId: this.stepId, agentId: this.agentId, thought, action: tool, status: 'success' });
    }

    return { finished: false, summary: `Chief reached the ${this.maxTurns}-turn safety limit before verification was complete.`, turns, model: this.model };
  }
}
