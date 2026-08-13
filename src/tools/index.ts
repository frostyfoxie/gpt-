import { FileSystemTools, ToolResult } from './file-system-tools';
import { CodeRunnerTools } from './code-runner-tools';
import { WebResearchTools } from './web-research-tools';
import { getActiveProjectId } from '../engine/active-project';
import { formatExternalWebContent } from '../lib/untrusted-content';
import { acquireFileLock, releaseFileLock, isFileLocked } from '../engine/state-lock';

export interface AgentToolRequest {
  toolName: 'write_file' | 'read_file' | 'check_syntax' | 'acquire_lock' | 'release_lock' | 'grep' | 'glob' | 'research_web';
  /** Required for write_file/read_file/check_syntax/acquire_lock/release_lock; unused for grep/glob. */
  filePath?: string;
  content?: string;
  agentId: string;
  stepId: number;
  /** grep: the regex pattern to search file contents for. glob: the glob pattern to match paths against. */
  pattern?: string;
  /** grep only: optional glob restricting which paths are searched. */
  pathGlob?: string;
  /** grep only: cap on returned matches (default 50, see FileSystemTools.grepFiles). */
  maxResults?: number;
}

export class ToolDispatcher {
  /**
   * Routes incoming tool requests from ReAct loops to the matching service
   */
  public static async dispatch(request: AgentToolRequest): Promise<ToolResult> {
    switch (request.toolName) {
      case 'read_file':
        return await FileSystemTools.readFile(request.filePath || '');

      case 'write_file': {
        if (request.content === undefined) {
          return {
            success: false,
            output: '',
            error: `Cannot write to ${request.filePath}: content payload is undefined.`,
          };
        }

        // Verify that another agent does NOT hold an active lock before allowing writes
        const lockedByOther = await isFileLocked(request.filePath || '', request.agentId);
        if (lockedByOther) {
          return {
            success: false,
            output: '',
            error: `Write rejected: File ${request.filePath} is currently locked by another agent.`,
          };
        }

        return await FileSystemTools.writeFile(
          request.filePath || '',
          request.content,
          request.agentId,
          request.stepId
        );
      }

      case 'check_syntax': {
        let contentToCheck = request.content;
        if (contentToCheck === undefined) {
          const fileRead = await FileSystemTools.readFile(request.filePath || '');
          if (!fileRead.success) return fileRead;
          contentToCheck = fileRead.output;
        }
        return await CodeRunnerTools.checkSyntax(request.filePath || '', contentToCheck);
      }

      case 'acquire_lock': {
        const locked = await acquireFileLock(request.agentId, request.filePath || '');
        return {
          success: locked,
          output: locked ? `Lock acquired for ${request.filePath}` : `Failed to acquire lock for ${request.filePath}`,
          error: locked ? undefined : `File ${request.filePath} is currently locked by another agent.`,
        };
      }

      case 'release_lock': {
        await releaseFileLock(request.agentId, request.filePath || '');
        return {
          success: true,
          output: `Lock released for ${request.filePath}`,
        };
      }

      case 'grep': {
        const result = FileSystemTools.grepFiles(request.pattern || '', {
          pathGlob: request.pathGlob,
          maxResults: request.maxResults,
        });

        if (!result.success) {
          return { success: false, output: '', error: result.error || 'grep failed.' };
        }
        if (result.matches.length === 0) {
          return { success: true, output: '(no matches found)' };
        }

        const formatted = result.matches.map((m) => `${m.path}:${m.line}: ${m.snippet}`).join('\n');
        return {
          success: true,
          output: result.truncated
            ? `${formatted}\n... [truncated at ${result.matches.length} matches — narrow your pattern or add a pathGlob for more]`
            : formatted,
        };
      }

      case 'glob': {
        return FileSystemTools.globFiles(request.pattern || '');
      }

      case 'research_web': {
        const rawQuery = request.pattern || '';
        const lowered = rawQuery.toLowerCase();
        const mode = lowered.startsWith('tech:')
          ? 'current-tech'
          : lowered.startsWith('ui:')
            ? 'ui-ux'
            : 'deep';
        const query = rawQuery.replace(/^(tech|ui|deep):\s*/i, '');
        const result = await WebResearchTools.research({
          query,
          mode,
          projectId: getActiveProjectId() ?? undefined,
        });
        return result.ok
          ? { success: true, output: formatExternalWebContent(result.sources.map((s) => s.uri).join(', ') || 'grounded web research', JSON.stringify({
              query: result.query,
              mode: result.mode,
              observedAt: result.observedAt,
              sources: result.sources,
              summary: result.summary,
              technicalUpdates: result.technicalUpdates,
              designPatterns: result.designPatterns,
              palette: result.palette,
            }, null, 2)) }
          : { success: false, output: '', error: result.error || 'Web research failed.' };
      }

      default:
        return {
          success: false,
          output: '',
          error: `Unknown tool requested: ${(request as any).toolName}`,
        };
    }
  }
}
