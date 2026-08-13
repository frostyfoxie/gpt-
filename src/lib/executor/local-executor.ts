import { getActiveProjectId } from '../../engine/active-project';

/**
 * Browser-local side of the executor abstraction. Browser security intentionally prevents
 * Theta from silently spawning arbitrary OS processes. Safe, tiny operations stay local;
 * anything requiring a real process is routed to CodeSandbox by CodeRunnerTools.
 */
export class LocalExecutor {
  static canRun(command: string): boolean {
    return /^(echo|printf|pwd|whoami|date)\b/i.test(command.trim());
  }

  static async run(command: string): Promise<{ success: boolean; stdout: string; stderr: string; exitCode: number }> {
    if (!getActiveProjectId()) return { success: false, stdout: '', stderr: 'No active project.', exitCode: 1 };
    const trimmed = command.trim();
    if (/^pwd$/i.test(trimmed)) return { success: true, stdout: '/workspace\n', stderr: '', exitCode: 0 };
    if (/^whoami$/i.test(trimmed)) return { success: true, stdout: 'theta-local\n', stderr: '', exitCode: 0 };
    if (/^date$/i.test(trimmed)) return { success: true, stdout: `${new Date().toString()}\n`, stderr: '', exitCode: 0 };
    const match = trimmed.match(/^(?:echo|printf)\s+([\s\S]*)$/i);
    if (match) {
      let value = match[1].trim().replace(/^(['"])(.*)\1$/, '$2').replace(/\\n/g, '\n');
      return { success: true, stdout: value + (trimmed.startsWith('echo') ? '\n' : ''), stderr: '', exitCode: 0 };
    }
    return { success: false, stdout: '', stderr: 'Command requires the real execution environment.', exitCode: 127 };
  }
}
