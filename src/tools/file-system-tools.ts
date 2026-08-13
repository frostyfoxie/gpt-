import { supabase } from '../lib/supabase/vfs-sync';
import { recordFileRevision } from '../lib/supabase/logger';
import { getActiveProjectId } from '../engine/active-project';

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export interface GrepMatch {
  path: string;
  line: number;
  snippet: string;
}

export interface GrepResult {
  success: boolean;
  matches: GrepMatch[];
  /** True if results were cut off at maxResults — there may be more matches than shown. */
  truncated: boolean;
  error?: string;
}

export class FileSystemTools {
  /**
   * Tool: Reads the content of a file from the workspace.
   * Prefers the live in-memory rootProject tree (instant, always current — includes
   * edits that haven't finished round-tripping to Supabase yet) and falls back to the
   * Supabase file_history table (useful outside the browser / for cross-session reads).
   */
  public static async readFile(filePath: string): Promise<ToolResult> {
    if (typeof window !== 'undefined') {
      const root = (window as any).rootProject;
      if (root) {
        const node = FileSystemTools.findNodeByPath(root, filePath);
        if (node && node.type === 'file') {
          return { success: true, output: node.content || '' };
        }
      }
    }

    const projectId = getActiveProjectId();
    if (!projectId) return { success: false, output: '', error: 'No active project is selected.' };
    const { data, error } = await supabase
      .from('file_history')
      .select('content')
      .eq('project_id', projectId)
      .eq('file_path', filePath)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      return {
        success: false,
        output: '',
        error: `Failed to read file ${filePath}: ${error.message}`,
      };
    }

    if (!data) {
      return {
        success: false,
        output: '',
        error: `File not found: ${filePath}`,
      };
    }

    return {
      success: true,
      output: data.content,
    };
  }

  /**
   * Lists every file path currently in the workspace tree (used to give agents full
   * project awareness before they write anything).
   */
  public static listAllFiles(): string[] {
    if (typeof window === 'undefined') return [];
    const root = (window as any).rootProject;
    if (!root) return [];
    const paths: string[] = [];
    const walk = (node: any, prefix: string) => {
      if (node.type === 'file') {
        paths.push(prefix ? `${prefix}/${node.name}` : node.name);
        return;
      }
      const nextPrefix = node.id === root.id ? '' : (prefix ? `${prefix}/${node.name}` : node.name);
      (node.children || []).forEach((child: any) => walk(child, nextPrefix));
    };
    walk(root, '');
    return paths;
  }

  /**
   * Lists every file path currently in the workspace tree ALONG WITH its content — used
   * by whole-project checks (integration/reference validation, final QA review) that need
   * to reason about more than just the file listing.
   */
  public static listAllFilesWithContent(): { path: string; content: string }[] {
    if (typeof window === 'undefined') return [];
    const root = (window as any).rootProject;
    if (!root) return [];
    const files: { path: string; content: string }[] = [];
    const walk = (node: any, prefix: string) => {
      if (node.type === 'file') {
        files.push({ path: prefix ? `${prefix}/${node.name}` : node.name, content: node.content || '' });
        return;
      }
      const nextPrefix = node.id === root.id ? '' : (prefix ? `${prefix}/${node.name}` : node.name);
      (node.children || []).forEach((child: any) => walk(child, nextPrefix));
    };
    walk(root, '');
    return files;
  }

  /** Hard cap on how many referenced files get pulled into a dev agent prompt (keeps large/hub files, e.g. a shared `types.ts` imported everywhere, from blowing up context). Per-file content truncation is the prompt-builder's job (see react-loop.ts), since only it knows the actual prompt budget. */
  private static readonly MAX_REFERENCED_FILES = 12;
  /** Bare (non-relative) specifiers shorter than this are too noisy to string-match reliably (e.g. "fs", "os"). */
  private static readonly MIN_BASENAME_MATCH_LENGTH = 4;

  /**
   * Figures out which OTHER project files a given file actually depends on, so an agent's
   * prompt can include their real content up front instead of either (a) nothing, which
   * leaves it guessing at APIs/types it references, or (b) the whole project's content,
   * which doesn't scale past a small project. Two passes:
   *   1. Parse import/require/include-style statements (ESM `import ... from`, dynamic
   *      `import(...)`, CJS `require(...)`, CSS `@import`, HTML `src=`/`href=`, Python
   *      `import x` / `from x import y`) and resolve each specifier against the real file list.
   *   2. Fallback "simple string reference" pass: any other project file's bare filename that
   *      literally appears in the content (catches things statement-parsing misses — a path
   *      built dynamically, a config key naming another file, etc).
   * Resolution is against `allPaths` only (real files currently in the project) — anything
   * that doesn't resolve to an actual project file (npm packages, stdlib modules, external
   * URLs) is silently skipped rather than guessed at.
   *
   * This is deliberately BEST-EFFORT, not exhaustive: it only sees direct references from
   * ONE file's own content, so it will miss anything indirect — other files that reference
   * the target rather than the other way around, files connected only through shared naming
   * conventions, config-driven wiring, or a dynamically-built path it can't statically parse.
   * It's cheap and correct enough to be a free starting point injected into every dev-agent
   * prompt without costing a tool-loop turn, but it is NOT a substitute for search — see
   * grepFiles()/globFiles() below, which the tool loop (react-loop.ts) exposes as `grep`/
   * `glob` tools for exactly the cases this function can't catch (e.g. finding every file
   * that renders a given component's prop, where none of those files import each other).
   */
  public static resolveReferencedFiles(targetFile: string, content: string, allPaths: string[]): string[] {
    if (!content || allPaths.length === 0) return [];

    const targetDir = targetFile.includes('/') ? targetFile.slice(0, targetFile.lastIndexOf('/')) : '';
    const pathSet = new Set(allPaths);
    const found: string[] = [];
    const seen = new Set<string>([targetFile]);

    const tryAdd = (path: string) => {
      if (!seen.has(path) && pathSet.has(path)) {
        seen.add(path);
        found.push(path);
      }
    };

    // Extension/index candidates tried when a specifier omits its extension (the overwhelming
    // common case for JS/TS imports).
    const CANDIDATE_SUFFIXES = [
      '', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.css', '.json', '.md',
      '/index.ts', '/index.tsx', '/index.js', '/index.jsx',
    ];

    const resolveSpecifier = (raw: string) => {
      const spec = raw.trim();
      if (!spec || /^https?:\/\//i.test(spec)) return;

      if (spec.startsWith('.') || spec.startsWith('/')) {
        // Relative (or root-relative) path — resolve against the target file's own directory.
        const base = spec.startsWith('/') ? '' : targetDir;
        const joined = FileSystemTools.normalizeJoin(base, spec);
        for (const suffix of CANDIDATE_SUFFIXES) {
          tryAdd(joined + suffix);
        }
        return;
      }

      // Bare specifier (e.g. "react", "@/lib/utils", python dotted module). Only match it if
      // it happens to correspond to a real project file — this is what keeps node_modules /
      // stdlib names from being treated as project references.
      const dotted = spec.replace(/\./g, '/'); // python "a.b.c" -> "a/b/c"
      for (const candidate of [spec, dotted]) {
        for (const suffix of CANDIDATE_SUFFIXES) {
          tryAdd(candidate + suffix);
        }
        // Alias-style specifiers ("@/components/Button") — try matching on the tail only.
        const tail = candidate.split('/').filter(Boolean).slice(-2).join('/');
        if (tail && tail !== candidate) {
          for (const suffix of CANDIDATE_SUFFIXES) {
            tryAdd(tail + suffix);
          }
        }
      }
    };

    const IMPORT_PATTERNS: RegExp[] = [
      /import\s+(?:[\s\S]*?\bfrom\s+)?['"]([^'"]+)['"]/g, // ESM: import x from '...'; import '...';
      /import\(\s*['"]([^'"]+)['"]\s*\)/g,                // dynamic import('...')
      /require\(\s*['"]([^'"]+)['"]\s*\)/g,               // CJS require('...')
      /@import\s+(?:url\()?['"]?([^'")\s;]+)['"]?\)?/g,   // CSS @import
      /(?:src|href)\s*=\s*['"]([^'"]+)['"]/g,             // HTML <script src>, <link href>
      /^\s*from\s+([\w.]+)\s+import\b/gm,                 // Python: from x.y import z
      /^\s*import\s+([\w.]+)/gm,                          // Python: import x.y
    ];

    for (const pattern of IMPORT_PATTERNS) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null && found.length < FileSystemTools.MAX_REFERENCED_FILES) {
        resolveSpecifier(match[1]);
      }
      if (found.length >= FileSystemTools.MAX_REFERENCED_FILES) break;
    }

    // Fallback pass: simple string references to other files' bare names anywhere in the content.
    if (found.length < FileSystemTools.MAX_REFERENCED_FILES) {
      for (const path of allPaths) {
        if (found.length >= FileSystemTools.MAX_REFERENCED_FILES) break;
        if (path === targetFile || seen.has(path)) continue;
        const baseName = path.split('/').pop() || '';
        if (baseName.length < FileSystemTools.MIN_BASENAME_MATCH_LENGTH) continue;
        if (content.includes(baseName)) {
          tryAdd(path);
        }
      }
    }

    return found.slice(0, FileSystemTools.MAX_REFERENCED_FILES);
  }

  /** Joins a relative specifier onto a base directory, resolving `.` and `..` segments (no `path` module dependency — this runs in-browser). */
  private static normalizeJoin(baseDir: string, relative: string): string {
    const segments = `${baseDir}/${relative}`.split('/').filter((s) => s.length > 0 && s !== '.');
    const stack: string[] = [];
    for (const seg of segments) {
      if (seg === '..') stack.pop();
      else stack.push(seg);
    }
    return stack.join('/');
  }

  /** Default cap on returned grep matches — keeps a broad/common pattern from blowing up the prompt. */
  private static readonly DEFAULT_GREP_MAX_RESULTS = 50;
  /** Wall-clock budget for one grepFiles() call, checked between lines/files. */
  private static readonly GREP_TIME_BUDGET_MS = 200;
  /**
   * Lines longer than this are skipped for matching (still counted for line numbers). This
   * bounds the cost of a single `regex.test()` call against pathological input (e.g. a
   * minified bundle line, or a model-supplied pattern with catastrophic backtracking
   * potential) — the wall-clock check below can only act BETWEEN calls, not interrupt one
   * already in flight, so keeping any single call cheap is the actual safety measure.
   */
  private static readonly GREP_MAX_LINE_LENGTH = 2000;
  private static readonly GREP_SNIPPET_MAX_CHARS = 300;

  /**
   * Tool: searches file CONTENTS across the whole in-memory project tree for a regex
   * pattern — the counterpart to resolveReferencedFiles()'s best-effort static parsing.
   * Exposed to dev agents as the `grep` tool (see react-loop.ts) for anything the
   * auto-injected referenced-files context doesn't catch: finding every file that renders a
   * given prop, every call site of a function, every string reference to a config key, etc.,
   * regardless of whether those files import the one being edited.
   *
   * Operates entirely on the same in-memory listAllFilesWithContent() data listAllFiles()
   * reads from — no per-file network reads — so it stays fast even on a 100+ file project.
   * Invalid regex input is caught and reported as a clean error rather than throwing.
   */
  public static grepFiles(
    pattern: string,
    options?: { pathGlob?: string; maxResults?: number }
  ): GrepResult {
    if (!pattern || !pattern.trim()) {
      return { success: false, matches: [], truncated: false, error: 'grep requires a non-empty pattern.' };
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (err: any) {
      return {
        success: false,
        matches: [],
        truncated: false,
        error: `Invalid regex pattern "${pattern}": ${err?.message || err}`,
      };
    }

    let pathFilter: RegExp | null = null;
    if (options?.pathGlob) {
      try {
        pathFilter = FileSystemTools.globToRegExp(options.pathGlob);
      } catch (err: any) {
        return {
          success: false,
          matches: [],
          truncated: false,
          error: `Invalid pathGlob "${options.pathGlob}": ${err?.message || err}`,
        };
      }
    }

    const maxResults =
      options?.maxResults && options.maxResults > 0
        ? options.maxResults
        : FileSystemTools.DEFAULT_GREP_MAX_RESULTS;

    const files = FileSystemTools.listAllFilesWithContent();
    const matches: GrepMatch[] = [];
    const deadline = Date.now() + FileSystemTools.GREP_TIME_BUDGET_MS;
    let truncated = false;

    outer: for (const file of files) {
      if (pathFilter && !pathFilter.test(file.path)) continue;

      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (Date.now() > deadline) {
          truncated = true;
          break outer;
        }

        const line = lines[i];
        if (line.length > FileSystemTools.GREP_MAX_LINE_LENGTH) continue;

        let isMatch: boolean;
        try {
          isMatch = regex.test(line);
        } catch {
          // Should be unreachable (the pattern already compiled above), but a search that
          // somehow throws mid-scan shouldn't take the whole tool loop down with it.
          isMatch = false;
        }

        if (isMatch) {
          matches.push({ path: file.path, line: i + 1, snippet: FileSystemTools.truncateSnippet(line) });
          if (matches.length >= maxResults) {
            truncated = true;
            break outer;
          }
        }
      }
    }

    return { success: true, matches, truncated };
  }

  /**
   * Tool: matches project file PATHS against a simple glob (`*` within a path segment, `**`
   * across segments, `?` for a single character) — exposed as the `glob` tool. Operates over
   * listAllFiles(), so it reflects files written earlier in the same tool loop.
   */
  public static globFiles(pattern: string): ToolResult {
    if (!pattern || !pattern.trim()) {
      return { success: false, output: '', error: 'glob requires a non-empty pattern.' };
    }

    let regex: RegExp;
    try {
      regex = FileSystemTools.globToRegExp(pattern);
    } catch (err: any) {
      return { success: false, output: '', error: `Invalid glob pattern "${pattern}": ${err?.message || err}` };
    }

    const matches = FileSystemTools.listAllFiles().filter((path) => regex.test(path));
    return { success: true, output: matches.length > 0 ? matches.join('\n') : '(no files matched)' };
  }

  /** Truncates a matched line for inclusion in a grep result, so one huge line can't blow up the observation. */
  private static truncateSnippet(line: string): string {
    const trimmed = line.trim();
    if (trimmed.length <= FileSystemTools.GREP_SNIPPET_MAX_CHARS) return trimmed;
    return trimmed.slice(0, FileSystemTools.GREP_SNIPPET_MAX_CHARS) + '... [truncated]';
  }

  /**
   * Translates a simple glob into a RegExp matching a full path: `*` matches within one path
   * segment (no `/`), `**` matches across segments (including `/`, and an empty match), `?`
   * matches exactly one non-`/` character. Everything else is treated as a literal and
   * escaped. Anchored to match the whole path (`^...$`).
   */
  private static globToRegExp(glob: string): RegExp {
    const SPECIAL = /[.+^${}()|[\]\\]/;
    let out = '';
    for (let i = 0; i < glob.length; i++) {
      const c = glob[i];
      if (c === '*') {
        if (glob[i + 1] === '*') {
          out += '.*';
          i++; // consume the second '*'
          if (glob[i + 1] === '/') i++; // "**/foo" also matches "foo" at the root
        } else {
          out += '[^/]*';
        }
      } else if (c === '?') {
        out += '[^/]';
      } else {
        out += SPECIAL.test(c) ? `\\${c}` : c;
      }
    }
    return new RegExp(`^${out}$`);
  }

  /**
   * Tool: Writes or overwrites code in a file and records revision history.
   * Creates any missing folders along the path automatically.
   */
  public static async writeFile(
    filePath: string,
    content: string,
    agentId: string,
    stepId: number
  ): Promise<ToolResult> {
    try {
      // 1. Update local in-memory rootProject tree immediately so the editor/UI reflects
      //    the change without waiting on the network.
      if (typeof window !== 'undefined') {
        this.updateInMemoryTree(filePath, content);
      }

      // 2. Commit new file revision to Supabase (best-effort; failures here shouldn't
      //    block the agent's work since the in-memory tree already has the change).
      try {
        await recordFileRevision(filePath, content, agentId, stepId);
      } catch (persistErr) {
        console.warn(`[FileSystemTools] Supabase revision write failed for ${filePath}:`, persistErr);
      }

      return {
        success: true,
        output: `Successfully wrote ${content.length} bytes to ${filePath}`,
      };
    } catch (err: any) {
      return {
        success: false,
        output: '',
        error: `Failed to write file ${filePath}: ${err.message}`,
      };
    }
  }

  /**
   * Helper: Infers editor syntax language from file extension
   */
  public static getLanguageFromPath(filePath: string): string {
    const ext = filePath.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'html': return 'HTML5';
      case 'css': return 'CSS';
      case 'js':
      case 'jsx': return 'JavaScript';
      case 'ts':
      case 'tsx': return 'TypeScript';
      case 'json': return 'JSON';
      case 'md': return 'Markdown';
      default: return 'PlainText';
    }
  }

  /**
   * Finds a file/folder node by its full slash-delimited path (e.g. "src/App.jsx"),
   * resolving through nested folders by name.
   */
  public static findNodeByPath(root: any, filePath: string): any | null {
    const normalized = filePath.replace(/^\/+/, '').replace(/^\.\//, '');
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0) return null;

    // Also allow agents to pass just a bare filename (no folder) — search anywhere in the tree.
    if (segments.length === 1) {
      const direct = FileSystemTools.findByNameAnywhere(root, segments[0]);
      if (direct) return direct;
    }

    let current = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      if (!current.children) return null;
      const match = current.children.find((c: any) => c.name === seg);
      if (!match) {
        // Fall back to a name-anywhere search for the final segment (handles agents
        // giving paths that don't quite match the tree's actual folder structure).
        if (isLast) return FileSystemTools.findByNameAnywhere(root, seg);
        return null;
      }
      current = match;
      if (isLast) return current;
    }
    return null;
  }

  private static findByNameAnywhere(node: any, name: string): any | null {
    if (node.name === name) return node;
    if (node.children) {
      for (const child of node.children) {
        const found = FileSystemTools.findByNameAnywhere(child, name);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Helper: Updates the in-memory window.rootProject object to keep the code editor and
   * file tree in sync, creating any missing intermediate folders along the given path.
   */
  private static updateInMemoryTree(filePath: string, content: string) {
    if (typeof window === 'undefined') return;
    const root = (window as any).rootProject;
    if (!root) return;

    const normalized = filePath.replace(/^\/+/, '').replace(/^\.\//, '');
    const segments = normalized.split('/').filter(Boolean);
    if (segments.length === 0) return;

    // If an existing node already matches this path (or just the bare filename anywhere
    // in the tree), update it in place rather than creating a duplicate.
    const existing = FileSystemTools.findNodeByPath(root, filePath);
    if (existing && existing.type === 'file') {
      existing.content = content;
      existing.language = FileSystemTools.getLanguageFromPath(existing.name);
    } else {
      // Walk/create folders for every segment except the last (the file itself).
      let current = root;
      for (let i = 0; i < segments.length - 1; i++) {
        const seg = segments[i];
        if (!current.children) current.children = [];
        let folder = current.children.find((c: any) => c.type === 'folder' && c.name === seg);
        if (!folder) {
          folder = {
            id: 'node_' + Math.random().toString(36).substring(2, 9),
            name: seg,
            type: 'folder',
            expanded: true,
            children: [],
          };
          current.children.push(folder);
        }
        current = folder;
      }

      const fileName = segments[segments.length - 1];
      if (!current.children) current.children = [];
      current.children.push({
        id: 'node_' + Math.random().toString(36).substring(2, 9),
        name: fileName,
        type: 'file',
        language: FileSystemTools.getLanguageFromPath(fileName),
        content,
      });
    }

    // Trigger existing DOM renderer from template
    if (typeof (window as any).renderFileTree === 'function') {
      (window as any).renderFileTree();
    }
    // Keep the open editor tab in sync if the currently-open file was the one just written.
    if (typeof (window as any).refreshActiveFileIfMatches === 'function') {
      (window as any).refreshActiveFileIfMatches(filePath);
    }
    // Debounced autosave to Supabase (see vfs-sync.ts / index.html wiring).
    if (typeof (window as any).scheduleWorkspaceAutosave === 'function') {
      (window as any).scheduleWorkspaceAutosave();
    }
  }
}
