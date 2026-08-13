import { FileSystemTools } from '../../tools/file-system-tools';
import { applySearchReplaceBlocks, type SearchReplaceBlock } from './patch';

/**
 * Diff-based commit/checkpoint storage (Phase 3).
 *
 * Reuses the SearchReplaceBlock format + applySearchReplaceBlocks() from patch.ts — the
 * same mechanism already trusted to replay agent-authored file edits — as the on-disk
 * representation for a *file's* change between two commits. This module adds the piece
 * patch.ts intentionally doesn't have: a generator that computes those blocks between two
 * known strings (patch.ts only parses/applies blocks the model already wrote), plus a
 * tree-level diff/apply pair so a whole file-tree change can be stored as one small object
 * instead of a full copy.
 *
 * Diff generation follows the same rule patch.ts's own instructions give the model ("keep
 * the SEARCH block as short as possible while still being unique in the file") so that
 * applySearchReplaceBlocks()'s first-occurrence matching replays it unambiguously.
 */

export interface AddedFileEntry {
  path: string;
  content: string;
  language?: string;
}

export interface ModifiedFileEntry {
  path: string;
  blocks: SearchReplaceBlock[];
}

/** A structural diff between two file trees: everything needed to turn `old` into `new`. */
export interface TreeDiff {
  addedFiles: AddedFileEntry[];
  removedFiles: string[];
  modifiedFiles: ModifiedFileEntry[];
}

/** One row in a commit/checkpoint sequence, as needed to replay it forward. */
export interface DiffChainRow {
  seq: number;
  is_snapshot: boolean;
  snapshot_tree?: any;
  diff?: TreeDiff | null;
}

function emptyRoot(): any {
  return { id: 'root', name: 'project', type: 'folder', expanded: true, children: [] };
}

function normalizePath(filePath: string): string {
  return filePath.replace(/^\/+/, '').replace(/^\.\//, '');
}

/** Flattens a file tree into path -> {content, language}, matching FileSystemTools' path convention (the root node's own name is never part of the path). Exported (Phase 4) so file-diff-service.ts can pull full before/after file content straight out of two reconstructed trees for display, without duplicating tree-walking logic. */
export function flattenFiles(root: any): Map<string, { content: string; language?: string }> {
  const files = new Map<string, { content: string; language?: string }>();
  if (!root) return files;
  const walk = (node: any, prefix: string, isRoot: boolean) => {
    if (!node) return;
    if (node.type === 'file') {
      const path = prefix ? `${prefix}/${node.name}` : node.name;
      files.set(path, { content: node.content || '', language: node.language });
      return;
    }
    const nextPrefix = isRoot ? '' : prefix ? `${prefix}/${node.name}` : node.name;
    (node.children || []).forEach((child: any) => walk(child, nextPrefix, false));
  };
  walk(root, '', true);
  return files;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    if (count > 1) break; // we only need to distinguish "unique" from "not"
    pos = idx + needle.length;
  }
  return count;
}

/**
 * Computes the minimal-ish search/replace block turning `oldContent` into `newContent`, by
 * trimming the common leading/trailing lines and growing the region back out until the
 * SEARCH text is unique in `oldContent`. Empty array means the contents are identical.
 */
export function generateDiffBlocks(oldContent: string, newContent: string): SearchReplaceBlock[] {
  if (oldContent === newContent) return [];

  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const maxCommon = Math.min(oldLines.length, newLines.length);

  let prefixCount = 0;
  while (prefixCount < maxCommon && oldLines[prefixCount] === newLines[prefixCount]) {
    prefixCount++;
  }

  let suffixCount = 0;
  while (
    suffixCount < maxCommon - prefixCount &&
    oldLines[oldLines.length - 1 - suffixCount] === newLines[newLines.length - 1 - suffixCount]
  ) {
    suffixCount++;
  }

  // Grow the changed region back out (shrink the prefix/suffix trim) until the SEARCH text
  // is unambiguous in the old file. Guaranteed to terminate: at prefixCount=0, suffixCount=0
  // the search text is the entire old file, which trivially occurs exactly once.
  while (prefixCount > 0 || suffixCount > 0) {
    const search = oldLines.slice(prefixCount, oldLines.length - suffixCount).join('\n');
    if (search.length > 0 && countOccurrences(oldContent, search) === 1) break;
    if (prefixCount > 0) prefixCount--;
    else suffixCount--;
  }

  const search = oldLines.slice(prefixCount, oldLines.length - suffixCount).join('\n');
  const replace = newLines.slice(prefixCount, newLines.length - suffixCount).join('\n');

  return [{ search, replace }];
}

/** Computes the structural diff needed to turn `oldTree` into `newTree`. Renames are represented as a remove + an add (git does the same absent similarity detection) and empty folders aren't tracked (they're implied by the files under them, also matching git). */
export function computeTreeDiff(oldTree: any, newTree: any): TreeDiff {
  const oldFiles = flattenFiles(oldTree);
  const newFiles = flattenFiles(newTree);

  const addedFiles: AddedFileEntry[] = [];
  const removedFiles: string[] = [];
  const modifiedFiles: ModifiedFileEntry[] = [];

  for (const [path, newFile] of newFiles) {
    const oldFile = oldFiles.get(path);
    if (!oldFile) {
      addedFiles.push({ path, content: newFile.content, language: newFile.language });
    } else if (oldFile.content !== newFile.content) {
      modifiedFiles.push({ path, blocks: generateDiffBlocks(oldFile.content, newFile.content) });
    }
  }
  for (const path of oldFiles.keys()) {
    if (!newFiles.has(path)) removedFiles.push(path);
  }

  return { addedFiles, removedFiles, modifiedFiles };
}

function removeNodeByPath(root: any, filePath: string): void {
  const segments = normalizePath(filePath).split('/').filter(Boolean);
  if (segments.length === 0) return;
  let current = root;
  for (let i = 0; i < segments.length - 1; i++) {
    if (!current || !current.children) return;
    current = current.children.find((c: any) => c.name === segments[i]);
  }
  if (!current || !current.children) return;
  const idx = current.children.findIndex((c: any) => c.name === segments[segments.length - 1]);
  if (idx !== -1) current.children.splice(idx, 1);
}

/** Creates (or overwrites) a file at `filePath`, creating any missing intermediate folders — mirrors FileSystemTools' private updateInMemoryTree, just without the window/DOM side effects. */
function addFileAtPath(root: any, filePath: string, content: string, language?: string): void {
  const segments = normalizePath(filePath).split('/').filter(Boolean);
  if (segments.length === 0) return;

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
  const resolvedLanguage = language || FileSystemTools.getLanguageFromPath(fileName);
  const existingIdx = current.children.findIndex((c: any) => c.type === 'file' && c.name === fileName);
  if (existingIdx !== -1) {
    current.children[existingIdx] = { ...current.children[existingIdx], content, language: resolvedLanguage };
  } else {
    current.children.push({
      id: 'node_' + Math.random().toString(36).substring(2, 9),
      name: fileName,
      type: 'file',
      language: resolvedLanguage,
      content,
    });
  }
}

/** Applies a previously-computed TreeDiff to `baseTree`, returning the resulting tree. Throws if a modified/removed file can't be found — that means the diff chain is out of sync with what it's being replayed against. */
export function applyTreeDiff(baseTree: any, diff: TreeDiff): any {
  const tree = baseTree ? JSON.parse(JSON.stringify(baseTree)) : emptyRoot();

  for (const path of diff.removedFiles) {
    removeNodeByPath(tree, path);
  }

  for (const { path, blocks } of diff.modifiedFiles) {
    const node = FileSystemTools.findNodeByPath(tree, path);
    if (!node || node.type !== 'file') {
      throw new Error(`[tree-diff] Cannot replay diff: file not found at "${path}"`);
    }
    if (blocks.length === 0) continue;
    const result = applySearchReplaceBlocks(node.content || '', blocks);
    if (!result.success) {
      throw new Error(`[tree-diff] Failed to replay diff for "${path}": ${result.error}`);
    }
    node.content = result.content;
  }

  for (const { path, content, language } of diff.addedFiles) {
    addFileAtPath(tree, path, content, language);
  }

  return tree;
}

/**
 * Replays a sequence of commit/checkpoint rows forward into the resulting file tree.
 * `rows` must be sorted ascending by `seq` and start with an anchor (`is_snapshot: true`)
 * row — this is the shared reconstruction logic used by both CommitManager and
 * CheckpointEngine to turn "nearest anchor + diffs since" back into a real tree.
 */
export function reconstructTreeFromChain(rows: DiffChainRow[]): any {
  if (rows.length === 0) return emptyRoot();

  let tree = rows[0].snapshot_tree ? JSON.parse(JSON.stringify(rows[0].snapshot_tree)) : emptyRoot();

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.is_snapshot && row.snapshot_tree) {
      tree = JSON.parse(JSON.stringify(row.snapshot_tree));
    } else if (row.diff) {
      tree = applyTreeDiff(tree, row.diff);
    }
  }

  return tree;
}
