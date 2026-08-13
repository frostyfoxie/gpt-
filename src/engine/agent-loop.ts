import { Type } from '@google/genai';
import { LLMClient } from '../lib/llm/unified-client';
import { callWithBackoff } from '../lib/rate-limit';
import { KeyManager } from '../config/keys';
import { ModelManager } from '../config/models';
import { logReActStep } from '../lib/supabase/logger';
import { ToolDispatcher } from '../tools/index';
import { FileSystemTools } from '../tools/file-system-tools';
import { CodeRunnerTools } from '../tools/code-runner-tools';

export type AgentLoopTool = 'list_files' | 'read_file' | 'write_file' | 'research_web' | 'run_tests' | 'finish';

export interface AgentLoopTurn {
  turn: number;
  thought: string;
  tool: AgentLoopTool;
  observation: string;
}

export interface AgentLoopResult {
  finished: boolean;
  summary: string;
  turns: AgentLoopTurn[];
}

/**
 * A general-purpose, Claude-Code-style agentic loop: rather than one giant prompt parsed
 * for a single JSON verdict (how the rest of Theta's Chief prompts work), the model is given
 * a goal and a small fixed toolset, and repeatedly emits ONE tool call at a time:
 *
 *   THOUGHT -> TOOL -> (INPUT / CONTENT) -> [we execute it for real] -> OBSERVATION -> repeat
 *
 * Every tool call is executed against the live workspace (list_files/read_file/write_file)
 * or a real CodeSandbox executor run (run_tests) and the true observation — not a guess — is appended to
 * the transcript before the next turn. This is the same plan -> act -> observe -> reflect
 * shape as Claude's own tool_use/tool_result turns, and it's what lets whole-project QA
 * actually converge: the model sees real compiler/test output between every edit instead of
 * declaring victory off a single static snapshot.
 *
 * Phase 9 note: ReActExecutionLoop (react-loop.ts) now runs this same THOUGHT/TOOL/
 * OBSERVATION shape for actual per-subtask dev-agent execution (previously it was a
 * single-file generate-and-retry cycle; this class was the only place a real tool loop
 * existed). This class is kept as-is rather than folded into react-loop.ts: it solves a
 * genuinely different problem — a free-form, whole-project goal with no fixed target file or
 * acceptance criteria, invoked once per finalizeProject() run — where merging the two would
 * mean bending react-loop.ts's per-subtask contract (targetFile, acceptanceCriteria, a
 * per-file lock scope) around a caller that has none of those. If the two ever do converge,
 * the shared primitive to extract first is the THOUGHT/TOOL/INPUT/CONTENT/PATCH parsing —
 * see ReActExecutionLoop.extractSection, which is currently duplicated here in spirit.
 */
export class AgentToolLoop {
  private ai: LLMClient | null = null;
  /** The pooled key currently backing `ai` (see getClient) — released when run() completes. */
  private currentKey: string | null = null;
  private agentId: string;
  private stepId: number;
  private maxTurns: number;

  constructor(agentId: string = 'chief', stepId: number = 0, maxTurns: number = 6) {
    this.agentId = agentId;
    this.stepId = stepId;
    this.maxTurns = maxTurns;
  }

  /** Phase 3: pulls from the shared key pool instead of a fixed 'chief' key. Phase 10: the
   *  pool it pulls from (Gemini vs OpenRouter) and the client it builds both follow whichever
   *  provider Chief's model currently resolves to. */
  private getClient(): LLMClient {
    if (!this.ai) {
      const model = ModelManager.getModel('chief');
      const provider = ModelManager.getProvider(model);
      const apiKey = KeyManager.getAvailableKey('chief', model, provider);
      this.currentKey = apiKey;
      this.ai = new LLMClient(apiKey, provider);
    }
    return this.ai;
  }

  private static readonly TOOL_SPEC = `Available tools — call exactly ONE per turn:
- list_files: no input needed. Returns every file path currently in the project.
- read_file: INPUT is the file path as plain text (e.g. "src/app.js"). Returns its content.
- write_file: INPUT is the file path as plain text. Put the COMPLETE new file content in the
  CONTENT block below it (no markdown fences). Overwrites the file.
- research_web: INPUT is a focused live-reference question. Prefix with \`tech:\`, \`ui:\`, or \`deep:\`. Use it before deciding on package/API syntax or making a substantial UI/UX decision. It searches current technical documentation and can study public UI inspiration sources, returning source URIs and extracted patterns.
- run_tests: no input needed. Runs the whole project through a real compiler/test pass
  (npm test/build, py_compile+pytest, tsc --noEmit, node --check — auto-detected) on the CodeSandbox executor
  backend and returns the actual stdout/stderr. THIS IS GROUND TRUTH — trust it over your own
  read of the code.
- finish: INPUT is a short summary of the outcome. Ends the loop. Only call this once you've
  actually run run_tests and it passed (or after run_tests is unavailable and you've verified
  the files by reading them back).`;

  private buildPrompt(goal: string, transcript: string, turnNum: number): string {
    return `You are the Chief AI Software Architect running an autonomous debugging/QA pass over a real project, the way Claude Code or Cline would: work in a tight tool-call loop, verify with real execution, and stop only once things actually work.

Goal: ${goal}

${AgentToolLoop.TOOL_SPEC}

Turn ${turnNum} of ${this.maxTurns} max.

Transcript so far:
${transcript || '(nothing yet — start by listing files or running tests to see the current state)'}

Use the provided native function tools for tool calls. Only if native tool calling is unavailable, fall back to the legacy text format below. Do not put tool arguments in prose when a native tool call is available.

Legacy fallback format:
THOUGHT: <1-2 sentences>
TOOL: <list_files|read_file|write_file|research_web|run_tests|finish>
INPUT: <plain text input for the tool, or blank for list_files/run_tests>
CONTENT:
<only for write_file — the complete new file content, no code fences. Omit this line entirely for other tools.>`;
  }

  private extract(text: string, header: string): string {
    const match = text.match(new RegExp(`${header}:\\s*([\\s\\S]*?)(?=\\n[A-Z][A-Z_]*:|$)`));
    return match ? match[1].trim() : '';
  }

  /**
   * Runs the loop until the model calls `finish`, or maxTurns is reached (treated as an
   * incomplete-but-non-fatal result — the caller decides whether to try again later).
   */
  public async run(goal: string): Promise<AgentLoopResult> {
    try {
      return await this.runInner(goal);
    } finally {
      // Release the pooled key this run claimed (see KeyManager's inUse doc) now that this
      // (possibly multi-turn) run is fully done, regardless of how it finished.
      if (this.currentKey) {
        KeyManager.releaseKey(this.currentKey);
      }
    }
  }

  private async runInner(goal: string): Promise<AgentLoopResult> {
    const model = ModelManager.getModel('chief');
    const turns: AgentLoopTurn[] = [];
    let transcript = '';

    for (let turnNum = 1; turnNum <= this.maxTurns; turnNum++) {
      const prompt = this.buildPrompt(goal, transcript, turnNum);
      const response = await callWithBackoff<any>(() =>
        this.getClient().models.generateContent({
          model,
          contents: prompt,
          config: {
            tools: [{ functionDeclarations: [
              { name: 'list_files', description: 'List project files.', parameters: { type: Type.OBJECT, properties: {} } },
              { name: 'read_file', description: 'Read a project file.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } }, required: ['input'] } },
              { name: 'write_file', description: 'Write a complete project file.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING }, content: { type: Type.STRING } }, required: ['input', 'content'] } },
              { name: 'research_web', description: 'Research current technical/UI references.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } }, required: ['input'] } },
              { name: 'run_tests', description: 'Run project verification.', parameters: { type: Type.OBJECT, properties: {} } },
              { name: 'finish', description: 'Finish the task.', parameters: { type: Type.OBJECT, properties: { input: { type: Type.STRING } } } },
            ] }]
          }
        })
      );
      const nativeCall = Array.isArray((response as any).functionCalls) ? (response as any).functionCalls[0] : null;
      const raw = response.text || '';
      const nativeArgs = nativeCall?.args && typeof nativeCall.args === 'object' ? nativeCall.args : {};
      const thought = nativeCall ? (raw || `Native tool call: ${nativeCall.name}`) : (this.extract(raw, 'THOUGHT') || '(no thought given)');
      const tool = (nativeCall?.name || this.extract(raw, 'TOOL').toLowerCase().trim() || 'finish') as AgentLoopTool;
      const input = String(nativeArgs.input ?? this.extract(raw, 'INPUT') ?? '');
      const content = String(nativeArgs.content ?? this.extract(raw, 'CONTENT') ?? '');

      let observation: string;

      switch (tool) {
        case 'list_files': {
          const files = FileSystemTools.listAllFiles();
          observation = files.length > 0 ? files.join('\n') : '(project is empty)';
          break;
        }
        case 'read_file': {
          const res = await ToolDispatcher.dispatch({ toolName: 'read_file', filePath: input, agentId: this.agentId, stepId: this.stepId });
          observation = res.success ? res.output : `Error: ${res.error}`;
          break;
        }
        case 'write_file': {
          if (!input || !content.trim()) {
            observation = 'Error: write_file needs both a file path in INPUT and full content in CONTENT.';
            break;
          }
          const res = await ToolDispatcher.dispatch({ toolName: 'write_file', filePath: input, content, agentId: this.agentId, stepId: this.stepId });
          observation = res.success ? `Wrote ${input} (${content.length} chars).` : `Error: ${res.error}`;
          break;
        }
        case 'research_web': {
          if (!input) {
            observation = 'research_web requires a focused research question.';
            break;
          }
          const res = await ToolDispatcher.dispatch({
            toolName: 'research_web',
            pattern: input,
            agentId: this.agentId,
            stepId: this.stepId,
          });
          observation = res.success ? res.output || '(no research observations returned)' : `Web research failed: ${res.error}`;
          break;
        }

        case 'run_tests': {
          const check = await CodeRunnerTools.runStrictCheck(FileSystemTools.listAllFilesWithContent(), { stepId: this.stepId, agentId: this.agentId });
          if (!check.ranInSandbox) {
            observation = `(Real executor unavailable. Reported: ${check.output})`;
          } else {
            observation = check.success ? `PASSED.\n${check.output}` : `FAILED.\n${check.error}`;
          }
          break;
        }
        case 'finish':
        default: {
          const summary = input || content || 'Loop finished.';
          turns.push({ turn: turnNum, thought, tool: 'finish', observation: summary });
          await logReActStep({
            stepId: this.stepId,
            agentId: this.agentId,
            thought: `Agent tool loop finished after ${turnNum} turn(s): ${summary}`,
            action: 'complete_step',
            status: 'success',
          });
          return { finished: true, summary, turns };
        }
      }

      turns.push({ turn: turnNum, thought, tool, observation });
      transcript += `\nTHOUGHT: ${thought}\nTOOL: ${tool}${input ? `\nINPUT: ${input}` : ''}\nOBSERVATION: ${observation}\n`;
    }

    return { finished: false, summary: `Reached the ${this.maxTurns}-turn limit without calling finish.`, turns };
  }
}
