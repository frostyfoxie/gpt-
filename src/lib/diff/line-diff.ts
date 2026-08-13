/**
 * Line-level diff for DISPLAY purposes (Phase 4 — file-by-file diff view in the UI).
 *
 * This is deliberately separate from generateDiffBlocks() in tree-diff.ts: that function
 * computes the smallest unambiguous SEARCH/REPLACE region needed to losslessly *replay* an
 * edit, and collapses everything between the first and last changed line into one opaque
 * "replace this whole region" block — great for storage/replay, bad for a human trying to
 * see what actually changed. diffLines() instead walks an LCS (longest common subsequence)
 * of the two files' lines and reports every line as unchanged/added/removed, the same shape
 * classic line-diff tools (git diff, Myers diff) produce.
 */

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  text: string;
}

/**
 * Computes a line-level diff between `oldText` and `newText`.
 *
 * Uses the standard O(n*m) LCS dynamic-programming table, which is plenty fast for source
 * files but would be too slow (and too much memory) for huge generated/minified files, so
 * anything past `maxLcsLines` on either side falls back to a coarse "remove everything old,
 * add everything new" diff rather than hanging the tab.
 */
export function diffLines(oldText: string, newText: string, maxLcsLines = 4000): DiffLine[] {
  if (oldText === newText) {
    return oldText.split('\n').map((text) => ({ type: 'context', text }));
  }

  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const n = oldLines.length;
  const m = newLines.length;

  if (n > maxLcsLines || m > maxLcsLines) {
    const lines: DiffLine[] = [];
    for (const text of oldLines) lines.push({ type: 'remove', text });
    for (const text of newLines) lines.push({ type: 'add', text });
    return lines;
  }

  // dp[i][j] = length of the LCS of oldLines[i:] and newLines[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: 'context', text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'remove', text: oldLines[i] });
      i++;
    } else {
      result.push({ type: 'add', text: newLines[j] });
      j++;
    }
  }
  while (i < n) {
    result.push({ type: 'remove', text: oldLines[i] });
    i++;
  }
  while (j < m) {
    result.push({ type: 'add', text: newLines[j] });
    j++;
  }
  return result;
}
