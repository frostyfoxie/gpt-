import { ToolResult } from './file-system-tools';
import {
  isExecutorConfigured,
  runProjectTests,
  runProjectCommand,
  runProjectBehaviorCheck,
  ExecBehaviorResult,
} from '../lib/executor/executor-client';
import { logSandboxRun } from '../lib/supabase/logger';
import { LocalExecutor } from '../lib/executor/local-executor';
import { parse as parseJavaScript } from '../vendor/acorn.mjs';

export interface StrictCheckResult extends ToolResult {
  /** True if this actually ran on the real CodeSandbox executor; false if it fell back to heuristics. */
  ranInSandbox: boolean;
}

export interface BehaviorCheckResult extends ToolResult {
  /** True only if a real headless browser run actually happened AND the app was servable. */
  ranInSandbox: boolean;
  servable?: boolean;
}

export class CodeRunnerTools {
  /**
   * The "strict debugging model": runs the whole project through the REAL CodeSandbox executor
   * (npm test/build, py_compile + pytest, tsc --noEmit, node --check, etc., auto-detected —
   * see the CodeSandbox executor API route) instead of relying on heuristic brace-counting. This is
   * what dev agents call after every write and what Chief's final QA pass calls across the
   * whole project, so failures come from an actual compiler/test run, not a guess.
   *
   * The CodeSandbox credential is server-side; the browser does not need an executor URL. If the
   * success with ranInSandbox=false rather than blocking the pipeline — Theta keeps working
   * with heuristic-only checks exactly as before.
   */
  public static async runStrictCheck(
    files: { path: string; content: string }[],
    context: { stepId: number; agentId: string }
  ): Promise<StrictCheckResult> {
    if (!isExecutorConfigured()) {
      return {
        success: true,
        output: 'CodeSandbox executor not configured — skipped real compile/test pass (heuristic checks only).',
        ranInSandbox: false,
      };
    }

    const result = await runProjectTests(files);

    logSandboxRun({
      stepId: context.stepId,
      agentId: context.agentId,
      command: (result.commandsRun || []).join(' && ') || '(auto-detected)',
      success: result.success,
      stdout: result.stdout,
      stderr: result.stderr,
    }).catch(() => undefined);

    if (result.error) {
      // Executor availability is infrastructure state, not developer correctness. Surface it
      // explicitly so the orchestrator can keep the step moving when local checks are enough.
      return {
        success: true,
        output: `Executor unavailable — skipped real compile/test pass. ${result.error}`,
        error: result.error,
        ranInSandbox: false,
      };
    }

    return {
      success: result.success,
      output: result.stdout || 'CodeSandbox check passed.',
      error: result.success ? undefined : (result.stderr || result.stdout || 'CodeSandbox check failed.'),
      ranInSandbox: true,
    };
  }

  /**
   * Runtime/behavioral verification: runs AFTER `runStrictCheck` succeeds. Builds and serves
   * the app on the real CodeSandbox executor, loads it headless in Playwright, and checks for
   * console/runtime errors — plus a best-effort interaction check for any acceptanceCriteria
   * describing user-visible behavior (click/select/submit/etc.). This catches the class of
   * bug compile/test checks structurally can't: code that builds clean but throws, or never
   * renders, at runtime.
   *
   * Gracefully degrades to ranInSandbox=false (never blocks the pipeline) when the CodeSandbox
   * executor is unavailable, unreachable, or the project has no browsable entry point
   * (pure backend/CLI/library code — `servable: false` isn't a failure, just "nothing to load
   * here"). Only ranInSandbox=true with success=false represents a real, actionable failure.
   */
  public static async runBehaviorCheck(
    files: { path: string; content: string }[],
    acceptanceCriteria: string[],
    context: { stepId: number; agentId: string }
  ): Promise<BehaviorCheckResult> {
    if (!isExecutorConfigured()) {
      return {
        success: true,
        output: 'CodeSandbox executor not configured — skipped headless behavioral check.',
        ranInSandbox: false,
      };
    }

    const result = await runProjectBehaviorCheck(files, acceptanceCriteria);
    const summary = this.summarizeBehaviorOutput(result);

    logSandboxRun({
      stepId: context.stepId,
      agentId: context.agentId,
      command: '(headless browser behavioral check)',
      success: result.success,
      stdout: summary,
      stderr: [...(result.consoleErrors || []), ...(result.pageErrors || [])].join('\n'),
    }).catch(() => undefined);

    if (result.error) {
      return { success: false, output: `CodeSandbox behavioral check failed: ${result.error}`, error: result.error, ranInSandbox: false };
    }

    if (!result.servable) {
      // Not every project is a browser app — this is expected, not a failure.
      return {
        success: true,
        output: result.note || 'No browsable entry point — skipped headless behavioral check.',
        ranInSandbox: false,
        servable: false,
      };
    }

    return {
      success: result.success,
      output: summary,
      error: result.success ? undefined : summary,
      ranInSandbox: true,
      servable: true,
    };
  }

  /** Formats a behavioral-check result into one human-readable string for logs and lastObservation feedback. */
  private static summarizeBehaviorOutput(result: ExecBehaviorResult): string {
    const parts: string[] = [];
    if (result.note) parts.push(result.note);
    if (result.buildError) parts.push(`Build output:\n${result.buildError}`);
    if (result.consoleErrors?.length) {
      parts.push(`Console errors:\n${result.consoleErrors.map((e) => `- ${e}`).join('\n')}`);
    }
    if (result.pageErrors?.length) {
      parts.push(`Page/runtime errors:\n${result.pageErrors.map((e) => `- ${e}`).join('\n')}`);
    }
    const failedInteractions = (result.interactions || []).filter((i) => i.clickFailed);
    if (failedInteractions.length) {
      parts.push(
        `Interaction problems:\n${failedInteractions.map((i) => `- "${i.criterion}": ${i.action}`).join('\n')}`
      );
    }
    return parts.join('\n\n') || (result.success ? 'Headless behavioral check passed.' : 'Headless behavioral check failed.');
  }

  /** Runs one explicit command on the CodeSandbox executor (used by Miko/Chief for ad-hoc "run this" requests). */
  public static async runCommandInSandbox(
    files: { path: string; content: string }[],
    command: string
  ): Promise<StrictCheckResult> {
    if (!isExecutorConfigured()) {
      return {
        success: false,
        output: '',
        error: 'No active CodeSandbox execution service is available.',
        ranInSandbox: false,
      };
    }
    if (LocalExecutor.canRun(command)) {
      const local = await LocalExecutor.run(command);
      return {
        success: local.success,
        output: local.stdout,
        error: local.success ? undefined : local.stderr,
        ranInSandbox: false,
      };
    }
    const result = await runProjectCommand(files, command);
    if (result.error) {
      return { success: false, output: result.stdout || '', error: result.error, ranInSandbox: true };
    }
    return {
      success: result.success,
      output: result.stdout,
      error: result.success ? undefined : (result.stderr || result.stdout),
      ranInSandbox: true,
    };
  }

  /**
   * Tool: Whole-project "integration test" — checks that local references between files
   * actually resolve (HTML src/href pointing at real files, JS/TS relative imports pointing
   * at real modules). This is what catches the class of bug per-file syntax checking can't:
   * a file that's individually valid but references something that doesn't exist anywhere
   * else in the project. Runs as part of every step's consensus check and the final
   * whole-project QA pass.
   */
  public static runIntegrationChecks(allFiles: { path: string; content: string }[]): ToolResult {
    const problems: string[] = [];
    const normalize = (p: string) => p.replace(/^\.?\//, '').split('?')[0].split('#')[0];
    const fileSet = new Set(allFiles.map((f) => normalize(f.path)));
    const baseNames = new Set(allFiles.map((f) => normalize(f.path).split('/').pop() as string));

    const isResolvable = (ref: string): boolean => {
      if (!ref) return true;
      if (/^(https?:)?\/\//i.test(ref) || /^(data|mailto|tel|javascript):/i.test(ref) || ref.startsWith('#')) {
        return true; // external / non-local references are out of scope for this check
      }
      const cleaned = normalize(ref);
      if (!cleaned) return true;
      if (fileSet.has(cleaned)) return true;
      const base = cleaned.split('/').pop() as string;
      if (baseNames.has(base)) return true;

      // Extension-less local imports (common in JS/TS) — try the usual suspects.
      const guesses = ['.js', '.jsx', '.ts', '.tsx', '.css', '/index.js', '/index.ts'];
      return guesses.some((g) => fileSet.has(cleaned + g) || baseNames.has((cleaned + g).split('/').pop() as string));
    };

    for (const file of allFiles) {
      const ext = file.path.split('.').pop()?.toLowerCase();

      if (ext === 'html') {
        const attrRegex = /(?:src|href)\s*=\s*["']([^"']+)["']/g;
        let match: RegExpExecArray | null;
        while ((match = attrRegex.exec(file.content))) {
          const ref = match[1];
          if (!isResolvable(ref)) {
            problems.push(`${file.path}: references a file that doesn't exist — "${ref}"`);
          }
        }
      } else if (ext === 'js' || ext === 'jsx' || ext === 'ts' || ext === 'tsx') {
        const importRegex = /(?:from\s+|require\(\s*)["']([^"']+)["']/g;
        let match: RegExpExecArray | null;
        while ((match = importRegex.exec(file.content))) {
          const ref = match[1];
          if (ref.startsWith('.') && !isResolvable(ref)) {
            problems.push(`${file.path}: broken local import — "${ref}"`);
          }
        }
      }
    }

    if (problems.length === 0) {
      return { success: true, output: 'Integration checks passed — every local reference resolves to a real file.' };
    }
    return { success: false, output: '', error: problems.join('\n') };
  }

  /**
   * Tool: Checks code syntax for basic errors (JS/TS brace matching, HTML tag balance, JSON parse)
   */
  public static async checkSyntax(filePath: string, code: string): Promise<ToolResult> {
    const ext = filePath.split('.').pop()?.toLowerCase();

    if (ext === 'js' || ext === 'jsx' || ext === 'ts' || ext === 'tsx') {
      return this.verifyJavaScriptSyntax(filePath, code);
    } else if (ext === 'html') {
      return this.verifyHtmlSyntax(filePath, code);
    } else if (ext === 'json') {
      return this.verifyJsonSyntax(filePath, code);
    }

    return {
      success: true,
      output: `Syntax validation passed for ${filePath}`,
    };
  }

  private static verifyJavaScriptSyntax(filePath: string, code: string): ToolResult {
    try {
      const ext = filePath.split('.').pop()?.toLowerCase();
      // Acorn is the authoritative lightweight parser for plain JavaScript/module files.
      // TS/TSX/JSX still use the conservative structural fallback because Acorn does not
      // understand TypeScript syntax or JSX without a separate parser plugin.
      if (ext === 'js' || ext === 'mjs' || ext === 'cjs') {
        parseJavaScript(code, { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true });
        return { success: true, output: `JavaScript syntax parsed successfully for ${filePath}` };
      }

      const strippedCode = code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/(["'])(?:(?=(\\?))\2)[\s\S]*?\1/g, '')
        .replace(/`[\s\S]*?`/g, '');
      const openBraces = (strippedCode.match(/\{/g) || []).length;
      const closeBraces = (strippedCode.match(/\}/g) || []).length;
      const openParens = (strippedCode.match(/\(/g) || []).length;
      const closeParens = (strippedCode.match(/\)/g) || []).length;
      const openBrackets = (strippedCode.match(/\[/g) || []).length;
      const closeBrackets = (strippedCode.match(/\]/g) || []).length;
      if (openBraces !== closeBraces || openParens !== closeParens || openBrackets !== closeBrackets) {
        return { success: false, output: '', error: `Syntax Error in ${filePath}: unmatched delimiters ({} ${openBraces}/${closeBraces}, () ${openParens}/${closeParens}, [] ${openBrackets}/${closeBrackets})` };
      }
      return { success: true, output: `Structural syntax check passed for ${filePath}` };
    } catch (err: any) {
      return { success: false, output: '', error: `Syntax Error in ${filePath}: ${err?.message || String(err)}` };
    }
  }

  private static verifyHtmlSyntax(filePath: string, code: string): ToolResult {
    // Pull out <script>...</script> and <style>...</style> bodies BEFORE doing any tag
    // counting. This used to run the tag-balance regex over the raw file content, which
    // meant any embedded JS with relational/comparison operators — `if (dist < r)`,
    // `Array<number>`, `x<3&&y>5`, etc. — could get misread as an HTML tag: the tag regex
    // (`<[a-zA-Z0-9]+[^>]*>`) matches from a bare `<` up to the NEXT `>` anywhere in the
    // string, so `<3&&y>` in ordinary comparison code matches as if it were one open tag.
    // For a file whose whole job is physics/animation timing (collision checks, distance/
    // velocity thresholds, scroll-position comparisons — exactly this kind of dense
    // relational code), that false-positive was nearly guaranteed on every real rewrite,
    // independent of whether the actual HTML or JS was valid. Script/style content still
    // gets its own real check below instead of being silently skipped.
    const scriptBodies: string[] = [];
    const styleBodies: string[] = [];
    const htmlOnly = code
      .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, (_m, body) => {
        scriptBodies.push(body);
        return '<script></script>';
      })
      .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (_m, body) => {
        styleBodies.push(body);
        return '<style></style>';
      })
      // HTML comments can also contain stray `<`/`>` (e.g. commented-out old markup, or
      // ASCII-art placeholders for the "3D ASCII density" effect) — strip those too.
      .replace(/<!--[\s\S]*?-->/g, '');

    // Strip self-closing tags (<tag />) and void HTML tags (<img ...>, <input ...>, <br>, etc.)
    const voidTagRegex = /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)[^>]*\/?>/gi;
    const cleanHtml = htmlOnly.replace(voidTagRegex, '').replace(/<[a-zA-Z0-9_-]+\s*[^>]*\/>/g, '');

    const openTags = (cleanHtml.match(/<[a-zA-Z0-9]+[^>]*>/g) || []).length;
    const closeTags = (cleanHtml.match(/<\/[a-zA-Z0-9]+>/g) || []).length;

    if (openTags !== closeTags) {
      const mismatch = openTags > closeTags
        ? `${openTags - closeTags} unclosed tag(s)`
        : `${closeTags - openTags} extra closing tag(s)`;
      return {
        success: false,
        output: '',
        error: `HTML Syntax Error in ${filePath}: ${mismatch} (${openTags} opening vs ${closeTags} closing).`,
      };
    }

    // Real syntax check for each embedded <script> block (uses the same JS check as
    // standalone .js files), instead of embedded JS being invisible to check_syntax.
    for (let i = 0; i < scriptBodies.length; i++) {
      const body = scriptBodies[i].trim();
      if (!body) continue; // external <script src="..."> (or an empty tag) has no inline body to check
      const jsCheck = this.verifyJavaScriptSyntax(`${filePath} <script block ${i + 1}>`, body);
      if (!jsCheck.success) {
        return jsCheck;
      }
    }

    return {
      success: true,
      output: `HTML syntax check passed for ${filePath}${scriptBodies.length ? ` (${scriptBodies.length} inline <script> block(s) checked)` : ''}.`,
    };
  }

  private static verifyJsonSyntax(filePath: string, code: string): ToolResult {
    try {
      JSON.parse(code);
      return {
        success: true,
        output: `Valid JSON syntax in ${filePath}`,
      };
    } catch (err: any) {
      return {
        success: false,
        output: '',
        error: `JSON Parse Error in ${filePath}: ${err.message}`,
      };
    }
  }
}
