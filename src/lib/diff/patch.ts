/**
 * Small, dependency-free search/replace patch utility, in the same spirit as the diff
 * format Cline uses for targeted edits: the model returns one or more exact
 * "find this snippet, replace it with this snippet" blocks instead of the entire file
 * body. This is intentionally NOT a unified-diff / line-number-based format — line
 * numbers drift the moment a model miscounts, whereas an exact text match either
 * applies cleanly or fails loudly, which is what we want from an unattended agent loop.
 *
 * Block format (one or more, concatenated in file order):
 *
 * <<<<<<< SEARCH
 * [exact existing lines, copied verbatim from the current file content]
 * =======
 * [replacement lines]
 * >>>>>>> REPLACE
 */

/** A single parsed search/replace instruction. */
export interface SearchReplaceBlock {
  /** Exact text to find in the current file content. */
  search: string;
  /** Text to replace it with. */
  replace: string;
}

export interface ParsePatchResult {
  success: boolean;
  blocks: SearchReplaceBlock[];
  error?: string;
}

export interface ApplyPatchResult {
  success: boolean;
  /** The full, patched file content (only set when success is true). */
  content?: string;
  /** Human-readable error, suitable for feeding back to the model as `lastObservation`. */
  error?: string;
  /** How many blocks were applied before either finishing or hitting a failure. */
  appliedCount: number;
}

const SEARCH_MARKER = '<<<<<<< SEARCH';
const DIVIDER_MARKER = '=======';
const REPLACE_MARKER = '>>>>>>> REPLACE';

/** The exact format instructions handed to the model when it's asked for a patch instead of a full rewrite. */
export const SEARCH_REPLACE_FORMAT_INSTRUCTIONS = `Respond with one or more search/replace blocks in EXACTLY this format (you may include several blocks, one per change):
${SEARCH_MARKER}
[the exact existing lines to find, copied verbatim from the current file content above — including original whitespace/indentation]
${DIVIDER_MARKER}
[the new lines to replace them with]
${REPLACE_MARKER}

Rules:
- Each SEARCH block must match the current file content EXACTLY (same whitespace, same line breaks) — copy it rather than retyping it from memory.
- Keep each SEARCH block as SHORT as possible while still being unique in the file — just the lines that actually need to change, plus a line or two of surrounding context if needed for uniqueness. Do not include unrelated unchanged code.
- Do not include line numbers or any text outside the markers.
- Do not use this format for brand-new files.`;

/**
 * Parses one or more `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` blocks out of raw
 * model output. Tolerant of surrounding commentary/whitespace, but strict about the
 * markers themselves and their ordering.
 */
export function parseSearchReplaceBlocks(patchText: string): ParsePatchResult {
  const text = (patchText || '').replace(/\r\n/g, '\n');

  if (!text.includes(SEARCH_MARKER)) {
    return {
      success: false,
      blocks: [],
      error: `No "${SEARCH_MARKER}" block found in the model's response. Expected one or more search/replace blocks.`,
    };
  }

  const blocks: SearchReplaceBlock[] = [];
  // Split on the SEARCH marker so malformed/missing dividers in one block don't corrupt
  // parsing of the others; each chunk after the first should contain exactly one
  // "search\n=======\nreplace\n>>>>>>> REPLACE" sequence.
  const chunks = text.split(SEARCH_MARKER).slice(1);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    const dividerIndex = chunk.indexOf(DIVIDER_MARKER);
    if (dividerIndex === -1) {
      return {
        success: false,
        blocks: [],
        error: `Block ${i + 1} is missing its "${DIVIDER_MARKER}" divider between the search and replace text.`,
      };
    }

    const replaceMarkerIndex = chunk.indexOf(REPLACE_MARKER, dividerIndex);
    if (replaceMarkerIndex === -1) {
      return {
        success: false,
        blocks: [],
        error: `Block ${i + 1} is missing its closing "${REPLACE_MARKER}" marker.`,
      };
    }

    let search = chunk.slice(0, dividerIndex);
    let replace = chunk.slice(dividerIndex + DIVIDER_MARKER.length, replaceMarkerIndex);

    // Trim exactly one leading/trailing newline introduced by the markers themselves,
    // without touching intentional blank lines inside the snippet.
    search = trimOneEdgeNewline(search);
    replace = trimOneEdgeNewline(replace);

    if (!search) {
      return {
        success: false,
        blocks: [],
        error: `Block ${i + 1} has an empty SEARCH section — every search block must contain the exact existing text to find.`,
      };
    }

    blocks.push({ search, replace });
  }

  if (blocks.length === 0) {
    return {
      success: false,
      blocks: [],
      error: 'No valid search/replace blocks could be parsed from the model response.',
    };
  }

  return { success: true, blocks };
}

/**
 * Applies parsed search/replace blocks to `original` content, in order, each against
 * the result of the previous block (so a later block may target text introduced by an
 * earlier one). Fails on the first block whose search text can't be found verbatim,
 * returning a precise, model-actionable error rather than silently skipping it.
 */
export function applySearchReplaceBlocks(original: string, blocks: SearchReplaceBlock[]): ApplyPatchResult {
  let working = original;
  let appliedCount = 0;

  for (let i = 0; i < blocks.length; i++) {
    const { search, replace } = blocks[i];
    const index = working.indexOf(search);

    if (index === -1) {
      return {
        success: false,
        appliedCount,
        error:
          `Search block ${i + 1} of ${blocks.length} did not match the current file content exactly ` +
          `(no exact occurrence found). The SEARCH text must be copied verbatim from the file, ` +
          `including whitespace and indentation — do not retype or paraphrase it.\n` +
          `Search block that failed:\n"""\n${truncateForObservation(search)}\n"""`,
      };
    }

    const occurrences = countOccurrences(working, search);
    if (occurrences > 1) {
      // Not fatal — Cline-style tools generally apply to the first match — but the model
      // should know its block wasn't unique, in case it targeted the wrong spot.
      // We still proceed with the first occurrence.
    }

    working = working.slice(0, index) + replace + working.slice(index + search.length);
    appliedCount++;
  }

  return { success: true, content: working, appliedCount };
}

/** Convenience: parse + apply in one call. */
export function applySearchReplacePatch(original: string, patchText: string): ApplyPatchResult {
  const parsed = parseSearchReplaceBlocks(patchText);
  if (!parsed.success) {
    return { success: false, appliedCount: 0, error: parsed.error };
  }
  return applySearchReplaceBlocks(original, parsed.blocks);
}

function trimOneEdgeNewline(text: string): string {
  let result = text;
  if (result.startsWith('\n')) result = result.slice(1);
  if (result.endsWith('\n')) result = result.slice(0, -1);
  return result;
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

/** Keeps failed-search-block feedback (fed back into the prompt) from blowing up prompt size. */
function truncateForObservation(text: string, maxChars = 400): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '\n... [truncated]';
}
