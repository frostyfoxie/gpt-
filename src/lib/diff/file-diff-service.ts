import { diffLines, type DiffLine } from './line-diff';
import { flattenFiles } from './tree-diff';
import { CheckpointEngine } from '../git/checkpoint';
import { CommitManager } from '../../engine/commits';

/**
 * Phase 4 — file-by-file diff view in the UI.
 *
 * Deliberately lives outside src/lib/diff/index.ts (and isn't re-exported from it): it
 * imports CheckpointEngine and CommitManager, both of which already import *from*
 * src/lib/diff via that index barrel, so routing this module through the same barrel would
 * create an import cycle. src/index.ts imports this file directly instead, purely for its
 * window-attaching side effect (same pattern CommitManager itself uses).
 */

export interface FileDiffResult {
  path: string;
  status: 'added' | 'removed' | 'modified';
  lines: DiffLine[];
}

/** Diffs two reconstructed file trees, optionally restricted to a specific set of paths (e.g. just the files a blueprint step touched). Files with identical content in both trees are omitted. */
function buildFileDiffs(beforeTree: any, afterTree: any, restrictToPaths?: string[]): FileDiffResult[] {
  const beforeFiles = flattenFiles(beforeTree);
  const afterFiles = flattenFiles(afterTree);
  const allPaths = new Set<string>([...beforeFiles.keys(), ...afterFiles.keys()]);
  const allowed = restrictToPaths && restrictToPaths.length > 0 ? new Set(restrictToPaths) : null;

  const results: FileDiffResult[] = [];
  for (const path of allPaths) {
    if (allowed && !allowed.has(path)) continue;
    const before = beforeFiles.get(path);
    const after = afterFiles.get(path);

    if (before && after) {
      if (before.content === after.content) continue;
      results.push({ path, status: 'modified', lines: diffLines(before.content, after.content) });
    } else if (!before && after) {
      results.push({ path, status: 'added', lines: diffLines('', after.content) });
    } else if (before && !after) {
      results.push({ path, status: 'removed', lines: diffLines(before.content, '') });
    }
  }

  // Stable, readable ordering for the modal.
  results.sort((a, b) => a.path.localeCompare(b.path));
  return results;
}

export class FileDiffService {
  /**
   * Diff for a blueprint step, viewable while the step is still running or after it's
   * finished: "before" is the checkpoint snapshot taken right before the step started,
   * "after" is the live current project state. Restricted to that step's own target files
   * so an in-progress step only shows the files it's actually responsible for.
   */
  public static async getStepDiff(stepId: number, targetFiles: string[]): Promise<FileDiffResult[]> {
    const beforeTree = await CheckpointEngine.getStepBeforeTree(stepId);
    if (!beforeTree) return [];
    const afterTree = typeof window !== 'undefined' ? (window as any).rootProject || {} : {};
    return buildFileDiffs(beforeTree, afterTree, targetFiles);
  }

  /** Diff for a past commit: before = the tree as of the commit right before it, after = this commit's own tree. Shows every file that commit touched. */
  public static async getCommitDiff(commitId: string): Promise<FileDiffResult[]> {
    const trees = await CommitManager.getCommitDiffTrees(commitId);
    if (!trees) return [];
    return buildFileDiffs(trees.before, trees.after);
  }
}

if (typeof window !== 'undefined') {
  (window as any).FileDiffService = FileDiffService;
}
